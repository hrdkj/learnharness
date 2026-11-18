import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";

export type KernelState = "stopped" | "starting" | "idle" | "busy" | "restarting" | "dead";

/** Bridge events relayed to the overlay (see kernel-bridge.py). */
export type BridgeEvent =
  | { type: "status"; state: KernelState }
  | { type: "started"; id: number; executionCount: number | null }
  | { type: "output"; id: number; output: unknown }
  | { type: "clear"; id: number; wait: boolean }
  | { type: "done"; id: number; status: "ok" | "error" | "aborted"; executionCount: number | null }
  | { type: "reply"; id: number; content: Record<string, unknown> }
  | { type: "failed"; id: number; message: string }
  | { type: "fatal" | "error"; message: string };

export interface KernelHost {
  python(): string;
  bridgePath: string;
  /** Relay to the overlay for one session. */
  emit(sessionId: string, event: BridgeEvent | { type: "stderr"; text: string }): void;
  idleMs: number;
}

class Kernel {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, (event: BridgeEvent) => void>();
  private idleTimer: NodeJS.Timeout | undefined;
  private buffered = "";
  state: KernelState = "stopped";

  constructor(private readonly sessionId: string, private readonly host: KernelHost, private readonly onExit: () => void) {}

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Never stop a kernel in the middle of a run.
      if (this.state === "busy") this.touch();
      else this.shutdown();
    }, this.host.idleMs);
    this.idleTimer.unref?.();
  }

  private setState(state: KernelState): void {
    this.state = state;
    this.host.emit(this.sessionId, { type: "status", state });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const python = this.host.python();
    if (!python.trim()) throw new Error("Set Notebook Python in Settings → Coding questions (a Python with ipykernel installed).");
    const child = spawn(python, ["-u", this.host.bridgePath, os.homedir()], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child = child;
    this.setState("starting");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffered += chunk;
      let newline: number;
      while ((newline = this.buffered.indexOf("\n")) >= 0) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        if (line.trim()) this.receive(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      // Kernel launcher warnings are noise; real failures arrive as fatal events.
      if (!/Kernel is running over TCP|WARNING \| /.test(text)) this.host.emit(this.sessionId, { type: "stderr", text });
    });
    child.on("error", error => {
      this.host.emit(this.sessionId, { type: "fatal", message: `Could not start ${python}: ${error.message}` });
      this.exited();
    });
    child.on("exit", () => this.exited());
    this.touch();
    return child;
  }

  private exited(): void {
    if (!this.child) return;
    this.child = undefined;
    clearTimeout(this.idleTimer);
    for (const resolve of this.pending.values()) resolve({ type: "failed", id: -1, message: "Kernel stopped." });
    this.pending.clear();
    this.setState("stopped");
    this.onExit();
  }

  private receive(line: string): void {
    let event: BridgeEvent;
    try { event = JSON.parse(line) as BridgeEvent; } catch { return; }
    if (event.type === "status") this.state = event.state;
    if ("id" in event && (event.type === "reply" || event.type === "failed")) {
      const resolve = this.pending.get(event.id);
      if (resolve) { this.pending.delete(event.id); resolve(event); return; }
    }
    if (event.type === "done") this.touch();
    this.host.emit(this.sessionId, event);
  }

  private send(command: Record<string, unknown>): void {
    const child = this.start();
    child.stdin.write(JSON.stringify(command) + "\n");
  }

  execute(code: string): number {
    const id = this.nextId++;
    this.touch();
    this.send({ op: "execute", id, code });
    return id;
  }

  request(op: "complete" | "inspect", code: string, cursor: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.touch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Kernel did not answer.")); }, 10_000);
      this.pending.set(id, event => {
        clearTimeout(timer);
        if (event.type === "reply") resolve(event.content);
        else reject(new Error(event.type === "failed" ? event.message : "Kernel request failed."));
      });
      try { this.send({ op, id, code, cursor }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  interrupt(): void { if (this.child) this.send({ op: "interrupt" }); }
  restart(): void { this.touch(); this.send({ op: "restart" }); }

  shutdown(): void {
    const child = this.child;
    if (!child) return;
    try { child.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n"); } catch { /* already closing */ }
    const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    kill.unref?.();
    child.once("exit", () => clearTimeout(kill));
  }
}

/** One kernel per learning session, started lazily, stopped after idleMs or on dispose. */
export class Kernels {
  private kernels = new Map<string, Kernel>();
  constructor(private readonly host: KernelHost) {}

  get(sessionId: string): Kernel {
    let kernel = this.kernels.get(sessionId);
    if (!kernel) {
      kernel = new Kernel(sessionId, this.host, () => { if (this.kernels.get(sessionId) === kernel) this.kernels.delete(sessionId); });
      this.kernels.set(sessionId, kernel);
    }
    return kernel;
  }

  state(sessionId: string): KernelState { return this.kernels.get(sessionId)?.state ?? "stopped"; }
  interrupt(sessionId: string): void { this.kernels.get(sessionId)?.interrupt(); }
  shutdown(sessionId: string): void { this.kernels.get(sessionId)?.shutdown(); }

  dispose(): void {
    for (const kernel of this.kernels.values()) kernel.shutdown();
    this.kernels.clear();
  }
}
