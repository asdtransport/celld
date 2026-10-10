// Process runner with a timeout. Swappable so services are testable without real binaries.
export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }
export type Runner = (argv: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult>;

export const bunRunner: Runner = async (argv, opts = {}) => {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; proc.kill("SIGTERM"); }, opts.timeoutMs ?? 60_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(t);
  return { code, stdout, stderr, timedOut };
};

let runner: Runner = bunRunner;
export const setRunner = (r: Runner) => { runner = r; };
export const run: Runner = (argv, opts) => runner(argv, opts);

// Strip ANSI + Rust backtrace noise from celld errors so the UI shows the sentence that matters.
export function cleanError(stderr: string): string {
  const s = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  const cut = s.indexOf("Stack backtrace:");
  const lines = (cut >= 0 ? s.slice(0, cut) : s).trim().split("\n").filter((l) => l.trim());
  // celld prints progress (bindings, bundle sizes) before the error: keep the error and what follows it.
  const err = lines.findIndex((l) => /^(Error|error)(\[|:)/.test(l.trim()));
  return (err >= 0 ? lines.slice(err, err + 12) : lines.slice(-12)).join("\n");
}
