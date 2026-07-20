import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { woprHome } from "../workspace"

/**
 * Manages the "always-allow" state for a single run. When the user replies
 * "always" to a remote permission prompt, the command pattern is recorded so
 * subsequent prompts for the same pattern are auto-allowed without asking.
 *
 * State is persisted to ~/.wopr/state/always-allow.json so it survives a
 * run being interrupted and resumed. The file is cleaned up when the run
 * completes.
 */
export class AlwaysAllowStore {
  private readonly filePath: string
  private readonly patterns: Set<string>
  private loaded = false

  constructor(runId: string) {
    this.filePath = join(woprHome(), "state", `${runId}-always-allow.json`)
    this.patterns = new Set()
  }

  /**
   * Returns true when the given command pattern has been always-allowed.
   */
  async check(pattern: string): Promise<boolean> {
    if (!this.loaded) await this.load()
    return this.patterns.has(pattern)
  }

  /**
   * Records a command pattern as always-allowed.
   */
  async add(pattern: string): Promise<void> {
    this.patterns.add(pattern)
    await this.save()
  }

  /**
   * Clears all always-allow patterns and removes the state file.
   */
  async clear(): Promise<void> {
    this.patterns.clear()
    try {
      await rm(this.filePath, { force: true })
    } catch {
      // best-effort
    }
  }

  private async load(): Promise<void> {
    this.loaded = true
    try {
      const body = await readFile(this.filePath, "utf8")
      const data = JSON.parse(body)
      if (Array.isArray(data.patterns)) {
        for (const pattern of data.patterns) {
          if (typeof pattern === "string") this.patterns.add(pattern)
        }
      }
    } catch {
      // File doesn't exist or is malformed; start fresh.
    }
  }

  private async save(): Promise<void> {
    await mkdir(join(woprHome(), "state"), { recursive: true })
    const data = { patterns: [...this.patterns] }
    await writeFile(this.filePath, JSON.stringify(data, null, 2))
  }
}
