import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { discoverProjectContextFiles } from "../src/project-context"

describe("project context discovery", () => {
  test("discovers only official WOPR and agent context files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-context-"))
    try {
      await mkdir(join(dir, ".wopr"), { recursive: true })
      await writeFile(join(dir, ".wopr", "rules.md"), "# WOPR rules")
      await writeFile(join(dir, "AGENTS.md"), "# Agents")
      await writeFile(join(dir, "CLAUDE.md"), "# Claude")
      await writeFile(join(dir, ".wopr.rules"), "ignored")
      await writeFile(join(dir, ".rules"), "ignored")

      await expect(discoverProjectContextFiles(dir)).resolves.toEqual([".wopr/rules.md", "AGENTS.md", "CLAUDE.md"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("skips missing context files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-context-"))
    try {
      await writeFile(join(dir, "CLAUDE.md"), "# Claude")

      await expect(discoverProjectContextFiles(dir)).resolves.toEqual(["CLAUDE.md"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
