import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { buildAgentRegistry, loadArcherConfig, parseArcherConfig, selectPipelineSpec, ConfigError } from "../src/config"

const dirs: string[] = []

async function projectDir(config?: string, agentPrompts: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "archer-config-"))
  dirs.push(dir)
  await mkdir(join(dir, ".archer", "agents"), { recursive: true })
  if (config !== undefined) await writeFile(join(dir, ".archer", "config.yaml"), config)
  for (const agent of agentPrompts) {
    await writeFile(join(dir, ".archer", "agents", `${agent}.md`), `# ${agent}\n\nProject prompt.`)
  }
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const parse = (body: string, targetDir = "/tmp/non-existent-archer-target") => parseArcherConfig(body, ".archer/config.yaml", targetDir)

describe("config loading", () => {
  test("no config file means no config", async () => {
    const dir = await projectDir()
    expect(await loadArcherConfig(dir)).toBeUndefined()
  })

  test("an empty file is a valid, empty config", () => {
    const config = parse("")
    expect(config.defaults).toEqual({})
    expect(config.pipelines).toEqual({})
    expect(config.permissions).toEqual({ allow: [], deny: [] })
  })

  test("parses a full project config", async () => {
    const dir = await projectDir(undefined, ["api-reviewer"])
    const config = parse(
      [
        "version: 1",
        "defaults:",
        "  model: openai/gpt-5.5#xhigh",
        "  maxAttempts: 3",
        "  baseRef: develop",
        "  pipeline: quick",
        "agents:",
        "  api-reviewer:",
        "    description: Reviews API consistency",
        "    model: anthropic/claude-opus-4-7",
        "    temperature: 0.1",
        "pipelines:",
        "  quick:",
        "    description: Implementation plus tests",
        "    steps:",
        "      - implementer",
        "      - human-review",
        "      - agent: tests",
        "        maxAttempts: 3",
        "      - agent: api-reviewer",
        "        reports: all",
        "permissions:",
        "  allow:",
        '    - "supabase gen types*"',
        "  deny:",
        '    - "stripe *"',
        "attachments:",
        "  - docs/architecture.md",
      ].join("\n"),
      dir,
    )

    expect(config.defaults).toEqual({ model: "openai/gpt-5.5#xhigh", maxAttempts: 3, baseRef: "develop", pipeline: "quick" })
    expect(config.agents["api-reviewer"]).toEqual({
      description: "Reviews API consistency",
      model: "anthropic/claude-opus-4-7",
      temperature: 0.1,
    })
    expect(config.pipelines.quick?.steps).toEqual([
      "implementer",
      "human-review",
      { agent: "tests", maxAttempts: 3 },
      { agent: "api-reviewer", reports: "all" },
    ])
    expect(config.permissions).toEqual({ allow: ["supabase gen types*"], deny: ["stripe *"] })
    expect(config.attachments).toEqual(["docs/architecture.md"])
  })

  test("rejects configs with errors that point at the offending field", async () => {
    expect(() => parse("version: 2")).toThrow("version")
    expect(() => parse("defaults:\n  maxAttempts: 0")).toThrow("defaults.maxAttempts must be a positive integer")
    expect(() => parse("defaults:\n  model: gpt-5.5")).toThrow("defaults.model must look like provider/model")
    expect(() => parse("pipelines:\n  broken:\n    steps: []")).toThrow("pipelines.broken.steps must be a non-empty list")
    expect(() => parse("pipelines:\n  broken:\n    steps:\n      - agent: tests\n        reports: previous-two")).toThrow(
      'pipelines.broken.steps[0].reports must be "previous", "all", "none", or a list',
    )
    expect(() => parse("not yaml: [unclosed")).toThrow("invalid YAML")
  })

  test("a repo cannot grant itself yolo", () => {
    expect(() => parse("permissions:\n  yolo: true")).toThrow("--yolo is per-invocation only")
  })

  test("project agents must bring a prompt file", async () => {
    const without = await projectDir()
    expect(() => parse("agents:\n  ghost: {}", without)).toThrow("needs a prompt at .archer/agents/ghost.md")

    const withPrompt = await projectDir(undefined, ["ghost"])
    expect(() => parse("agents:\n  ghost: {}", withPrompt)).not.toThrow()
  })

  test("built-in overrides don't need a prompt, aliases and reserved names are rejected", async () => {
    const dir = await projectDir()
    expect(() => parse("agents:\n  design-polisher:\n    model: openai/gpt-5.5", dir)).not.toThrow()
    expect(() => parse("agents:\n  design:\n    model: openai/gpt-5.5", dir)).toThrow('alias of the built-in agent "design-polisher"')
    expect(() => parse("agents:\n  human-review: {}", dir)).toThrow("reserved step keyword")
  })
})

describe("agent registry", () => {
  test("merges built-in overrides and appends project agents", async () => {
    const dir = await projectDir(undefined, ["api-reviewer"])
    const config = parse(
      ["agents:", "  design-polisher:", "    model: openai/gpt-5.5#xhigh", "    temperature: 0.5", "  api-reviewer:", "    description: Reviews APIs"].join("\n"),
      dir,
    )

    const registry = buildAgentRegistry(config)
    const design = registry.find((agent) => agent.name === "design-polisher")
    expect(design).toMatchObject({ model: "openai/gpt-5.5#xhigh", temperature: 0.5, builtIn: true })
    // The built-in preference survives underneath the override.
    expect(design?.defaultModel).toBe("anthropic/claude-opus-4-7")

    const custom = registry.find((agent) => agent.name === "api-reviewer")
    expect(custom).toMatchObject({ description: "Reviews APIs", builtIn: false })
  })

  test("without config the registry is exactly the built-ins", () => {
    expect(buildAgentRegistry(undefined).map((agent) => agent.name)).toEqual([
      "implementer",
      "pattern-auditor",
      "security-auditor",
      "design-polisher",
      "test-engineer",
      "adversarial-reviewer",
    ])
  })
})

describe("pipeline selection", () => {
  test("project pipelines shadow built-ins; unknown names list what exists", async () => {
    const dir = await projectDir()
    const config = parse("pipelines:\n  quick:\n    steps:\n      - implementer\n  default:\n    steps:\n      - tests", dir)

    expect(selectPipelineSpec(config, "quick").steps).toEqual(["implementer"])
    expect(selectPipelineSpec(config, "default").steps).toEqual(["tests"])
    expect(selectPipelineSpec(undefined, "default").steps.length).toBeGreaterThan(1)
    expect(() => selectPipelineSpec(config, "ghost")).toThrow('unknown pipeline "ghost" (available: default, quick)')
    expect(() => selectPipelineSpec(config, "ghost")).toThrow(ConfigError)
  })
})
