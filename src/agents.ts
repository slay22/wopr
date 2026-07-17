import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { builtInPrompts } from "./built-in-prompts"
import { readOnlyToolNames, writableToolNames } from "./pi"
import { readOnlyAgentSuffix } from "./pipeline"
import { globalAgentsDir } from "./workspace"

const runtimeSafetyPrompt = "runtime-safety"

/** pi built-in tools a phase gets, gated by whether the agent is read-only. */
export function agentToolNames(readOnly?: boolean): string[] {
  return readOnly ? readOnlyToolNames : writableToolNames
}

/** Strip the synthesized "__ro" suffix so read-only variants share the base prompt. */
export function basePromptName(agentName: string): string {
  return agentName.endsWith(readOnlyAgentSuffix) ? agentName.slice(0, -readOnlyAgentSuffix.length) : agentName
}

export function loadAgentPrompt(agentName: string, targetDir = process.cwd()) {
  // Precedence mirrors config merge: project override > global override > built-in.
  const agentPrompt = readProjectAgentPrompt(agentName, targetDir) ?? readGlobalAgentPrompt(agentName) ?? readBuiltInPrompt(agentName)
  const safetyPrompt = readBuiltInPrompt(runtimeSafetyPrompt)
  return [agentPrompt.trimEnd(), "", "---", "", safetyPrompt.trim()].join("\n")
}

export function projectAgentPromptPath(agentName: string, targetDir: string) {
  return join(targetDir, ".wopr", "agents", `${agentName}.md`)
}

function readProjectAgentPrompt(agentName: string, targetDir: string) {
  const path = projectAgentPromptPath(agentName, targetDir)
  if (!isFile(path)) return undefined
  return readFileSync(path, "utf8")
}

function readGlobalAgentPrompt(agentName: string) {
  const path = join(globalAgentsDir(), `${agentName}.md`)
  if (!isFile(path)) return undefined
  return readFileSync(path, "utf8")
}

function readBuiltInPrompt(promptName: string) {
  const prompt = builtInPrompts[promptName]
  if (prompt !== undefined) return prompt
  throw new Error(
    `no prompt for "${promptName}": add prompts/${promptName}.md to src/built-in-prompts.ts, or create .wopr/agents/${promptName}.md in the target repo`,
  )
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
