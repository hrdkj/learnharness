/** Minimal host pieces the notebook part of the backend needs. */
export function notebookHost(extra: { dataDirectory?: string } = {}) {
  return {
    directory: "/nonexistent-plugin-dir",
    signal: new AbortController().signal,
    events: { emit() {} },
    handle() { return () => {}; },
    registerTools() { return () => {}; },
    ...extra,
  };
}
