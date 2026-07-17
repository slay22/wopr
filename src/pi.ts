import "./polyfills"

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent"
import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai/compat"

import { log } from "./log"

// pi has no server/multi-session process like OpenCode; each phase is an
// in-process AgentSession. This module owns the shared model registry + auth and
// the session-construction seam that the rest of archer drives.

export type ModelSelection = { providerID: string; modelID: string; variant?: string }

// pi built-in tool names. OpenCode's read/list/glob/grep/webfetch map onto pi's
// read/grep/find/ls; pi has no webfetch/websearch/task built-ins (dropped for MVP).
export const writableToolNames = ["read", "grep", "find", "ls", "edit", "write", "bash"]
export const readOnlyToolNames = ["read", "grep", "find", "ls"]

let runtime: { authStorage: AuthStorage; modelRegistry: ModelRegistry; agentDir: string } | undefined

/** Shared pi runtime: auth + model registry, resolved from pi's ~/.pi/agent dir. */
export function piRuntime() {
  if (runtime) return runtime
  const agentDir = getAgentDir()
  const authStorage = AuthStorage.create()
  const modelRegistry = ModelRegistry.create(authStorage)
  runtime = { authStorage, modelRegistry, agentDir }
  return runtime
}

const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"])

/**
 * OpenCode's `#variant` maps onto pi's reasoning effort (`thinkingLevel`). Archer's
 * variant names (xhigh/high/low/…) are already pi's level names, so it's a direct
 * lookup; an unrecognized variant is warned and ignored (no thinking level applied).
 */
export function variantToThinkingLevel(variant?: string): ThinkingLevel | undefined {
  if (!variant) return undefined
  if (thinkingLevels.has(variant as ThinkingLevel)) return variant as ThinkingLevel
  log.warn(`unknown model variant "#${variant}"; pi thinking levels are ${[...thinkingLevels].join("/")} — ignoring`)
  return undefined
}

/** Resolve a `provider/model` selection to a pi Model (the variant is a thinking level, not part of the model id). */
export function resolveModel(selection: ModelSelection): Model<any> {
  const model = piRuntime().modelRegistry.find(selection.providerID, selection.modelID)
  if (!model) {
    throw new Error(
      `unknown model ${selection.providerID}/${selection.modelID}; check it exists in pi's catalog and that auth is configured (pi login / models.json)`,
    )
  }
  return model
}

export type PhaseSessionInput = {
  cwd: string
  model: ModelSelection
  thinkingLevel?: ThinkingLevel
  /** Full system prompt for the agent (agent prompt + runtime-safety appendix). */
  systemPrompt: string
  toolNames: string[]
  /** Permission gate + any other per-run behavior, as pi extensions. */
  extensions?: InlineExtension[]
  /** Persist the session transcript here; omit for in-memory. */
  sessionManager?: SessionManager
}

/** Build (but do not prompt) a pi AgentSession for one pipeline phase. */
export async function createPhaseSession(input: PhaseSessionInput): Promise<AgentSession> {
  const { agentDir } = piRuntime()
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    // Archer supplies the whole agent instruction; don't layer pi's own project
    // context files, skills, or extensions on top of it.
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => input.systemPrompt,
    extensionFactories: input.extensions ?? [],
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    cwd: input.cwd,
    ...pickModel(input.model, input.thinkingLevel),
    tools: input.toolNames,
    resourceLoader,
    sessionManager: input.sessionManager ?? SessionManager.inMemory(input.cwd),
    modelRegistry: piRuntime().modelRegistry,
    authStorage: piRuntime().authStorage,
  })
  return session
}

function pickModel(selection: ModelSelection, thinkingLevel?: ThinkingLevel) {
  // Explicit thinkingLevel wins; otherwise derive it from the selection's variant.
  const level = thinkingLevel ?? variantToThinkingLevel(selection.variant)
  return {
    model: resolveModel(selection),
    ...(level ? { thinkingLevel: level } : {}),
  }
}

/**
 * Run a single stateless read-only prompt to completion and return the
 * assistant's text. Used by the safety judge and branch namer, which classify /
 * name — they never edit. Always disposes the throwaway session.
 */
export async function runReadOnlyPrompt(input: {
  cwd: string
  model: ModelSelection
  systemPrompt: string
  userText: string
  signal?: AbortSignal
  toolNames?: string[]
}): Promise<string> {
  const session = await createPhaseSession({
    cwd: input.cwd,
    model: input.model,
    systemPrompt: input.systemPrompt,
    toolNames: input.toolNames ?? [],
    sessionManager: SessionManager.inMemory(input.cwd),
  })
  try {
    input.signal?.throwIfAborted()
    await session.prompt(input.userText)
    await session.waitForIdle()
    if (session.state.errorMessage) throw new Error(session.state.errorMessage)
    return lastAssistantText(session)
  } finally {
    session.dispose()
  }
}

/** Concatenated text content of the last assistant message, trimmed. */
export function lastAssistantText(session: AgentSession): string {
  const assistant = [...session.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
    | { content?: Array<{ type: string; text?: string }> }
    | undefined
  if (!assistant?.content) return ""
  return assistant.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}
