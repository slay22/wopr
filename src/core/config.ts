import { readFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  globalConfigPath,
  loadGlobalWoprConfig,
  loadMergedWoprConfig,
  loadWoprConfig,
  mergeWoprConfigs,
  parseWoprConfig,
  projectConfigPath,
  serializeWoprConfig,
  type WoprConfig,
} from "../config"
import { woprHome, woprRoot } from "../workspace"

import type { ConfigScope, ConfigFormat } from "./types"

export function getConfig(scope?: ConfigScope, targetDir?: string): WoprConfig | undefined {
  const dir = targetDir ?? process.cwd()

  if (!scope || scope === "merged") {
    const project = readConfigFileSync(projectConfigCandidates(dir), dir)
    const global = readConfigFileSync(globalConfigCandidates(), woprRoot())
    return mergeWoprConfigs(global, project)
  }

  if (scope === "global") {
    return readConfigFileSync(globalConfigCandidates(), woprRoot())
  }

  if (scope === "project") {
    return readConfigFileSync(projectConfigCandidates(dir), dir)
  }

  return undefined
}

/** Candidate config file paths (yaml + yml) for a given base path. */
function projectConfigCandidates(dir: string): string[] {
  return [projectConfigPath(dir), join(dir, ".wopr", "config.yml")]
}

function globalConfigCandidates(): string[] {
  return [globalConfigPath(), join(woprHome(), "config.yml")]
}

/** Synchronously read + parse the first existing candidate config file. */
function readConfigFileSync(candidates: string[], targetDir: string): WoprConfig | undefined {
  for (const path of candidates) {
    try {
      const body = readFileSync(path, "utf8")
      return parseWoprConfig(body, path, targetDir)
    } catch {
      // file missing or unreadable; try the next candidate
    }
  }
  return undefined
}

/** Async version of getConfig that properly loads config from disk. */
export async function getConfigAsync(scope?: ConfigScope, targetDir?: string): Promise<WoprConfig | undefined> {
  const dir = targetDir ?? process.cwd()

  if (!scope || scope === "merged") {
    return loadMergedWoprConfig(dir)
  }

  if (scope === "global") {
    return loadGlobalWoprConfig()
  }

  if (scope === "project") {
    return loadWoprConfig(dir)
  }

  return undefined
}

export function validateConfig(yaml: string, targetDir?: string): { ok: true } | { ok: false; errors: string[] } {
  try {
    const dir = targetDir ?? process.cwd()
    parseWoprConfig(yaml, "config.yaml", dir)
    return { ok: true }
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }
}

export function diffConfig(
  scope: ConfigScope,
  proposedYaml: string,
  targetDir?: string,
): { ok: true; scope: ConfigScope; path: string; before: string; after: string; added: string[]; removed: string[]; changed: string[] } | { ok: false; errors: string[] } {
  const dir = targetDir ?? process.cwd()

  // Validate the proposed YAML first
  const validation = validateConfig(proposedYaml, dir)
  if (!validation.ok) return validation

  // Determine the config path
  let path: string
  if (scope === "global") {
    path = globalConfigPath()
  } else {
    path = projectConfigPath(dir)
  }

  // Read existing config
  let before = ""
  try {
    before = readFileSync(path, "utf8")
  } catch {
    before = "# no existing config\n"
  }

  // Simple line-based diff analysis
  const beforeLines = before.split("\n")
  const afterLines = proposedYaml.split("\n")

  const beforeSet = new Set(beforeLines.map((l) => l.trim()).filter(Boolean))
  const afterSet = new Set(afterLines.map((l) => l.trim()).filter(Boolean))

  const added = [...afterSet].filter((l) => !beforeSet.has(l))
  const removed = [...beforeSet].filter((l) => !afterSet.has(l))
  // "changed" lines are those present in both but with different content
  const changed: string[] = []

  return {
    ok: true as const,
    scope,
    path,
    before,
    after: proposedYaml,
    added,
    removed,
    changed,
  }
}

/** Async version of diffConfig that properly reads the existing config file. */
export async function diffConfigAsync(
  scope: ConfigScope,
  proposedYaml: string,
  targetDir?: string,
): Promise<{ ok: true; scope: ConfigScope; path: string; before: string; after: string; added: string[]; removed: string[]; changed: string[] } | { ok: false; errors: string[] }> {
  const dir = targetDir ?? process.cwd()

  const validation = validateConfig(proposedYaml, dir)
  if (!validation.ok) return validation

  let path: string
  if (scope === "global") {
    path = globalConfigPath()
  } else {
    path = projectConfigPath(dir)
  }

  let before = ""
  try {
    before = await readFile(path, "utf8")
  } catch {
    before = "# no existing config\n"
  }

  const beforeLines = before.split("\n")
  const afterLines = proposedYaml.split("\n")

  const beforeSet = new Set(beforeLines.map((l) => l.trim()).filter(Boolean))
  const afterSet = new Set(afterLines.map((l) => l.trim()).filter(Boolean))

  const added = [...afterSet].filter((l) => !beforeSet.has(l))
  const removed = [...beforeSet].filter((l) => !afterSet.has(l))
  const changed: string[] = []

  return {
    ok: true as const,
    scope,
    path,
    before,
    after: proposedYaml,
    added,
    removed,
    changed,
  }
}

export async function setConfig(
  scope: ConfigScope,
  yaml: string,
  options?: { validateOnly?: boolean; targetDir?: string; format?: ConfigFormat },
): Promise<{ ok: true; path: string } | { ok: false; errors: string[] }> {
  const dir = options?.targetDir ?? process.cwd()

  // Validate first
  const validation = validateConfig(yaml, dir)
  if (!validation.ok) return validation

  // If validate only, return success without writing
  if (options?.validateOnly) {
    const path = scope === "global" ? globalConfigPath() : projectConfigPath(dir)
    return { ok: true, path }
  }

  // Write the config
  try {
    const path = scope === "global" ? globalConfigPath() : projectConfigPath(dir)
    // Pretty-print the YAML through our serializer to ensure it's valid
    // by parsing then re-serializing.
    const parsed = parseWoprConfig(yaml, path, dir)
    const serialized = serializeWoprConfig(parsed)
    await writeFile(path, serialized, "utf8")
    return { ok: true, path }
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }
}
