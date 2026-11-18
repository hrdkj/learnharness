"""Jupyter kernel bridge for the Coding questions notebook.

Runs under the user's configured Notebook Python. Speaks JSON lines:
stdin commands {op, id?, ...}; stdout events {type, ...}. One kernel per bridge.
"""

import json
import os
import queue
import shutil
import tempfile
import sys
import threading

try:
    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import KernelSpec
except Exception as error:  # noqa: BLE001 - reported to the plugin verbatim
    sys.stdout.write(json.dumps({"type": "fatal", "message": f"jupyter_client is not importable in {sys.executable}: {error}. Install ipykernel in this Python."}) + "\n")
    sys.stdout.flush()
    sys.exit(3)

write_lock = threading.Lock()


def send(event):
    line = json.dumps(event, default=str)
    with write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


class Bridge:
    def __init__(self, cwd):
        self.cwd = cwd
        self.km = None
        self.kc = None
        self.generation = 0
        self.work = queue.Queue()

    def start(self):
        # IPC sockets in a private directory instead of unencrypted localhost TCP.
        self.socket_dir = tempfile.mkdtemp(prefix="lh-kernel-")
        km = KernelManager(transport="ipc", ip=os.path.join(self.socket_dir, "kernel"))
        km._kernel_spec = KernelSpec(
            argv=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            display_name="Python", language="python", env={},
        )
        env = dict(os.environ)
        env.setdefault("MPLBACKEND", "module://matplotlib_inline.backend_inline")
        km.start_kernel(cwd=self.cwd, env=env)
        kc = km.client()
        kc.start_channels()
        kc.wait_for_ready(timeout=60)
        self.km, self.kc = km, kc
        send({"type": "status", "state": "idle"})

    def restart(self):
        self.generation += 1
        send({"type": "status", "state": "restarting"})
        try:
            self.kc.stop_channels()
        except Exception:  # noqa: BLE001
            pass
        self.km.restart_kernel(now=True)
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        send({"type": "status", "state": "idle"})

    def interrupt(self):
        if self.km is not None:
            self.km.interrupt_kernel()

    def shutdown(self):
        try:
            if self.kc is not None:
                self.kc.stop_channels()
            if self.km is not None:
                self.km.shutdown_kernel(now=True)
        finally:
            shutil.rmtree(getattr(self, "socket_dir", ""), ignore_errors=True)
            os._exit(0)

    @staticmethod
    def to_output(msg):
        kind = msg["header"]["msg_type"]
        content = msg["content"]
        if kind == "stream":
            return {"output_type": "stream", "name": content.get("name", "stdout"), "text": content.get("text", "")}
        if kind in ("execute_result", "display_data"):
            output = {"output_type": kind, "data": content.get("data", {}), "metadata": content.get("metadata", {})}
            if kind == "execute_result":
                output["execution_count"] = content.get("execution_count")
            return output
        if kind == "error":
            return {"output_type": "error", "ename": content.get("ename", ""), "evalue": content.get("evalue", ""), "traceback": content.get("traceback", [])}
        return None

    def execute(self, command):
        generation = self.generation
        request_id = command["id"]
        kc = self.kc
        msg_id = kc.execute(command["code"], store_history=True, allow_stdin=False, stop_on_error=True)
        send({"type": "status", "state": "busy"})
        status = "ok"
        while True:
            if generation != self.generation:
                send({"type": "done", "id": request_id, "status": "aborted", "executionCount": None})
                return
            try:
                msg = kc.get_iopub_msg(timeout=0.2)
            except queue.Empty:
                if not self.km.is_alive():
                    send({"type": "status", "state": "dead"})
                    send({"type": "done", "id": request_id, "status": "aborted", "executionCount": None})
                    return
                continue
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            kind = msg["header"]["msg_type"]
            if kind == "status" and msg["content"].get("execution_state") == "idle":
                break
            if kind == "clear_output":
                send({"type": "clear", "id": request_id, "wait": bool(msg["content"].get("wait"))})
                continue
            if kind == "execute_input":
                send({"type": "started", "id": request_id, "executionCount": msg["content"].get("execution_count")})
                continue
            output = self.to_output(msg)
            if output is not None:
                if output["output_type"] == "error":
                    status = "error"
                send({"type": "output", "id": request_id, "output": output})
        count = None
        try:
            reply = kc.get_shell_msg(timeout=5)
            while reply.get("parent_header", {}).get("msg_id") != msg_id:
                reply = kc.get_shell_msg(timeout=5)
            count = reply["content"].get("execution_count")
            if reply["content"].get("status") == "error":
                status = "error"
            elif reply["content"].get("status") == "aborted":
                status = "aborted"
        except queue.Empty:
            pass
        send({"type": "done", "id": request_id, "status": status, "executionCount": count})
        send({"type": "status", "state": "idle"})

    def shell_request(self, command, method, **kwargs):
        kc = self.kc
        msg_id = getattr(kc, method)(command["code"], command["cursor"], **kwargs)
        try:
            while True:
                reply = kc.get_shell_msg(timeout=5)
                if reply.get("parent_header", {}).get("msg_id") == msg_id:
                    send({"type": "reply", "id": command["id"], "content": reply["content"]})
                    return
        except queue.Empty:
            send({"type": "reply", "id": command["id"], "content": {"status": "error", "ename": "Timeout", "evalue": "Kernel did not reply."}})

    def worker(self):
        while True:
            command = self.work.get()
            try:
                op = command["op"]
                if op == "execute":
                    self.execute(command)
                elif op == "complete":
                    self.shell_request(command, "complete")
                elif op == "inspect":
                    self.shell_request(command, "inspect", detail_level=0)
            except Exception as error:  # noqa: BLE001 - keep the bridge alive
                if "id" in command:
                    send({"type": "failed", "id": command["id"], "message": str(error)})

    def run(self):
        self.start()
        threading.Thread(target=self.worker, daemon=True).start()
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                command = json.loads(line)
                op = command.get("op")
                if op == "interrupt":
                    self.interrupt()
                elif op == "restart":
                    # Drop queued work from before the restart.
                    while not self.work.empty():
                        dropped = self.work.get_nowait()
                        if "id" in dropped:
                            send({"type": "done", "id": dropped["id"], "status": "aborted", "executionCount": None})
                    self.restart()
                elif op == "shutdown":
                    self.shutdown()
                elif op in ("execute", "complete", "inspect"):
                    self.work.put(command)
            except Exception as error:  # noqa: BLE001
                send({"type": "error", "message": str(error)})
        self.shutdown()


if __name__ == "__main__":
    try:
        Bridge(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~")).run()
    except Exception as error:  # noqa: BLE001
        send({"type": "fatal", "message": f"Kernel failed to start: {error}"})
        sys.exit(4)
