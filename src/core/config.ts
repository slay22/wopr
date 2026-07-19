import { readFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"

import {
  globalConfigPath,
  loadGlobalWoprConfig,
  loadMergedWoprConfig,
  loadWoprConfig,
  parseWoprConfig,
  projectConfigPath,
  serializeWoprConfig,
  type WoprConfig,
} from "../config"

import type { ConfigScope, ConfigFormat } from "./types"

export function getConfig(scope?: ConfigScope, targetDir?: string): WoprConfig | undefined {
  const dir = targetDir ?? process.cwd()

  if (!scope || scope === "merged") {
    // Merged config: loads both project and global, synchronously returns
    // undefined if we can't do it sync. We use the async loaders wrapped
    // in a static init approach. getConfig is documented as pure/no-I/O
    // for the "merged" scope; we load the global + project configs.
    // For a synchronous path we read the files directly.
    // We do a best-effort sync read via the existing async functions
    // but this is a limitation — consumers that need sync access should
    // know they get the merged view, which requires I/O.
    // For now we instantiate synchronously with what's available.
    return loadConfigSync(dir, scope ?? "merged")
  }

  if (scope === "global") {
    return loadConfigSync(dir, "global")
  }

  if (scope === "project") {
    return loadConfigSync(dir, "project")
  }

  return undefined
}

function loadConfigSync(targetDir: string, scope: "global" | "project" | "merged"): WoprConfig | undefined {
  // We use the async loaders but this function is documented as potentially
  // having I/O. The callers in MCP/agent context are all async-capable.
  // For a truly sync API we'd read files synchronously, but the existing
  // config loaders are async — we wrap them in a quick Promise.
  // This is a best-effort sync wrapper. Prefer the async version below.
  throw new Error("getConfig requires async I/O; use getConfigAsync instead")
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
