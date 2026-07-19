import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { buildAgentRegistry, emptyHooksConfig, loadMergedWoprConfig, selectPipelineSpec, writeDefaultGlobalConfig, writeDefaultProjectConfig, type WoprDefaults } from "./config"
import { detectBaseRef, initializeRepoWithInitialCommit, repoBootstrapStatus } from "./git"
import { log } from "./log"
import { NotificationDispatcher, parseNotificationUrl } from "./notifications"
import { defaultGptModel, defaultGptVariant, defaultPipeline, defaultPipelineName, resolvePipeline, splitModelVariant, validateStepFilters } from "./pipeline"
import type { StepSpec, PipelineSpec } from "./pipeline"
import { parseModel, run } from "./runner"
import { browseRuns } from "./runs"
import type { Budget, Pipeline, RunOptions } from "./types"
import type { NotificationTarget } from "./notifications/types"
import { isValidRunID } from "./workspace"

/**
 * Flags as written: every scalar stays undefined until the user sets it, so
 * resolveRunOptions can tell "flag given" from "flag at its default" and apply
 * the precedence chain flag > .wopr/config.yaml defaults > built-in default.
 */
export type ParsedArgs = {
  prompt?: string
  promptFile?: string
  help?: boolean
  pipeline?: string
  /** Custom step specs for dynamic pipeline composition (e.g. --steps "implementer,tests"). Takes precedence over pipeline. */
  steps?: StepSpec[]
  files: string[]
  onlySteps: string[]
  skipSteps: string[]
  resumeRunID?: string
  keepRunDir?: boolean
  modelOverride?: string
  tui?: boolean
  humanReview?: boolean
  maxAttempts?: number
  baseRef?: string
  /**
   * Repo to auto-detect the base ref in when it differs from targetDir. TUI
   * worktree runs point targetDir at the fresh worktree, whose checked-out
   * branch is the new agent branch — the current-branch fallback must look at
   * the original repo instead.
   */
  baseDetectionDir?: string
  targetDir: string
  initRepo?: boolean
  worktree?: boolean
  keepWorktree?: boolean
  includeDirty?: boolean
  yolo?: boolean
  smart?: boolean
  smartModel?: string
  budget?: string
  budgetMode?: string
  /** When --no-budget is passed, the budget is cleared even if set in config. */
  noBudget?: boolean
  /** Notification URLs from --notify flags. */
  notify: string[]
  /** When --no-notify is passed, notifications are cleared even if set in config. */
  noNotify?: boolean
}

export type InitOptions = {
  targetDir: string
  global: boolean
  force: boolean
  quiet: boolean
}

export type CliCommand =
  | { type: "help"; text: string }
  | { type: "run"; options: RunOptions }
  | { type: "runs"; runID?: string }
  | { type: "worktrees"; action: "list" | "prune"; force: boolean }
  | { type: "config"; targetDir: string }
  | { type: "init"; options: InitOptions }
  | { type: "mcp"; argv: string[] }
  | { type: "notify-test"; targets: NotificationTarget[]; urls: string[] }

export async function parseAndRun(argv: string[]) {
  if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    await launchInteractiveRun(process.cwd())
    return
  }

  const command = await parseCommand(argv)
  if (command.type === "help") {
    process.stdout.write(command.text)
    return
  }
  if (command.type === "runs") {
    await openRunsBrowser(command.runID)
    return
  }
  if (command.type === "worktrees") {
    await runWorktreesCommand(command.action, command.force)
    return
  }
  if (command.type === "config") {
    await openConfigEditor(command.targetDir)
    return
  }
  if (command.type === "notify-test") {
    const dispatcher = new NotificationDispatcher(command.targets)
    const results = await dispatcher.test()
    for (const r of results) {
      if (r.ok) {
        process.stdout.write(`✅ ${r.target.kind === "ntfy" ? r.target.server + "/" + r.target.topic : String(r.target.kind)} — sent\n`)
      } else {
        process.stdout.write(`❌ ${r.target.kind === "ntfy" ? r.target.server + "/" + r.target.topic : String(r.target.kind)} — ${r.error ?? "unknown error"}\n`)
      }
    }
    return
  }

  if (command.type === "init") {
    const result = command.options.global
      ? await writeDefaultGlobalConfig(command.options.force)
      : await writeDefaultProjectConfig(command.options.targetDir, command.options.force)
    if (!command.options.quiet) {
      const scope = command.options.global ? "global config" : "project config"
      process.stdout.write(`${result.created ? "created" : "ensured"} ${scope}: ${result.path}\n`)
    }
    return
  }
  if (command.type === "mcp") {
    const { handleMcpSubcommand } = await import("./mcp")
    await handleMcpSubcommand(command.argv)
    return
  }

  await run(command.options)
}

async function launchInteractiveRun(targetDir: string) {
  // Imported lazily so normal CLI invocations don't pull in OpenTUI until they
  // explicitly ask for the zero-argument interactive launcher.
  const { launchRunTui } = await import("./launch-tui")
  // The launcher is home: runs/config are sub-screens you back out of into the
  // launcher, so quitting them (or finding no runs) returns here rather than
  // exiting wopr. Only launching or resuming a run is terminal.
  for (;;) {
    const selection = await launchRunTui({ targetDir })
    if (!selection) return
    if ("action" in selection) {
      if (selection.action === "runs") {
        if ((await openRunsBrowser()) === "resumed") return
      } else {
        await openConfigEditor(targetDir)
      }
      continue
    }

    const parsed = parseArgs([])
    parsed.targetDir = selection.targetDir
    parsed.baseDetectionDir = targetDir
    parsed.prompt = selection.prompt
    parsed.pipeline = selection.pipeline
    parsed.humanReview = selection.humanReview
    parsed.tui = selection.tui
    parsed.includeDirty = selection.includeDirty
    parsed.keepRunDir = selection.keepRunDir
    parsed.yolo = selection.yolo
    parsed.smart = selection.smart
    if (selection.includeDirty) parsed.maxAttempts = 1

    // The launcher's targetDir (outer param) is the original repo; base
    // detection and worktree cleanup are both anchored there.
    const worktree = selection.worktree ? { dir: selection.worktree.dir, mainRepo: targetDir } : undefined
    if (selection.worktree) {
      log.info(`running in isolated worktree (branch: ${selection.worktree.branch})`)
      log.info(`  dir: ${selection.worktree.dir}`)
    }

    await run({ ...(await resolveRunOptions(parsed)), prompt: selection.prompt, worktree })
    return
  }
}

// "resumed" means a run was handed off (terminal, like launching one); "exited"
// means the user backed out (or there were no runs) — the launcher loops on that.
async function openRunsBrowser(initialRunID?: string): Promise<"resumed" | "exited"> {
  // The browser can open a run's dashboard and come back, so loop until the
  // user resumes (which hands off to a real run) or quits.
  let currentRunID = initialRunID
  for (;;) {
    const resolution = await browseRuns(currentRunID)
    if (resolution.type === "resume") {
      await run(await resumeOptions(resolution.runID, resolution.targetDir))
      return "resumed"
    }
    if (resolution.type === "open") {
      // Lazily imported: attaching pulls in the dashboard + opencode client.
      const { openRunDashboard } = await import("./attach")
      await openRunDashboard(resolution.runID)
      currentRunID = resolution.runID
      continue
    }
    return "exited"
  }
}

async function runWorktreesCommand(action: "list" | "prune", force: boolean) {
  const { listWorktrees, pruneWorktrees } = await import("./worktrees")
  if (action === "prune") {
    const { removed, skipped } = await pruneWorktrees({ force })
    for (const dir of removed) process.stdout.write(`removed ${dir}\n`)
    for (const s of skipped) process.stdout.write(`skipped ${s.dir} — ${s.reason.split("\n")[0]}\n`)
    if (!removed.length && !skipped.length) process.stdout.write("no worktrees to prune\n")
    if (skipped.length) process.stdout.write("\nskipped worktrees have uncommitted changes; re-run `wopr worktrees prune --force` to remove them (branches are always kept)\n")
    return
  }
  const list = await listWorktrees()
  if (!list.length) {
    process.stdout.write("no worktrees\n")
    return
  }
  for (const wt of list) {
    process.stdout.write(wt.stale ? `${wt.dir}  (stale — main repo gone)\n` : `${wt.branch}\t${wt.dir}\n`)
  }
}

async function openConfigEditor(targetDir: string) {
  // Imported lazily so normal runs never pull in the opentui editor.
  const { editConfigTui } = await import("./config-tui")
  await editConfigTui({ targetDir })
}

// The browser resumes with default flags; metadata recovers both the repo the
// run was launched against and the pipeline it was running.
async function resumeOptions(runID: string, targetDir?: string): Promise<RunOptions> {
  const parsed = parseArgs([])
  parsed.resumeRunID = runID
  if (targetDir) parsed.targetDir = targetDir
  return { ...(await resolveRunOptions(parsed)), prompt: "" }
}

export async function parseCommand(argv: string[]): Promise<CliCommand> {
  if (argv[0] === "runs") {
    const rest = argv.slice(1)
    if (rest.length > 1) throw new Error("usage: wopr runs [run-id]")
    if (rest[0] !== undefined && !isValidRunID(rest[0])) throw new Error(`invalid run id: ${rest[0]}`)
    return { type: "runs", runID: rest[0] }
  }
  if (argv[0] === "config") {
    if (argv.length > 1) throw new Error("usage: wopr config")
    return { type: "config", targetDir: process.cwd() }
  }
  if (argv[0] === "worktrees") {
    const rest = argv.slice(1)
    const badFlag = rest.find((arg) => arg.startsWith("-") && arg !== "--force" && arg !== "-f")
    if (badFlag) throw new Error(`unknown flag: ${badFlag}`)
    const positional = rest.filter((arg) => !arg.startsWith("-"))
    if (positional.length > 1) throw new Error("usage: wopr worktrees [list|prune] [--force]")
    const action = positional[0] ?? "list"
    if (action !== "list" && action !== "prune") throw new Error("usage: wopr worktrees [list|prune] [--force]")
    return { type: "worktrees", action, force: rest.includes("--force") || rest.includes("-f") }
  }
  if (argv[0] === "notify") {
    const rest = argv.slice(1)
    if (rest[0] !== "test") throw new Error("usage: wopr notify test [url...]")
    const urls = rest.slice(1)
    const targets = urls.length > 0
      ? urls.map((url) => {
        try { return parseNotificationUrl(url) } catch (e) { throw new Error(`invalid notification URL: ${e instanceof Error ? e.message : String(e)}`) }
      })
      : (await loadMergedWoprConfig(process.cwd()))?.notifications ?? []
    if (targets.length === 0) throw new Error("no notification targets configured; pass a URL or add notifications: to your config")
    return { type: "notify-test", targets, urls }
  }

  if (argv[0] === "init") {
    const parsed = parseInitArgs(argv.slice(1))
    if (parsed.help) return { type: "help", text: initHelp() }
    return { type: "init", options: parsed }
  }
  if (argv[0] === "mcp") {
    return { type: "mcp", argv }
  }

  const parsed = parseArgs(argv)
  if (parsed.help) return { type: "help", text: help() }

  if (parsed.prompt && parsed.promptFile) {
    throw new Error("use either a positional prompt or --prompt-file, not both")
  }
  if (parsed.pipeline && parsed.steps) {
    throw new Error("--pipeline and --steps are mutually exclusive; use one or the other")
  }
  if (parsed.resumeRunID && (parsed.prompt || parsed.promptFile)) {
    throw new Error("--resume continues a previous run with its original PRD; it can't take a new prompt")
  }

  let prompt = parsed.prompt ?? ""
  if (parsed.promptFile) {
    prompt = await readFile(resolve(process.cwd(), parsed.promptFile), "utf8")
  }

  if (!prompt && !parsed.resumeRunID) {
    throw new Error("need a prompt (positional or --prompt-file) or --resume <id>")
  }

  let worktree: { dir: string; mainRepo: string } | undefined
  if (parsed.worktree) {
    if (parsed.resumeRunID) throw new Error("--worktree can't be combined with --resume")
    // Mirror the TUI's worktree flow: create the branch + worktree from the
    // ORIGINAL repo, then point the run at the worktree while keeping base-ref
    // detection anchored to the original (its branches aren't checked out in
    // the worktree). Lazy-import the namer so plain runs don't pull in pi.
    const original = parsed.targetDir
    if (parsed.initRepo) await initializeRepoWithInitialCommit(original)
    if ((await repoBootstrapStatus(original)) !== "ready") {
      throw new Error("--worktree needs a repo with at least one commit to branch from; create an initial commit first (or pass --init-repo)")
    }
    const config = await loadMergedWoprConfig(original)
    const { createIsolatedWorktree } = await import("./worktree")
    const wt = await createIsolatedWorktree({ targetDir: original, prompt, model: config?.defaults?.branchNameModel })
    log.info(`running in isolated worktree (branch: ${wt.branch})`)
    log.info(`  dir: ${wt.dir}`)
    parsed.baseDetectionDir = original
    parsed.targetDir = wt.dir
    parsed.includeDirty = false // a fresh worktree is always clean
    worktree = { dir: wt.dir, mainRepo: original }
  }

  return { type: "run", options: { ...(await resolveRunOptions(parsed)), prompt, worktree } }
}

type ParsedInitArgs = InitOptions & { help?: boolean }

function parseInitArgs(argv: string[]): ParsedInitArgs {
  const parsed: ParsedInitArgs = {
    targetDir: process.cwd(),
    global: false,
    force: false,
    quiet: false,
  }
  let hasDir = false

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (!raw.startsWith("-")) throw new Error("usage: wopr init [--global] [--force] [--dir <path>]")

    const { flag, value } = splitFlag(raw)
    const noValue = () => {
      if (value !== undefined) throw new Error(`${flag} does not take a value`)
    }
    const takeValue = () => {
      if (value !== undefined) return value
      const next = argv[++i]
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        noValue()
        parsed.help = true
        return parsed
      case "--global":
        noValue()
        parsed.global = true
        break
      case "--force":
        noValue()
        parsed.force = true
        break
      case "--quiet":
        noValue()
        parsed.quiet = true
        break
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        hasDir = true
        break
      default:
        throw new Error(`unknown init flag: ${flag}`)
    }
  }

  if (parsed.global && hasDir) throw new Error("use either --global or --dir, not both")
  return parsed
}

/** Applies the precedence chain and resolves the pipeline the run will execute. */
export async function resolveRunOptions(parsed: ParsedArgs): Promise<Omit<RunOptions, "prompt">> {
  const config = await loadMergedWoprConfig(parsed.targetDir)
  const defaults = config?.defaults ?? {}

  const humanReview = parsed.humanReview ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)

  const agents = buildAgentRegistry(config)
  let pipeline: Pipeline
  const pipelineName = parsed.pipeline ?? defaults.pipeline ?? defaultPipelineName

  // Custom steps take precedence over named pipeline
  if (parsed.steps) {
    const customSpec: PipelineSpec = {
      description: "Custom dynamic pipeline composed from --steps",
      steps: parsed.steps,
    }
    try {
      pipeline = resolvePipeline({ name: "custom", spec: customSpec, agents, defaultModel: defaults.model })
    } catch (error) {
      if (!parsed.resumeRunID) throw error
      pipeline = defaultPipeline()
    }
  } else {
    try {
      pipeline = resolvePipeline({ name: pipelineName, spec: selectPipelineSpec(config, pipelineName), agents, defaultModel: defaults.model })
    } catch (error) {
      // A resumed run replays the pipeline frozen in its metadata; a config
      // that has since broken must not block it. New runs surface the error.
      if (!parsed.resumeRunID) throw error
      pipeline = defaultPipeline()
    }
  }
  // --no-human-review / --no-human-step (and non-interactive defaults) drop manual gates from
  // the run entirely, so they never show up as steps.
  if (!humanReview) pipeline = { ...pipeline, steps: pipeline.steps.filter((step) => step.type !== "human") }

  if (parsed.modelOverride) parseModel(splitModelVariant(parsed.modelOverride).model)
  if (parsed.smartModel) parseModel(splitModelVariant(parsed.smartModel).model)
  // Smart auto-accept always needs a concrete judge model; resolve the fallback
  // chain here so the runner can stay oblivious to config and built-in defaults.
  const smartJudgeModel =
    parsed.smartModel || defaults.autoAcceptJudgeModel || parsed.modelOverride || defaults.model || `${defaultGptModel}#${defaultGptVariant}`

  // Budget precedence: CLI flag > pipeline.budget > defaults.budget > none
  let budget: Budget | undefined
  if (parsed.noBudget) {
    // --no-budget is an explicit opt-out: clear any budget from config too.
    budget = undefined
  } else if (parsed.budget !== undefined) {
    // Use Number() (not parseFloat) so trailing junk like "5.00abc" is rejected
    // outright instead of silently truncating to 5.
    const perRun = Number(parsed.budget)
    if (!Number.isFinite(perRun) || perRun <= 0) throw new Error(`--budget must be a positive number, got "${parsed.budget}"`)
    budget = { perRun, onExceed: parsed.budgetMode === "warn" ? "warn-and-continue" : "abort" }
  } else if (pipeline.budget) {
    budget = pipeline.budget
  } else if (defaults.budget) {
    budget = defaults.budget
  }

  // --budget-mode selects hard/soft cap regardless of where the budget came
  // from (CLI, pipeline override, or defaults), so it works without editing YAML.
  if (budget && parsed.budgetMode) {
    budget = { ...budget, onExceed: parsed.budgetMode === "warn" ? "warn-and-continue" : "abort" }
  }

  const options: Omit<RunOptions, "prompt"> = {
    files: [...(config?.attachments ?? []), ...parsed.files],
    onlySteps: parsed.onlySteps,
    skipSteps: parsed.skipSteps,
    resumeRunID: parsed.resumeRunID ?? "",
    keepRunDir: parsed.keepRunDir ?? true,
    modelOverride: parsed.modelOverride ?? "",
    tui: parsed.tui ?? Boolean(process.stdout.isTTY && process.stderr.isTTY),
    humanReview,
    maxAttempts: parsed.maxAttempts ?? defaults.maxAttempts ?? 2,
    baseRef: await resolveBaseRef(parsed, defaults),
    targetDir: parsed.targetDir,
    initRepo: parsed.initRepo ?? false,
    keepWorktree: parsed.keepWorktree ?? defaults.keepWorktree ?? true,
    includeDirty: parsed.includeDirty ?? false,
    yolo: parsed.yolo ?? false,
    smart: parsed.smart ?? false,
    smartJudgeModel,
    budget,
    pipeline,
    agents,
    permissions: config?.permissions ?? { allow: [], deny: [] },
    hooks: config?.hooks ?? emptyHooksConfig(),
    // Notification resolution: --no-notify clears; otherwise --notify flags override config
    notifications: parsed.noNotify
      ? []
      : parsed.notify.length > 0
        ? parsed.notify.map((url) => {
          try { return parseNotificationUrl(url) } catch (e) { throw new Error(`invalid notification URL: ${e instanceof Error ? e.message : String(e)}`) }
        })
        : config?.notifications ?? [],
  }

  // Fast feedback for typos; a resumed run validates again in the runner
  // against the pipeline frozen in its metadata.
  if (!options.resumeRunID) validateStepFilters(pipeline, options)

  return options
}

// Base source: flag > config defaults.baseRef > auto-detection (never persisted).
// An explicit base that doesn't exist stays a hard error in ensureRepoReady.
async function resolveBaseRef(parsed: ParsedArgs, defaults: WoprDefaults): Promise<string> {
  const explicit = parsed.baseRef ?? defaults.baseRef
  if (explicit) return explicit
  const detected = await detectBaseRef(parsed.baseDetectionDir ?? parsed.targetDir)
  if (!detected) return "HEAD" // non-repo / zero commits: ensureRepoReady reports the real problem
  log.info(`base ref: ${detected.ref} (auto-detected)`)
  return detected.ref
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    files: [],
    onlySteps: [],
    skipSteps: [],
    targetDir: process.cwd(),
    notify: [],
    steps: undefined,
  }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (raw === "--") {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (!raw.startsWith("-")) {
      positional.push(raw)
      continue
    }

    const { flag, value } = splitFlag(raw)
    const takeValue = () => {
      if (value !== undefined) return value
      const next = argv[++i]
      // A following flag is not a value; catching it here beats silently
      // consuming it (e.g. `--prompt-file --only x`).
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        parsed.help = true
        return parsed
      case "--prompt-file":
      case "--prd":
        parsed.promptFile = takeValue()
        break
      case "--file":
      case "-f":
        parsed.files.push(takeValue())
        break
      case "--steps":
        // Comma-separated list of agent names -> StepSpec[]
        parsed.steps = listValue(takeValue()).map((name) => ({ agent: name }))
        break
      case "--pipeline":
      case "-p":
        parsed.pipeline = takeValue()
        break
      case "--only":
        parsed.onlySteps.push(...listValue(takeValue()))
        break
      case "--skip":
        parsed.skipSteps.push(...listValue(takeValue()))
        break
      case "--resume":
        parsed.resumeRunID = takeValue()
        break
      case "--keep-run-dir":
        parsed.keepRunDir = true
        break
      case "--no-keep-run-dir":
        parsed.keepRunDir = false
        break
      case "--init-repo":
        parsed.initRepo = true
        break
      case "--worktree":
        parsed.worktree = true
        break
      case "--keep-worktree":
        parsed.keepWorktree = true
        break
      case "--no-keep-worktree":
        parsed.keepWorktree = false
        break
      case "--include-dirty":
        parsed.includeDirty = true
        break
      case "--budget":
        parsed.budget = takeValue()
        break
      case "--no-budget":
        parsed.budget = undefined
        parsed.noBudget = true
        break
      case "--notify":
        parsed.notify.push(takeValue())
        break
      case "--no-notify":
        parsed.notify = []
        parsed.noNotify = true
        break
      case "--budget-mode":
        parsed.budgetMode = takeValue()
        if (parsed.budgetMode !== "abort" && parsed.budgetMode !== "warn") throw new Error('--budget-mode must be "abort" or "warn"')
        break
      case "--yolo":
        parsed.yolo = true
        break
      case "--smart":
        parsed.smart = true
        break
      case "--smart-model":
        parsed.smartModel = takeValue()
        break
      case "--model":
        parsed.modelOverride = takeValue()
        break
      case "--tui":
        parsed.tui = true
        break
      case "--no-tui":
        parsed.tui = false
        break
      case "--human-review":
      case "--human-step":
        parsed.humanReview = true
        break
      case "--no-human-review":
      case "--no-human-step":
        parsed.humanReview = false
        break
      case "--max-attempts":
        parsed.maxAttempts = parseInt(takeValue(), 10)
        if (!Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts < 1) {
          throw new Error("--max-attempts must be a positive integer")
        }
        break
      case "--base":
        parsed.baseRef = takeValue()
        break
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        break
      default:
        throw new Error(`unknown flag: ${flag}`)
    }
  }

  if (positional.length > 0) parsed.prompt = positional.join(" ")
  return parsed
}

function splitFlag(raw: string) {
  const index = raw.indexOf("=")
  if (index === -1) return { flag: raw, value: undefined }
  return { flag: raw.slice(0, index), value: raw.slice(index + 1) }
}

function listValue(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function help() {
  return `wopr [prompt]

Sequential coding-agent pipeline for implementing features.

Usage:
  wopr
  wopr "Add onboarding"
  wopr --prompt-file prd.md --file lib/onboarding --file test/onboarding_test.dart
  wopr --pipeline bug-fix --prompt-file bug.md
  wopr init
  wopr runs [run-id]
  wopr config

Commands:
  wopr                   Open an interactive TUI launcher to pick a pipeline,
                           enter a prompt, and toggle run options
  init                     Create .wopr/config.yaml and .wopr/agents/*.md in the target repo
  init --global            Create ~/.wopr/config.yaml and ~/.wopr/agents/*.md
  runs [run-id]            Browse run history: resume a run, read its summary/reports,
                           or open a subshell in its run dir (under ~/.wopr/runs)
  mcp                      Start the MCP server (stdio), or use --list-tools / --version
  worktrees [list|prune]   List the isolated worktrees --worktree created (under ~/.wopr/worktrees),
                           or prune their checkouts (branches are kept; --force removes dirty ones)
  config                   View and edit the global (~/.wopr) and current project config in a TUI
  notify test [url...]     Send a test notification (uses configured targets, or explicit URLs)

Flags:
  --prompt-file <path>     Read the PRD/prompt from a file
  --file, -f <path>        Attach a file or directory to all steps (repeatable)
  --steps <agents>         Comma-separated list of agent names for a custom dynamic
                           pipeline (e.g. --steps "implementer,tests"). Takes
                           precedence over --pipeline.
  --pipeline, -p <name>    Pipeline to run (default: "implement"), which runs
                           implementer,patterns,security,design,tests,adversarial
  --only <steps>           Run only these pipeline steps
  --skip <steps>           Skip these pipeline steps
  --resume <id>            Resume a previous run by its ID (steps with an existing report are
                           skipped; the run replays the pipeline it started with)
  --keep-run-dir           Keep the run dir when done (default)
  --no-keep-run-dir        Delete the run dir on successful completion
  --yolo                   Auto-allow ask-level permissions (hard denylist still applies; shift+tab cycles it live in the TUI)
  --smart                  Smart auto-accept: an AI judge auto-allows safe ask-level requests and escalates risky ones (shift+tab cycles)
  --smart-model <provider/model[#variant]> Model for the smart auto-accept judge (default: defaults.autoAcceptJudgeModel, else the run's model)
  --init-repo              Start from scratch: create the git repo and/or an initial commit first, so wopr can run in an empty/uninitialized directory
  --worktree               Run in a new branch + git worktree (named from your prompt, under ~/.wopr/worktrees), leaving the current working tree untouched
  --keep-worktree          Keep the --worktree checkout after a successful run (default; overrides defaults.keepWorktree)
  --no-keep-worktree       Auto-remove the --worktree checkout after a successful run (the branch is kept)
  --include-dirty          Include existing changes in the first commit (requires --max-attempts 1)
  --budget <usd>           Hard cost cap; run aborts before exceeding this (e.g. --budget 5.00)
  --no-budget              Clear any budget set in the project/global config
  --notify <url>               Notification target (ntfy://...); repeatable, overrides config
  --no-notify                  Clear all notification targets (even from config)
  --budget-mode abort|warn Whether to abort (default) or warn-and-continue when the budget is exceeded
  --model <provider/model[#variant]> Force a model for all steps
  --tui                    Show visual phase progress (default in interactive terminals)
  --no-tui                 Disable visual phase progress
  --human-step             Enable human steps (alias: --human-review; default in interactive terminals)
  --no-human-step          Drop all human steps (alias: --no-human-review)
  --max-attempts <n>       Attempts per step before failing (default: 2)
  --base <ref>             Branch/base for calculating diffs (default: auto-detected — origin's default branch, else main/master/develop/trunk, else the current branch)
  --dir <path>             Target repo (default: cwd)

Config files:
  ~/.wopr/config.yaml    user defaults, created by make install or wopr init --global
  .wopr/config.yaml      project-local overrides, created by wopr init
  agents/*.md              Markdown prompts loaded by matching the agent name

Config keys:
  defaults:                model, maxAttempts, baseRef, pipeline, autoAcceptJudgeModel, branchNameModel
  agents:                  project agents or built-in overrides; prompts live at agents/<name>.md
  pipelines:               named step lists mixing agents and human gates
  permissions:             allow/deny additions to the bash policy (deny always wins)
  hooks:                   pre/post shell commands, globally or per pipeline
  attachments:             files attached to every step
  The same schema lives globally at ~/.wopr/config.yaml; project config merges on top.
  Precedence: CLI flags > project config > global config > built-in defaults.
`
}

function initHelp() {
  return `wopr init [--global] [--force] [--dir <path>]

Create WOPR's default config file and agent prompt Markdown files. Existing files are not overwritten unless --force is set.

Options:
  --global                 Write ~/.wopr/config.yaml instead of a project config
  --dir <path>             Target repo for .wopr/config.yaml (default: cwd)
  --force                  Overwrite an existing config file
  --quiet                  Suppress status output
`
}
