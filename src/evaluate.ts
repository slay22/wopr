// Runs configured install/build/test/run commands in the target repo to produce
// a concrete "does it actually work?" signal that gates the loop's verdict
// (adapted from council's src/core/evaluate.ts).
//
// ponytail: this executes whatever the agents wrote. Off by default; only turn
// it on where running agent-generated commands is acceptable (a sandbox/CI).

import { join } from "node:path"

export type EvaluationConfig = {
  enabled?: boolean
  install?: string
  build?: string
  test?: string
  run?: string
  /** Working dir relative to the repo root. */
  cwd?: string
  /** Per-command timeout (default 300s). */
  timeoutMs?: number
}

export type EvalStep = "install" | "build" | "test" | "run"

export type EvalStepResult = {
  step: EvalStep
  command: string
  ok: boolean
  /** null = timed out or aborted. */
  exitCode: number | null
  output: string
  skipped?: boolean
}

export type EvalResult = {
  /** At least one command executed. */
  ran: boolean
  /** Every executed step succeeded. */
  passed: boolean
  steps: EvalStepResult[]
}

const STEP_ORDER: EvalStep[] = ["install", "build", "test", "run"]
const OUTPUT_LIMIT = 4000

export async function runEvaluation(repoDir: string, config: EvaluationConfig, signal?: AbortSignal): Promise<EvalResult> {
  if (config.enabled === false) return { ran: false, passed: true, steps: [] }

  const cwd = config.cwd ? join(repoDir, config.cwd) : repoDir
  const timeoutMs = config.timeoutMs ?? 300_000
  const steps: EvalStepResult[] = []
  let failed = false

  for (const step of STEP_ORDER) {
    const command = config[step]
    if (typeof command !== "string" || command.trim() === "") continue

    if (failed || signal?.aborted) {
      steps.push({ step, command, ok: false, exitCode: null, output: signal?.aborted ? "[cancelled]" : "", skipped: true })
      failed = true
      continue
    }

    const result = await runCommand(command, cwd, timeoutMs, signal)
    steps.push({ step, command, ...result })
    if (!result.ok) failed = true
  }

  const ran = steps.some((step) => !step.skipped)
  return { ran, passed: ran && !failed, steps }
}

async function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  let timedOut = false
  let cancelled = false
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    return { ok: false, exitCode: null, output: `failed to start: ${error instanceof Error ? error.message : String(error)}` }
  }

  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const onAbort = () => {
    cancelled = true
    try {
      proc.kill()
    } catch {
      /* already exited */
    }
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  try {
    // Drain stdout/stderr concurrently with exit so a verbose command (output
    // larger than the pipe buffer) can't deadlock us.
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ])
    const output = truncate((stdout + stderr).trim() + (timedOut ? "\n[timed out]" : "") + (cancelled ? "\n[cancelled]" : ""))
    return { ok: exitCode === 0 && !timedOut && !cancelled, exitCode: timedOut || cancelled ? null : exitCode, output }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener("abort", onAbort)
  }
}

function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… [truncated]` : text
}

/** Render an evaluation result for the validator prompt / loop feedback. */
export function formatEvalForValidator(result: EvalResult): string {
  if (!result.ran) return ""
  const lines = result.steps.map((step) => {
    if (step.skipped) return `- ${step.step}: SKIPPED (earlier step failed)`
    const status = step.ok ? "OK" : `FAILED (exit ${step.exitCode ?? "timeout"})`
    const tail = step.ok ? "" : `\n  \`${step.command}\`\n  ${step.output.split("\n").slice(-20).join("\n  ")}`
    return `- ${step.step}: ${status}${tail}`
  })
  return `## Build / Test Results (${result.passed ? "PASSED" : "FAILED"})\n${lines.join("\n")}`
}
