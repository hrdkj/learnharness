import type { NotebookOutput } from "../notebook-model.ts";

const ANSI_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** Render text with ANSI SGR colour codes as safe DOM spans (no innerHTML). */
export function ansiInto(parent: HTMLElement, value: string): void {
  const document = parent.ownerDocument;
  let fg: string | undefined, bg: string | undefined, bold = false;
  // eslint-disable-next-line no-control-regex
  const pattern = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    if (!fg && !bg && !bold) { parent.append(text); return; }
    const span = document.createElement("span");
    span.textContent = text;
    if (fg) span.dataset.fg = fg;
    if (bg) span.dataset.bg = bg;
    if (bold) span.style.fontWeight = "600";
    parent.append(span);
  };
  for (const match of value.matchAll(pattern)) {
    push(value.slice(last, match.index));
    last = match.index! + match[0].length;
    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0) { fg = bg = undefined; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code >= 30 && code <= 37) fg = ANSI_COLORS[code - 30];
      else if (code >= 90 && code <= 97) fg = ANSI_COLORS[code - 90];
      else if (code === 39) fg = undefined;
      else if (code >= 40 && code <= 47) bg = ANSI_COLORS[code - 40];
      else if (code === 49) bg = undefined;
      else if ((code === 38 || code === 48) && codes[i + 1] === 5) i += 2;
      else if ((code === 38 || code === 48) && codes[i + 1] === 2) i += 4;
    }
  }
  // eslint-disable-next-line no-control-regex
  push(value.slice(last).replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""));
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter(item => typeof item === "string").join("");
  return "";
}

/** Theme tokens copied into the sandboxed HTML frame (it can't see app CSS). */
function frameCss(host: HTMLElement): string {
  const style = getComputedStyle(host);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const fg = token("--foreground", "#e6e6e6"), muted = token("--muted-foreground", "#8d8d8d"), border = token("--border", "#434343");
  return `html,body{margin:0;background:transparent;color:${fg};font:12.5px/1.45 ${token("--font-mono", "ui-monospace,monospace")};}
table{border-collapse:collapse;margin:0;font-size:12px}th,td{padding:3px 10px;text-align:right;border-bottom:1px solid ${border};white-space:nowrap}
thead th{color:${fg};font-weight:600;border-bottom:1px solid ${muted}}tbody th{color:${muted};font-weight:500}tbody tr:nth-child(odd){background:color-mix(in srgb,${fg} 4%,transparent)}
p,div{margin:0}a{color:${fg}}`;
}

/**
 * Scripts never run: the frame is sandboxed without allow-scripts. Same-origin
 * is kept only so the parent can size the frame to its content.
 */
function htmlFrame(container: HTMLElement, html: string): void {
  const frame = container.ownerDocument.createElement("iframe");
  frame.className = "lh-nb-html";
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "Cell output";
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;
  frame.srcdoc = `<!doctype html><html><head>${csp}<style>${frameCss(container)}</style></head><body>${html}</body></html>`;
  const fit = () => {
    const body = frame.contentDocument?.body;
    if (!body) return;
    frame.style.height = `${Math.min(body.scrollHeight + 2, 600)}px`;
    frame.style.width = `${Math.max(body.scrollWidth + 2, 40)}px`;
  };
  frame.addEventListener("load", () => {
    fit();
    const body = frame.contentDocument?.body;
    if (body && typeof ResizeObserver !== "undefined") new ResizeObserver(fit).observe(body);
  });
  container.append(frame);
}

export function renderOutputs(container: HTMLElement, outputs: readonly NotebookOutput[]): void {
  const document = container.ownerDocument;
  container.replaceChildren();
  for (const output of outputs) {
    const block = document.createElement("div");
    block.className = `lh-nb-output lh-nb-output--${output.output_type}`;
    if (output.output_type === "stream") {
      const pre = document.createElement("pre");
      if (output.name === "stderr") pre.classList.add("lh-nb-stderr");
      ansiInto(pre, output.text);
      block.append(pre);
    } else if (output.output_type === "error") {
      const pre = document.createElement("pre");
      pre.classList.add("lh-nb-error");
      ansiInto(pre, output.traceback.length ? output.traceback.join("\n") : `${output.ename}: ${output.evalue}`);
      block.append(pre);
    } else {
      const data = output.data;
      const png = text(data["image/png"]), jpeg = text(data["image/jpeg"]), html = text(data["text/html"]), plain = text(data["text/plain"]);
      if (png || jpeg) {
        const image = document.createElement("img");
        image.alt = plain || "Figure";
        image.src = png ? `data:image/png;base64,${png.replace(/\s/g, "")}` : `data:image/jpeg;base64,${jpeg.replace(/\s/g, "")}`;
        block.append(image);
      } else if (html) htmlFrame(block, html);
      else {
        const pre = document.createElement("pre");
        ansiInto(pre, plain);
        block.append(pre);
      }
    }
    container.append(block);
  }
}
