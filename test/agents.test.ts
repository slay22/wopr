import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { agentToolNames, basePromptName, loadAgentPrompt } from "../src/agents"
import { builtInPrompts } from "../src/built-in-prompts"
import { readOnlyToolNames, writableToolNames } from "../src/pi"

describe("agent tools", () => {
  test("read-only agents get read tools only; writable agents get edit/write/bash", () => {
    expect(agentToolNames(true)).toEqual(readOnlyToolNames)
    expect(agentToolNames(false)).toEqual(writableToolNames)
    expect(agentToolNames()).toEqual(writableToolNames)

    // Read-only phases have no way to change the repo.
    for (const tool of ["edit", "write", "bash"]) {
      expect(readOnlyToolNames).not.toContain(tool)
    }
    expect(writableToolNames).toContain("bash")
  })

  test("__ro-suffixed variants resolve to the base agent's prompt name", () => {
    expect(basePromptName("clean-code__ro")).toBe("clean-code")
    expect(basePromptName("implementer")).toBe("implementer")
  })
})

describe("agent prompts", () => {
  test("embedded built-in prompts stay in sync with the prompts/ directory", async () => {
    const files = (await readdir(join(import.meta.dir, "..", "prompts")))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -".md".length))
      .sort()

    expect(Object.keys(builtInPrompts).sort()).toEqual(files)
  })

  test("loads built-in markdown prompts with runtime safety guard rails", () => {
    const prompt = loadAgentPrompt("implementer", "/tmp/non-existent-archer-target")

    expect(prompt).toContain("# Implementer")
    expect(prompt).toContain("# Archer Runtime Safety")
    expect(prompt).toContain("not replaceable")
  })

  test("project agent prompts replace built-ins but keep runtime safety", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-agents-"))
    try {
      await mkdir(join(dir, ".archer", "agents"), { recursive: true })
      await writeFile(join(dir, ".archer", "agents", "implementer.md"), "# Custom Implementer\n\nProject-specific prompt.")

      const prompt = loadAgentPrompt("implementer", dir)

      expect(prompt.startsWith("# Custom Implementer")).toBe(true)
      expect(prompt).toContain("Project-specific prompt.")
      expect(prompt).not.toContain("# Implementer\n\nYou are the **implementer**")
      expect(prompt).toContain("# Archer Runtime Safety")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a synthesized forced-read-only agent (__ro suffix) shares the base agent's prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archer-ro-variant-"))
    try {
      await mkdir(join(dir, ".archer", "agents"), { recursive: true })
      await writeFile(join(dir, ".archer", "agents", "clean-code.md"), "# Clean Code\n\nLook for unnecessary complexity.")

      const prompt = loadAgentPrompt(basePromptName("clean-code__ro"), dir)
      expect(prompt).toContain("# Clean Code")
      expect(prompt).toContain("Look for unnecessary complexity.")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("project agents need a prompt file", () => {
    expect(() => loadAgentPrompt("ghost", "/tmp/non-existent-archer-target")).toThrow(".archer/agents/ghost.md")
  })
})
