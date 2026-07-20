import { statSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { projectAgentPromptPath } from "./agents"
import type { NotificationTarget } from "./notifications/types"
import { builtInPrompts } from "./built-in-prompts"
import { log } from "./log"
import {
  agentAliases,
  builtInAgents,
  builtInPipelines,
  defaultGptModel,
  defaultGptVariant,
  defaultImplementReviewModel,
  defaultPipelineName,
  humanStepType,
  humanReviewStep,
  isHumanStepSpec,
  isLoopSpec,
  readOnlyAgentSuffix,
  splitModelVariant,
  type AgentStepSpec,
  type HumanStepSpec,
  type PipelineSpec,
  type StepSpec,
} from "./pipeline"
import type { AgentSpec, ApprovalsConfig, Budget, HookSet, HookSpec, HooksConfig, HookWhen, PermissionAdditions } from "./types"
import { parseNotificationUrl } from "./notifications/parse"
import type { NtfyTarget } from "./notifications/types"
import { woprHome, woprRoot, globalConfigPath } from "./workspace"

/**
 * Project configuration loaded from .wopr/config.yaml. Everything is
 * optional: the file only declares what differs from wopr's defaults.
 */
export type WoprConfig = {
  defaults: WoprDefaults
  agents: Record<string, ConfigAgent>
  pipelines: Record<string, PipelineSpec>
  permissions: PermissionAdditions
  hooks: HooksConfig
  attachments: string[]
  notifications: NotificationTarget[]
  /** Remote approvals via ntfy; absent means disabled. */
  approvals?: ApprovalsConfig
}

export type WoprDefaults = {
  model?: string
  maxAttempts?: number
  baseRef?: string
  pipeline?: string
  /** Model for the smart auto-accept judge; falls back to the run's model when unset. */
  autoAcceptJudgeModel?: string
  /** Model that names worktree branches; falls back to the built-in cheap default when unset. */
  branchNameModel?: string
  /** Keep the isolated worktree (--worktree) after a successful run; false auto-removes its checkout, keeping the branch. Defaults to true. */
  keepWorktree?: boolean
  /** Per-run budget cap; CLI > pipeline.budget > defaults.budget > none. */
  budget?: Budget
}

/** A project agent definition, or model/temperature/readOnly overrides for a built-in one. */
export type ConfigAgent = {
  description?: string
  model?: string
  temperature?: number
  /** Disable write/edit/bash tools for this agent. */
  readOnly?: boolean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message }
  }
}

const configFileNames = ["config.yaml", "config.yml"]

export async function loadWoprConfig(targetDir: string): Promise<WoprConfig | undefined> {
  for (const fileName of configFileNames) {
    const path = join(targetDir, ".wopr", fileName)
    let body: string
    try {
      body = await readFile(path, "utf8")
    } catch {
      continue
    }
    return parseWoprConfig(body, `.wopr/${fileName}`, targetDir)
  }
  return undefined
}

/**
 * The per-user config at ~/.wopr/config.yaml. Parsed with targetDir set to
 * woprRoot() — the directory that holds `.wopr` — so agent-prompt validation
 * resolves to ~/.wopr/agents/<name>.md, exactly like a project repo.
 */
export async function loadGlobalWoprConfig(): Promise<WoprConfig | undefined> {
  for (const fileName of configFileNames) {
    const path = join(woprHome(), fileName)
    let body: string
    try {
      body = await readFile(path, "utf8")
    } catch {
      continue
    }
    return parseWoprConfig(body, `~/.wopr/${fileName}`, woprRoot())
  }
  return undefined
}

/**
 * Merges the global config under the project one: project keys win on
 * defaults/agents/pipelines (shallow, by key/name), and permissions/hooks/
 * attachments concatenate (global first). deny still wins over allow in
 * bashPolicy, so the concatenation order is irrelevant there.
 */
export function mergeWoprConfigs(global: WoprConfig | undefined, project: WoprConfig | undefined): WoprConfig | undefined {
  if (!global) return project
  if (!project) return global
  return {
    defaults: { ...global.defaults, ...project.defaults },
    agents: { ...global.agents, ...project.agents },
    pipelines: { ...global.pipelines, ...project.pipelines },
    permissions: {
      allow: [...global.permissions.allow, ...project.permissions.allow],
      deny: [...global.permissions.deny, ...project.permissions.deny],
    },
    hooks: mergeHooksConfig(global.hooks, project.hooks),
    attachments: [...global.attachments, ...project.attachments],
    // Project notifications override global ones entirely (like agents/pipelines)
    notifications: project.notifications.length > 0 ? project.notifications : global.notifications,
    // Project approvals override global ones entirely
    approvals: project.approvals ?? global.approvals,
  }
}

/** The effective config for a run: global merged under the project config. */
export async function loadMergedWoprConfig(targetDir: string): Promise<WoprConfig | undefined> {
  const [global, project] = await Promise.all([loadGlobalWoprConfig(), loadWoprConfig(targetDir)])
  return mergeWoprConfigs(global, project)
}

export function emptyHooksConfig(): HooksConfig {
  return { pre: [], post: [], pipelines: {} }
}

function emptyHookSet(): HookSet {
  return { pre: [], post: [] }
}

function mergeHooksConfig(global: HooksConfig, project: HooksConfig): HooksConfig {
  const pipelineNames = new Set([...Object.keys(global.pipelines), ...Object.keys(project.pipelines)])
  const pipelines: Record<string, HookSet> = {}
  for (const name of pipelineNames) {
    pipelines[name] = mergeHookSet(global.pipelines[name] ?? emptyHookSet(), project.pipelines[name] ?? emptyHookSet())
  }
  return { ...mergeHookSet(global, project), pipelines }
}

function mergeHookSet(global: HookSet, project: HookSet): HookSet {
  return { pre: [...global.pre, ...project.pre], post: [...global.post, ...project.post] }
}

/**
 * The commented YAML template written by `wopr init`. It documents every key
 * (commented out) and inlines the built-in `implement` pipeline so it's an
 * immediately editable starting point. Unlike `defaultConfigTemplate` (used by
 * the TUI's initialize action), this is a human-readable string with comments.
 */
export const defaultWoprConfig = `# WOPR configuration.
# Global default path: ~/.wopr/config.yaml
# Project override path: .wopr/config.yaml

version: 1

defaults:
  # model: openai/gpt-5.6-terra#xhigh # optional: uncomment to force every agent unless a step/agent overrides it
  # maxAttempts: 2
  # baseRef: main # optional: when unset, wopr auto-detects (origin default branch, else main/master/develop/trunk, else current branch)
  # pipeline: implement
  # branchNameModel: anthropic/claude-haiku-4-5 # optional: model that names worktree branches
  # keepWorktree: false # optional: auto-remove a --worktree checkout after a successful run (the branch is kept); defaults to true
  # budget:
  #   perRun: 10.00 # hard cap in USD; run aborts before exceeding this
  #   onExceed: abort # abort | warn-and-continue

# Agents are matched by name with Markdown prompts next to this config:
#   agents/<name>.md
# Uncomment entries to override metadata/model/temperature or to add custom agents.
# Custom agents must have a matching agents/<name>.md prompt file.
# agents:
#   implementer:
#     description: Implements the feature described in the PRD respecting repo patterns
#     model: openai/gpt-5.6-terra#xhigh
#   design-polisher:
#     description: Polishes new UI following the repo's design system, without redesigning
#     model: anthropic/claude-opus-4-8
#     temperature: 0.2
#   api-reviewer:
#     description: Reviews API consistency
#     model: openai/gpt-5.6-terra#xhigh

# WOPR ships these pipelines built in; pick one with -p/--pipeline without redeclaring it here:
#   implement            the default: build the feature, then audit, polish, test, and adversarial review
#   implement-lite       like implement, but swaps GPT 5.6 Terra xhigh phases for GLM 5.2
#   ultra-implement      like implement, with dual-model parallel audits and a final review/fix/validate stage
#   refine               audit the current diff, then apply the triaged fixes (changes code)
#   ultra-refine         like refine, with every audit fanned out across two models
#   review               report-only: parallel audits across two models plus one prioritized report (no changes)
#   review-lite          like review, but swaps GPT 5.6 Terra xhigh for GLM 5.2 (scope + audit fan-out); report stays on Opus
# The default \`implement\` pipeline is inlined below as an editable starting point; redefining a name here overrides the built-in.
pipelines:
  implement:
    description: Implementation, pattern/security audits, design polish, tests, and adversarial review
    steps:
      - agent: implementer
        reports: none
      - patterns
      - security
      - agent: design
        model: ${defaultImplementReviewModel}
      - agent: tests
        reports: none
      - agent: adversarial
        model: ${defaultImplementReviewModel}
        reports: all

# Optional shell hooks. Top-level hooks run for every pipeline; hooks under
# hooks.pipelines.<name> are appended only for that pipeline. Commands run from
# the target repo by default with WOPR_* environment variables available
# (WOPR_RUN_ID, WOPR_RUN_DIR, WOPR_TARGET_DIR, WOPR_PIPELINE,
# WOPR_RUN_STATUS for post-hooks, etc.). Post-hook "when" defaults to success.
# hooks:
#   pre:
#     - pnpm lint
#   post:
#     - command: ./scripts/notify.sh
#       when: always          # success | failure | always
#       continueOnError: true
#   pipelines:
#     implement:
#       post:
#         - name: open-pr
#           command: gh pr create --fill
#           cwd: target       # target | run
#           timeoutSeconds: 120

permissions:
  allow: []
  deny: []

# Notifications (ntfy only for now). See AGENTS.md for URL format.
# notifications:
#   - ntfy://wopr-topic
#   - ntfy://ntfy.example.com/wopr-team

# Remote permissions approvals via ntfy.
# When configured, ask-level permission prompts are sent as ntfy notifications
# and the user replies from the ntfy app. See AGENTS.md §5 for details.
# approvals:
#   topic: ntfy://wopr-approvals-topic
#   timeoutSeconds: 300        # how long to wait for a reply (default: 300)
#   onTimeout: reject          # reject or allow-once (default: reject)

attachments: []
`

export type ConfigWriteResult = {
  path: string
  created: boolean
}

/** Path of the project config file (default name). */
export function projectConfigPath(targetDir: string) {
  return join(targetDir, ".wopr", "config.yaml")
}

/** Re-exported from workspace so callers don't need both modules. */
export { globalConfigPath }

/** Writes the global config at ~/.wopr/config.yaml (plus default agent prompts). */
export async function writeDefaultGlobalConfig(force = false): Promise<ConfigWriteResult> {
  return writeDefaultWoprConfig(globalConfigPath(), force)
}

/** Writes a project config at <targetDir>/.wopr/config.yaml (plus default agent prompts). */
export async function writeDefaultProjectConfig(targetDir: string, force = false): Promise<ConfigWriteResult> {
  await assertDirectory(targetDir)
  return writeDefaultWoprConfig(projectConfigPath(targetDir), force)
}

/**
 * Writes the commented template config and copies every built-in agent prompt
 * to `<dirname(path)>/agents/<name>.md`. Existing files are left alone unless
 * `force` is set. Agent prompts live next to the config file under `agents/`,
 * mirroring how the loader discovers them.
 */
export async function writeDefaultWoprConfig(path: string, force = false): Promise<ConfigWriteResult> {
  const configDir = dirname(path)
  await mkdir(configDir, { recursive: true })
  await writeDefaultAgentPrompts(configDir, force)
  try {
    await writeFile(path, defaultWoprConfig, { flag: force ? "w" : "wx" })
    return { path, created: true }
  } catch (error) {
    if (!force && isErrno(error, "EEXIST")) return { path, created: false }
    throw error
  }
}

async function writeDefaultAgentPrompts(configDir: string, force: boolean) {
  const agentsDir = join(configDir, "agents")
  await mkdir(agentsDir, { recursive: true })
  for (const agent of builtInAgents) {
    const target = join(agentsDir, `${agent.name}.md`)
    const body = builtInPrompts[agent.name]
    if (body === undefined) throw new Error(`missing built-in prompt: add prompts/${agent.name}.md to src/built-in-prompts.ts`)
    try {
      await writeFile(target, body, { flag: force ? "w" : "wx" })
    } catch (error) {
      if (!force && isErrno(error, "EEXIST")) continue
      throw error
    }
  }
}

async function assertDirectory(path: string) {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    throw new Error(`target directory does not exist: ${path}`)
  }
  if (!info.isDirectory()) throw new Error(`target path is not a directory: ${path}`)
}

function isErrno(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}

export function parseWoprConfig(body: string, source: string, targetDir: string): WoprConfig {
  let raw: unknown
  try {
    raw = Bun.YAML.parse(body)
  } catch (error) {
    throw new ConfigError(`${source}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }

  const config: WoprConfig = { defaults: {}, agents: {}, pipelines: {}, permissions: { allow: [], deny: [] }, hooks: emptyHooksConfig(), attachments: [], notifications: [], approvals: undefined }
  if (raw === null || raw === undefined) return config

  const v = new Validator(source)
  const root = v.record(raw, "")
  // Unknown keys warn instead of failing so configs written for a newer
  // wopr still load; typos surface in the warning either way.
  v.knownKeys(root, "", ["version", "defaults", "agents", "pipelines", "permissions", "hooks", "attachments", "notifications", "approvals"])

  if (root.version !== undefined && root.version !== 1) v.fail("version", `unsupported value ${JSON.stringify(root.version)}; this wopr reads version 1`)

  if (root.defaults !== undefined && root.defaults !== null) config.defaults = validateDefaults(v, root.defaults)
  if (root.agents !== undefined) config.agents = validateAgents(v, root.agents, targetDir)
  if (root.pipelines !== undefined) config.pipelines = validatePipelines(v, root.pipelines)
  if (root.permissions !== undefined) config.permissions = validatePermissions(v, root.permissions)
  if (root.hooks !== undefined) config.hooks = validateHooks(v, root.hooks)
  if (root.attachments !== undefined) config.attachments = v.stringArray(root.attachments, "attachments")
  if (root.notifications !== undefined) {
    const rawUrls = v.stringArray(root.notifications, "notifications")
    config.notifications = rawUrls.map((url) => {
      try {
        return parseNotificationUrl(url)
      } catch (error) {
        throw new ConfigError(`notifications: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  if (root.approvals !== undefined && root.approvals !== null) {
    config.approvals = validateApprovals(v, root.approvals)
  }

  return config
}

function validateDefaults(v: Validator, raw: unknown): WoprDefaults {
  const record = v.record(raw, "defaults")
  v.knownKeys(record, "defaults", ["model", "maxAttempts", "baseRef", "pipeline", "autoAcceptJudgeModel", "branchNameModel", "keepWorktree", "budget"])

  const defaults: WoprDefaults = {}
  if (record.model !== undefined) defaults.model = v.model(record.model, "defaults.model")
  if (record.maxAttempts !== undefined) defaults.maxAttempts = v.positiveInt(record.maxAttempts, "defaults.maxAttempts")
  if (record.baseRef !== undefined) defaults.baseRef = v.nonEmptyString(record.baseRef, "defaults.baseRef")
  if (record.pipeline !== undefined) defaults.pipeline = v.nonEmptyString(record.pipeline, "defaults.pipeline")
  if (record.autoAcceptJudgeModel !== undefined) defaults.autoAcceptJudgeModel = v.model(record.autoAcceptJudgeModel, "defaults.autoAcceptJudgeModel")
  if (record.branchNameModel !== undefined) defaults.branchNameModel = v.model(record.branchNameModel, "defaults.branchNameModel")
  if (record.keepWorktree !== undefined) defaults.keepWorktree = v.boolean(record.keepWorktree, "defaults.keepWorktree")
  if (record.budget !== undefined) defaults.budget = validateBudget(v, record.budget, "defaults.budget")
  return defaults
}

function validateAgents(v: Validator, raw: unknown, targetDir: string): Record<string, ConfigAgent> {
  const record = v.record(raw, "agents")
  const agents: Record<string, ConfigAgent> = {}

  for (const [name, value] of Object.entries(record)) {
    const path = `agents.${name}`
    if (name === humanReviewStep) v.fail(path, `"${humanReviewStep}" is a reserved step keyword, not an agent`)
    if (agentAliases[name]) v.fail(path, `"${name}" is an alias of the built-in agent "${agentAliases[name]}"; use that name to override it`)
    if (name.endsWith(readOnlyAgentSuffix)) v.fail(path, `agent names can't end in "${readOnlyAgentSuffix}"; that suffix is reserved for wopr's forced-read-only variants`)

    const entry = v.record(value, path)
    v.knownKeys(entry, path, ["description", "model", "temperature", "readOnly"])

    const agent: ConfigAgent = {}
    if (entry.description !== undefined) agent.description = v.nonEmptyString(entry.description, `${path}.description`)
    if (entry.model !== undefined) agent.model = v.model(entry.model, `${path}.model`)
    if (entry.temperature !== undefined) agent.temperature = v.temperature(entry.temperature, `${path}.temperature`)
    if (entry.readOnly !== undefined) agent.readOnly = v.boolean(entry.readOnly, `${path}.readOnly`)

    // Project agents bring their own prompt; built-in overrides keep theirs
    // (optionally replaced via the same path). Fail at load, not mid-run.
    const builtIn = builtInAgents.some((candidate) => candidate.name === name)
    if (!builtIn && !isFile(projectAgentPromptPath(name, targetDir))) {
      v.fail(path, `agent "${name}" needs a prompt at .wopr/agents/${name}.md`)
    }

    agents[name] = agent
  }
  return agents
}

function validatePipelines(v: Validator, raw: unknown): Record<string, PipelineSpec> {
  const record = v.record(raw, "pipelines")
  const pipelines: Record<string, PipelineSpec> = {}

  for (const [name, value] of Object.entries(record)) {
    const path = `pipelines.${name}`
    const entry = v.record(value, path)
    v.knownKeys(entry, path, ["description", "steps", "budget"])

    if (!Array.isArray(entry.steps) || entry.steps.length === 0) v.fail(`${path}.steps`, "must be a non-empty list of steps")
    const steps = (entry.steps as unknown[]).map((step, index) => validateStep(v, step, `${path}.steps[${index}]`))

    pipelines[name] = {
      ...(entry.description !== undefined ? { description: v.nonEmptyString(entry.description, `${path}.description`) } : {}),
      ...(entry.budget !== undefined ? { budget: validateBudget(v, entry.budget, `${path}.budget`) } : {}),
      steps,
    }
  }
  return pipelines
}

function validateStep(v: Validator, raw: unknown, path: string, context: { insideParallel?: boolean } = {}): StepSpec {
  if (typeof raw === "string") {
    if (!raw.trim()) v.fail(path, "step name can't be empty")
    if (context.insideParallel && raw.trim() === humanReviewStep) v.fail(path, `"${humanReviewStep}" can't run inside a parallel block`)
    return raw
  }

  const record = v.record(raw, path)

  if ("parallel" in record) {
    if (context.insideParallel) v.fail(path, "parallel blocks can't be nested")
    v.knownKeys(record, path, ["parallel"])
    if (!Array.isArray(record.parallel) || record.parallel.length === 0) v.fail(`${path}.parallel`, "must be a non-empty list of steps")
    const members = (record.parallel as unknown[]).map((step, index) => validateStep(v, step, `${path}.parallel[${index}]`, { insideParallel: true }))
    return { parallel: members as (string | AgentStepSpec)[] }
  }

  if ("type" in record) {
    if (context.insideParallel) v.fail(path, "human steps can't run inside a parallel block")
    v.knownKeys(record, path, ["type", "name", "description"])
    if (record.type !== humanStepType) v.fail(`${path}.type`, `must be "${humanStepType}"`)
    const step: HumanStepSpec = { type: humanStepType }
    if (record.name !== undefined) step.name = v.nonEmptyString(record.name, `${path}.name`)
    if (record.description !== undefined) step.description = v.nonEmptyString(record.description, `${path}.description`)
    return step
  }

  v.knownKeys(record, path, ["agent", "name", "model", "models", "maxAttempts", "reports", "diff"])

  const agent = v.nonEmptyString(record.agent, `${path}.agent`)
  if (context.insideParallel && agent === humanReviewStep) v.fail(path, `"${humanReviewStep}" can't run inside a parallel block`)
  if (record.model !== undefined && record.models !== undefined) v.fail(path, `set either "model" or "models", not both`)

  let models: string[] | undefined
  if (record.models !== undefined) {
    models = v.stringArray(record.models, `${path}.models`)
    if (models.length < 2) v.fail(`${path}.models`, `must have at least 2 entries; use "model" for a single model`)
    models.forEach((model, index) => v.model(model, `${path}.models[${index}]`))
  }

  return {
    agent,
    ...(record.name !== undefined ? { name: v.nonEmptyString(record.name, `${path}.name`) } : {}),
    ...(record.model !== undefined ? { model: v.model(record.model, `${path}.model`) } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(record.maxAttempts !== undefined ? { maxAttempts: v.positiveInt(record.maxAttempts, `${path}.maxAttempts`) } : {}),
    ...(record.reports !== undefined ? { reports: validateReports(v, record.reports, `${path}.reports`) } : {}),
    ...(record.diff !== undefined ? { diff: v.boolean(record.diff, `${path}.diff`) } : {}),
  }
}

function validateBudget(v: Validator, raw: unknown, path: string): Budget {
  const record = v.record(raw, path)
  v.knownKeys(record, path, ["perRun", "onExceed", "perPhase"])

  const perRun = v.positiveNumber(record.perRun, `${path}.perRun`)
  const budget: Budget = { perRun }

  if (record.onExceed !== undefined) {
    if (record.onExceed !== "abort" && record.onExceed !== "warn-and-continue") {
      v.fail(`${path}.onExceed`, 'must be "abort" or "warn-and-continue"')
    }
    budget.onExceed = record.onExceed
  }

  if (record.perPhase !== undefined) {
    const pp = v.record(record.perPhase, `${path}.perPhase`)
    const perPhase: Record<string, number> = {}
    for (const [key, value] of Object.entries(pp)) {
      perPhase[key] = v.positiveNumber(value, `${path}.perPhase.${key}`)
    }
    budget.perPhase = perPhase
  }

  return budget
}

function validateReports(v: Validator, raw: unknown, path: string): "previous" | "all" | "none" | string[] {
  if (raw === "previous" || raw === "all" || raw === "none") return raw
  if (Array.isArray(raw)) return v.stringArray(raw, path)
  return v.fail(path, `must be "previous", "all", "none", or a list of step names`)
}

function validateApprovals(v: Validator, raw: unknown): ApprovalsConfig {
  const record = v.record(raw, "approvals")
  v.knownKeys(record, "approvals", ["topic", "timeoutSeconds", "onTimeout"])

  if (record.topic === undefined) v.fail("approvals.topic", "is required when approvals is configured")

  const rawTopic = v.nonEmptyString(record.topic, "approvals.topic")
  let topic: NtfyTarget
  try {
    const parsed = parseNotificationUrl(rawTopic)
    if (parsed.kind !== "ntfy") v.fail("approvals.topic", "must be an ntfy URL")
    topic = parsed as NtfyTarget
  } catch (error) {
    throw new ConfigError(`approvals.topic: ${error instanceof Error ? error.message : String(error)}`)
  }

  const timeoutSeconds = record.timeoutSeconds !== undefined
    ? v.positiveInt(record.timeoutSeconds, "approvals.timeoutSeconds")
    : 300

  let onTimeout: "reject" | "allow-once" = "reject"
  if (record.onTimeout !== undefined) {
    if (record.onTimeout !== "reject" && record.onTimeout !== "allow-once") {
      v.fail("approvals.onTimeout", 'must be "reject" or "allow-once"')
    }
    onTimeout = record.onTimeout
  }

  return { topic, timeoutSeconds, onTimeout }
}

function validatePermissions(v: Validator, raw: unknown): PermissionAdditions {
  const record = v.record(raw, "permissions")
  if (record.yolo !== undefined) v.fail("permissions.yolo", "is not supported: a repo must not grant itself permissions; --yolo is per-invocation only")
  v.knownKeys(record, "permissions", ["allow", "deny"])

  return {
    allow: record.allow !== undefined ? v.stringArray(record.allow, "permissions.allow") : [],
    deny: record.deny !== undefined ? v.stringArray(record.deny, "permissions.deny") : [],
  }
}

function validateHooks(v: Validator, raw: unknown): HooksConfig {
  const record = v.record(raw, "hooks")
  v.knownKeys(record, "hooks", ["pre", "post", "pipelines"])

  const hooks: HooksConfig = {
    pre: record.pre !== undefined ? validateHookList(v, record.pre, "hooks.pre", "pre") : [],
    post: record.post !== undefined ? validateHookList(v, record.post, "hooks.post", "post") : [],
    pipelines: {},
  }

  if (record.pipelines !== undefined) {
    const pipelines = v.record(record.pipelines, "hooks.pipelines")
    for (const [pipeline, value] of Object.entries(pipelines)) {
      if (!pipeline.trim()) v.fail("hooks.pipelines", "pipeline name can't be empty")
      const path = `hooks.pipelines.${pipeline}`
      hooks.pipelines[pipeline] = validateHookSet(v, value, path)
    }
  }

  return hooks
}

function validateHookSet(v: Validator, raw: unknown, path: string): HookSet {
  const record = v.record(raw, path)
  v.knownKeys(record, path, ["pre", "post"])
  return {
    pre: record.pre !== undefined ? validateHookList(v, record.pre, `${path}.pre`, "pre") : [],
    post: record.post !== undefined ? validateHookList(v, record.post, `${path}.post`, "post") : [],
  }
}

function validateHookList(v: Validator, raw: unknown, path: string, stage: "pre" | "post"): HookSpec[] {
  if (!Array.isArray(raw)) v.fail(path, "must be a list of hook commands")
  return raw.map((entry, index) => validateHook(v, entry, `${path}[${index}]`, stage))
}

function validateHook(v: Validator, raw: unknown, path: string, stage: "pre" | "post"): HookSpec {
  if (typeof raw === "string") return { command: v.nonEmptyString(raw, path) }

  const record = v.record(raw, path)
  v.knownKeys(record, path, stage === "post" ? ["name", "command", "when", "continueOnError", "timeoutSeconds", "cwd"] : ["name", "command", "continueOnError", "timeoutSeconds", "cwd"])

  const hook: HookSpec = { command: v.nonEmptyString(record.command, `${path}.command`) }
  if (record.name !== undefined) hook.name = v.nonEmptyString(record.name, `${path}.name`)
  if (stage === "post" && record.when !== undefined) hook.when = validateHookWhen(v, record.when, `${path}.when`)
  if (record.continueOnError !== undefined) hook.continueOnError = v.boolean(record.continueOnError, `${path}.continueOnError`)
  if (record.timeoutSeconds !== undefined) hook.timeoutSeconds = v.positiveInt(record.timeoutSeconds, `${path}.timeoutSeconds`)
  if (record.cwd !== undefined) {
    if (record.cwd !== "target" && record.cwd !== "run") v.fail(`${path}.cwd`, 'must be "target" or "run"')
    hook.cwd = record.cwd
  }
  return hook
}

function validateHookWhen(v: Validator, raw: unknown, path: string): HookWhen {
  if (raw === "success" || raw === "failure" || raw === "always") return raw
  return v.fail(path, 'must be "success", "failure", or "always"')
}

/** Built-in agents plus the project's additions and overrides. */
export function buildAgentRegistry(config?: WoprConfig): AgentSpec[] {
  const registry: AgentSpec[] = builtInAgents.map((agent) => ({ ...agent }))
  if (!config) return registry

  for (const [name, agent] of Object.entries(config.agents)) {
    const existing = registry.find((candidate) => candidate.name === name)
    if (existing) {
      if (agent.description !== undefined) existing.description = agent.description
      if (agent.model !== undefined) existing.model = agent.model
      if (agent.temperature !== undefined) existing.temperature = agent.temperature
      if (agent.readOnly !== undefined) existing.readOnly = agent.readOnly
      continue
    }
    registry.push({
      name,
      description: agent.description ?? `Project agent ${name}`,
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.readOnly !== undefined ? { readOnly: agent.readOnly } : {}),
      builtIn: false,
    })
  }
  return registry
}

/** Project pipelines shadow built-ins of the same name (including "implement", the default). */
export function selectPipelineSpec(config: WoprConfig | undefined, name: string): PipelineSpec {
  const spec = config?.pipelines[name] ?? builtInPipelines[name]
  if (spec) return spec
  const available = [...new Set([...Object.keys(builtInPipelines), ...Object.keys(config?.pipelines ?? {})])].sort()
  throw new ConfigError(`unknown pipeline "${name}" (available: ${available.join(", ")})`)
}

/** True when a string is a valid `provider/model` or `provider/model#variant`. Shared by config validation and the config TUI. */
export function isValidModelString(value: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false
  try {
    const { model } = splitModelVariant(value)
    const provider = model.split("/")[0]
    const rest = model.split("/").slice(1).join("/")
    return Boolean(provider && rest)
  } catch {
    return false
  }
}

/** Serializes a config back to YAML, omitting empty sections, with `version: 1` first. Comments are not preserved. */
export function serializeWoprConfig(config: WoprConfig): string {
  const out: Record<string, unknown> = { version: 1 }
  if (Object.keys(config.defaults).length > 0) out.defaults = config.defaults
  if (Object.keys(config.agents).length > 0) out.agents = config.agents
  if (Object.keys(config.pipelines).length > 0) out.pipelines = config.pipelines
  const permissions: Record<string, string[]> = {}
  if (config.permissions.allow.length > 0) permissions.allow = config.permissions.allow
  if (config.permissions.deny.length > 0) permissions.deny = config.permissions.deny
  if (Object.keys(permissions).length > 0) out.permissions = permissions
  const hooks = serializeHooks(config.hooks)
  if (hooks) out.hooks = hooks
  if (config.attachments.length > 0) out.attachments = config.attachments
  if (config.approvals !== undefined) {
    const a = config.approvals
    const authPart = a.topic.auth ? `${a.topic.auth.user}:${a.topic.auth.pass}@` : ""
    let topicUrl: string
    if (a.topic.server === "https://ntfy.sh") {
      topicUrl = `ntfy://${authPart}${a.topic.topic}`
    } else {
      topicUrl = `ntfy://${authPart}${a.topic.server}/${a.topic.topic}`
    }
    const serialized: Record<string, unknown> = { topic: topicUrl }
    if (a.timeoutSeconds !== 300) serialized.timeoutSeconds = a.timeoutSeconds
    if (a.onTimeout !== "reject") serialized.onTimeout = a.onTimeout
    out.approvals = serialized
  }
  if (config.notifications.length > 0) {
    // Serialize targets back as URLs for readability
    out.notifications = config.notifications.map((target) => {
      if (target.kind !== "ntfy") return ""
      const authPart = target.auth ? `${target.auth.user}:${target.auth.pass}@` : ""
      // ntfy.sh is the default server; write the shorthand form when it matches
      if (target.server === "https://ntfy.sh") return `ntfy://${authPart}${target.topic}`
      return `ntfy://${authPart}${target.server}/${target.topic}`
    })
  }
  return Bun.YAML.stringify(out, null, 2)
}

function serializeHooks(hooks: HooksConfig): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (hooks.pre.length > 0) out.pre = hooks.pre
  if (hooks.post.length > 0) out.post = hooks.post

  const pipelines: Record<string, unknown> = {}
  for (const [name, set] of Object.entries(hooks.pipelines)) {
    const entry: Record<string, unknown> = {}
    if (set.pre.length > 0) entry.pre = set.pre
    if (set.post.length > 0) entry.post = set.post
    if (Object.keys(entry).length > 0) pipelines[name] = entry
  }
  if (Object.keys(pipelines).length > 0) out.pipelines = pipelines
  return Object.keys(out).length > 0 ? out : undefined
}

/** Serializes, validates by re-parsing, then writes. Never persists YAML that wouldn't load back. */
export async function writeWoprConfig(path: string, config: WoprConfig, targetDir: string): Promise<void> {
  const body = serializeWoprConfig(config)
  parseWoprConfig(body, path, targetDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, "utf8")
}

/**
 * Boilerplate written by the config TUI's "initialize" action: the current
 * effective defaults plus the built-in `implement` pipeline expanded so it stays
 * editable. Agent model preferences that differ from defaults.model are inlined
 * on their steps, because defaults.model would otherwise shadow them.
 */
export function defaultConfigTemplate(): WoprConfig {
  const globalModel = `${defaultGptModel}#${defaultGptVariant}`
  return {
    defaults: { model: globalModel, maxAttempts: 2 },
    agents: {},
    pipelines: { implement: templatePipeline(builtInPipelines[defaultPipelineName]!, globalModel) },
    permissions: { allow: [], deny: [] },
    hooks: emptyHooksConfig(),
    attachments: [],
    notifications: [],
    approvals: undefined,
  }
}

function templatePipeline(spec: PipelineSpec, globalModel: string): PipelineSpec {
  const steps = spec.steps.map<StepSpec>((raw) => templateStep(raw, globalModel))
  return { ...(spec.description ? { description: spec.description } : {}), steps }
}

function templateStep(raw: StepSpec, globalModel: string): StepSpec {
  if (typeof raw === "object" && raw !== null && "parallel" in raw) {
    return { parallel: raw.parallel.map((inner) => templateStep(inner, globalModel) as string | AgentStepSpec) }
  }
  if (isLoopSpec(raw)) {
    const inner = raw.loop
    return {
      loop: {
        ...inner,
        plan: templateStep(inner.plan, globalModel) as string | AgentStepSpec,
        implement: inner.implement.map((member) => templateStep(member, globalModel) as string | AgentStepSpec),
        validate: templateStep(inner.validate, globalModel) as string | AgentStepSpec,
      },
    }
  }
  if (isHumanStepSpec(raw) || raw === humanReviewStep) return raw
  const step = typeof raw === "string" ? { agent: raw } : { ...raw }
  if (step.agent === humanReviewStep) return step.agent
  const agent = builtInAgents.find((candidate) => candidate.name === (agentAliases[step.agent] ?? step.agent))
  const preferred = agent?.defaultModel
  const hasStepModel = step.model !== undefined || step.models !== undefined
  const withModel = !hasStepModel && preferred && preferred !== globalModel ? { ...step, model: preferred } : step
  // Collapse a bare { agent } back to its string shorthand for clean YAML.
  return Object.keys(withModel).length === 1 ? withModel.agent : withModel
}

class Validator {
  constructor(private readonly source: string) {}

  fail(path: string, message: string): never {
    throw new ConfigError(`${this.source}: ${path ? `${path} ` : ""}${message}`)
  }

  record(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) this.fail(path, "must be a mapping")
    return value as Record<string, unknown>
  }

  knownKeys(record: Record<string, unknown>, path: string, known: string[]) {
    for (const key of Object.keys(record)) {
      if (known.includes(key)) continue
      log.warn(`${this.source}: ignoring unknown key ${path ? `${path}.` : ""}${key}`)
    }
  }

  nonEmptyString(value: unknown, path: string): string {
    if (typeof value !== "string" || !value.trim()) this.fail(path, "must be a non-empty string")
    return value
  }

  positiveInt(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) this.fail(path, "must be a positive integer")
    return value
  }

  positiveNumber(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) this.fail(path, "must be a positive number")
    return value
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") this.fail(path, "must be true or false")
    return value
  }

  temperature(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) this.fail(path, "must be a number between 0 and 2")
    return value
  }

  model(value: unknown, path: string): string {
    const text = this.nonEmptyString(value, path)
    if (!isValidModelString(text)) this.fail(path, `must look like provider/model or provider/model#variant, got "${text}"`)
    return text
  }

  stringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) this.fail(path, "must be a list of strings")
    return (value as unknown[]).map((item, index) => this.nonEmptyString(item, `${path}[${index}]`))
  }
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
