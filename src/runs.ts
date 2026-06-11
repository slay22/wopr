import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { stdin, stdout } from "node:process"

import { readRunMetadata, type PhaseMetadataStatus, type RunMetadata } from "./metadata"
import { isValidRunID, runsRoot } from "./workspace"

export type RunStatusKind = "completed" | "failed" | "incomplete" | "empty" | "unknown"

export type RunPhaseInfo = {
  name: string
  status: PhaseMetadataStatus
  durationMs?: number
  cost?: number
  model?: string
}

export type RunEntry = {
  runID: string
  dir: string
  title: string
  targetDir?: string
  status: string
  statusKind: RunStatusKind
  cost?: number
  createdAt?: number
  phases: RunPhaseInfo[]
}

export type RunsResolution = { type: "exit" } | { type: "resume"; runID: string; targetDir?: string }

export async function listRuns(root = runsRoot()): Promise<RunEntry[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  // Run IDs start with the wall-clock timestamp, so lexicographic order is chronological.
  const ids = names.filter(isValidRunID).sort().reverse()
  return Promise.all(ids.map((runID) => loadRunEntry(root, runID)))
}

/** Interactive run-history browser: pick a run, then resume it, read its reports, or open a subshell in its dir. */
export async function browseRuns(initialRunID?: string): Promise<RunsResolution> {
  const runs = await listRuns()
  if (runs.length === 0) {
    stdout.write(`no runs found in ${runsRoot()}\n`)
    return { type: "exit" }
  }

  let initialIndex = 0
  if (initialRunID) {
    initialIndex = runs.findIndex((run) => run.runID === initialRunID)
    if (initialIndex === -1) throw new Error(`run ${initialRunID} doesn't exist in ${runsRoot()}`)
  }

  // Pipes and CI get the plain listing; the browser needs a real terminal.
  if (!stdin.isTTY || !stdout.isTTY) {
    printRunList(runs)
    return { type: "exit" }
  }

  // Dynamic import keeps opentui out of non-interactive invocations (same
  // reason progress.ts lazy-loads the run TUI).
  const { browseRunsTui } = await import("./runs-tui")
  return browseRunsTui(runs, initialIndex)
}

/** SUMMARY.md when the run finished; otherwise whatever phase reports landed before it died. */
export async function loadRunSummary(run: RunEntry): Promise<string> {
  const summary = await readIfExists(join(run.dir, "SUMMARY.md"))
  if (summary !== undefined) return summary

  let reports: string[] = []
  try {
    reports = (await readdir(join(run.dir, "reports"))).filter((name) => name.endsWith(".md")).sort()
  } catch {
    // no reports dir
  }
  if (reports.length === 0) return "no summary or reports for this run"

  const sections: string[] = []
  for (const name of reports) {
    const body = await readIfExists(join(run.dir, "reports", name))
    if (body !== undefined) sections.push(`## reports/${name}\n\n${body.trim()}`)
  }
  return sections.join("\n\n")
}

async function loadRunEntry(root: string, runID: string): Promise<RunEntry> {
  const dir = join(root, runID)
  const metadata = await readRunMetadata(join(dir, "metadata.json"))
  const summary = statusSummary(metadata)
  return {
    runID,
    dir,
    title: await runTitle(dir),
    targetDir: metadata?.targetDir,
    status: summary.label,
    statusKind: summary.kind,
    cost: totalCost(metadata),
    createdAt: metadata?.createdAt,
    phases: phaseInfos(metadata),
  }
}

async function runTitle(dir: string) {
  const prd = await readIfExists(join(dir, "prd.md"))
  if (prd === undefined) return "(no prd)"
  const line = prd
    .split("\n")
    .map((raw) => raw.replace(/^#+\s*/, "").trim())
    .find(Boolean)
  return truncate(line ?? "(empty prd)", 60)
}

// Only phases that started get an entry, so the totals describe what the run
// recorded, not the full pipeline. Pre-metadata runs show "-".
function statusSummary(metadata: RunMetadata | undefined): { label: string; kind: RunStatusKind } {
  if (!metadata) return { label: "-", kind: "unknown" }
  const statuses = Object.values(metadata.phases).map((phase) => phase.status)
  if (statuses.length === 0) return { label: "empty", kind: "empty" }
  const done = statuses.filter((status) => status === "completed" || status === "skipped").length
  if (statuses.some((status) => status === "failed")) return { label: `failed (${done}/${statuses.length} ok)`, kind: "failed" }
  if (done === statuses.length) return { label: "completed", kind: "completed" }
  return { label: `incomplete (${done}/${statuses.length})`, kind: "incomplete" }
}

function totalCost(metadata: RunMetadata | undefined) {
  if (!metadata) return undefined
  let cost = 0
  let seen = false
  for (const phase of Object.values(metadata.phases)) {
    if (typeof phase.cost !== "number") continue
    cost += phase.cost
    seen = true
  }
  return seen ? cost : undefined
}

function phaseInfos(metadata: RunMetadata | undefined): RunPhaseInfo[] {
  if (!metadata) return []
  return Object.entries(metadata.phases).map(([name, phase]) => ({
    name,
    status: phase.status,
    durationMs: phase.durationMs,
    cost: phase.cost,
    model: phase.model,
  }))
}

function printRunList(runs: RunEntry[]) {
  const numberWidth = String(runs.length).length
  const statusWidth = Math.max(...runs.map((run) => run.status.length))
  stdout.write(`\nruns in ${runsRoot()}:\n`)
  for (const [index, run] of runs.entries()) {
    const number = String(index + 1).padStart(numberWidth)
    const cost = (run.cost !== undefined ? `$${run.cost.toFixed(2)}` : "").padStart(8)
    stdout.write(`  ${number}. ${run.runID}  ${run.status.padEnd(statusWidth)}  ${cost}  ${run.title}\n`)
  }
}

async function readIfExists(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`
}
