import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  buildAgentRegistry,
  ConfigError,
  defaultConfigTemplate,
  isValidModelString,
  loadWoprConfig,
  loadGlobalWoprConfig,
  loadMergedWoprConfig,
  mergeWoprConfigs,
  parseWoprConfig,
  selectPipelineSpec,
  serializeWoprConfig,
  writeWoprConfig,
  writeDefaultWoprConfig,
  writeDefaultProjectConfig,
} from "../src/config"
import { builtInAgents, defaultGptModel, defaultGptVariant, defaultImplementReviewModel, defaultOpusModel, isHumanStepSpec, isLoopSpec, isParallelSpec } from "../src/pipeline"

const dirs: string[] = []

async function projectDir(config?: string, agentPrompts: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "wopr-config-"))
  dirs.push(dir)
  await mkdir(join(dir, ".wopr", "agents"), { recursive: true })
  if (config !== undefined) await writeFile(join(dir, ".wopr", "config.yaml"), config)
  for (const agent of agentPrompts) {
    await writeFile(join(dir, ".wopr", "agents", `${agent}.md`), `# ${agent}\n\nProject prompt.`)
  }
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const parse = (body: string, targetDir = "/tmp/non-existent-wopr-target") => parseWoprConfig(body, ".wopr/config.yaml", targetDir)

describe("config loading", () => {
  test("no config file means no config", async () => {
    const dir = await projectDir()
    expect(await loadWoprConfig(dir)).toBeUndefined()
  })

  test("an empty file is a valid, empty config", () => {
    const config = parse("")
    expect(config.defaults).toEqual({})
    expect(config.pipelines).toEqual({})
    expect(config.permissions).toEqual({ allow: [], deny: [] })
    expect(config.hooks).toEqual({ pre: [], post: [], pipelines: {} })
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
        "  branchNameModel: anthropic/claude-haiku-4-5",
        "agents:",
        "  api-reviewer:",
        "    description: Reviews API consistency",
        "    model: anthropic/claude-opus-4-7",
        "    temperature: 0.1",
        "    readOnly: true",
        "pipelines:",
        "  quick:",
        "    description: Implementation plus tests",
        "    steps:",
        "      - implementer",
        "      - type: human",
        "        name: planning",
        "        description: Plan implementation interactively",
        "      - agent: tests",
        "        maxAttempts: 3",
        "      - agent: api-reviewer",
        "        reports: all",
        "permissions:",
        "  allow:",
        '    - "supabase gen types*"',
        "  deny:",
        '    - "stripe *"',
        "hooks:",
        "  pre:",
        "    - pnpm lint",
        "  post:",
        "    - command: ./scripts/notify.sh",
        "      when: always",
        "      continueOnError: true",
        "  pipelines:",
        "    quick:",
        "      post:",
        "        - name: open-pr",
        "          command: gh pr create --fill",
        "          cwd: target",
        "          timeoutSeconds: 120",
        "attachments:",
        "  - docs/architecture.md",
      ].join("\n"),
      dir,
    )

    expect(config.defaults).toEqual({
      model: "openai/gpt-5.5#xhigh",
      maxAttempts: 3,
      baseRef: "develop",
      pipeline: "quick",
      branchNameModel: "anthropic/claude-haiku-4-5",
    })
    expect(config.agents["api-reviewer"]).toEqual({
      description: "Reviews API consistency",
      model: "anthropic/claude-opus-4-7",
      temperature: 0.1,
      readOnly: true,
    })
    expect(config.pipelines.quick?.steps).toEqual([
      "implementer",
      { type: "human", name: "planning", description: "Plan implementation interactively" },
      { agent: "tests", maxAttempts: 3 },
      { agent: "api-reviewer", reports: "all" },
    ])
    expect(config.permissions).toEqual({ allow: ["supabase gen types*"], deny: ["stripe *"] })
    expect(config.hooks).toEqual({
      pre: [{ command: "pnpm lint" }],
      post: [{ command: "./scripts/notify.sh", when: "always", continueOnError: true }],
      pipelines: {
        quick: {
          pre: [],
          post: [{ name: "open-pr", command: "gh pr create --fill", cwd: "target", timeoutSeconds: 120 }],
        },
      },
    })
    expect(config.attachments).toEqual(["docs/architecture.md"])
  })

  test("rejects configs with errors that point at the offending field", async () => {
    expect(() => parse("version: 2")).toThrow("version")
    expect(() => parse("defaults:\n  maxAttempts: 0")).toThrow("defaults.maxAttempts must be a positive integer")
    expect(() => parse("defaults:\n  model: gpt-5.5")).toThrow("defaults.model must look like provider/model")
    expect(() => parse("agents:\n  implementer:\n    readOnly: sometimes")).toThrow("agents.implementer.readOnly must be true or false")
    expect(() => parse("pipelines:\n  broken:\n    steps: []")).toThrow("pipelines.broken.steps must be a non-empty list")
    expect(() => parse("pipelines:\n  broken:\n    steps:\n      - agent: tests\n        reports: previous-two")).toThrow(
      'pipelines.broken.steps[0].reports must be "previous", "all", "none", or a list',
    )
    expect(() => parse("hooks:\n  pre: ./scripts/pre.sh")).toThrow("hooks.pre must be a list")
    expect(() => parse("hooks:\n  post:\n    - command: ./scripts/post.sh\n      when: sometimes")).toThrow('hooks.post[0].when must be "success", "failure", or "always"')
    expect(() => parse("hooks:\n  pre:\n    - command: ./scripts/pre.sh\n      timeoutSeconds: 0")).toThrow("hooks.pre[0].timeoutSeconds must be a positive integer")
    expect(() => parse("not yaml: [unclosed")).toThrow("invalid YAML")
  })

  test("a repo cannot grant itself yolo", () => {
    expect(() => parse("permissions:\n  yolo: true")).toThrow("--yolo is per-invocation only")
  })

  test("project agents must bring a prompt file", async () => {
    const without = await projectDir()
    expect(() => parse("agents:\n  ghost: {}", without)).toThrow("needs a prompt at .wopr/agents/ghost.md")

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

describe("parallel steps and model fan-out", () => {
  test("parses a parallel block with a models fan-out member", async () => {
    const dir = await projectDir(undefined, ["clean-code"])
    const config = parse(
      [
        "pipelines:",
        "  audit:",
        "    steps:",
        "      - implementer",
        "      - parallel:",
        "          - patterns",
        "          - security",
        "          - agent: clean-code",
        "            models:",
        "              - anthropic/claude-opus-4-7",
        "              - openai/gpt-5.5#xhigh",
        "      - agent: adversarial",
        "        name: triage",
        "        reports: all",
      ].join("\n"),
      dir,
    )

    expect(config.pipelines.audit?.steps).toEqual([
      "implementer",
      {
        parallel: [
          "patterns",
          "security",
          { agent: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] },
        ],
      },
      { agent: "adversarial", name: "triage", reports: "all" },
    ])
  })

  test("rejects nested parallel blocks", () => {
    expect(() =>
      parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel:\n          - parallel:\n              - patterns"),
    ).toThrow("nested")
  })

  test("rejects human steps inside a parallel block", () => {
    expect(() => parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel:\n          - patterns\n          - human-review")).toThrow(
      "can't run inside a parallel block",
    )
    expect(() =>
      parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel:\n          - patterns\n          - agent: human-review"),
    ).toThrow("can't run inside a parallel block")
    expect(() =>
      parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel:\n          - patterns\n          - type: human\n            name: planning"),
    ).toThrow("human steps can't run inside a parallel block")
  })

  test("parses generic human steps", () => {
    const config = parse(
      "pipelines:\n  p:\n    steps:\n      - type: human\n        name: planning\n        description: Plan interactively\n      - implementer",
    )
    expect(config.pipelines.p?.steps).toEqual([{ type: "human", name: "planning", description: "Plan interactively" }, "implementer"])
    expect(() => parse("pipelines:\n  p:\n    steps:\n      - type: robot\n      - implementer")).toThrow('type must be "human"')
  })

  test("rejects an empty parallel block", () => {
    expect(() => parse("pipelines:\n  p:\n    steps:\n      - implementer\n      - parallel: []")).toThrow("must be a non-empty list of steps")
  })

  test("rejects models with fewer than 2 entries", () => {
    expect(() =>
      parse("pipelines:\n  p:\n    steps:\n      - agent: implementer\n        models:\n          - anthropic/claude-opus-4-7"),
    ).toThrow("at least 2 entries")
  })

  test("rejects setting both model and models", () => {
    expect(() =>
      parse(
        [
          "pipelines:",
          "  p:",
          "    steps:",
          "      - agent: implementer",
          "        model: anthropic/claude-opus-4-7",
          "        models:",
          "          - anthropic/claude-opus-4-7",
          "          - openai/gpt-5.5#xhigh",
        ].join("\n"),
      ),
    ).toThrow('set either "model" or "models"')
  })

  test("rejects agent names ending in the reserved read-only suffix", () => {
    expect(() => parse("agents:\n  clean-code__ro:\n    model: anthropic/claude-opus-4-7")).toThrow('reserved for wopr\'s forced-read-only variants')
  })

  test("a config with parallel/models round-trips through serialize + reparse", async () => {
    const dir = await projectDir(undefined, ["clean-code"])
    const config = parse(
      [
        "pipelines:",
        "  audit:",
        "    steps:",
        "      - implementer",
        "      - parallel:",
        "          - patterns",
        "          - agent: clean-code",
        "            models:",
        "              - anthropic/claude-opus-4-7",
        "              - openai/gpt-5.5#xhigh",
      ].join("\n"),
      dir,
    )

    const path = join(dir, ".wopr", "config.yaml")
    await writeWoprConfig(path, config, dir)
    const reparsed = parse(await readFile(path, "utf8"), dir)
    expect(reparsed.pipelines).toEqual(config.pipelines)
  })
})

describe("agent registry", () => {
  test("merges built-in overrides and appends project agents", async () => {
    const dir = await projectDir(undefined, ["api-reviewer"])
    const config = parse(
      [
        "agents:",
        "  design-polisher:",
        "    model: openai/gpt-5.5#xhigh",
        "    temperature: 0.5",
        "    readOnly: true",
        "  api-reviewer:",
        "    description: Reviews APIs",
        "    readOnly: true",
      ].join("\n"),
      dir,
    )

    const registry = buildAgentRegistry(config)
    const design = registry.find((agent) => agent.name === "design-polisher")
    expect(design).toMatchObject({ model: "openai/gpt-5.5#xhigh", temperature: 0.5, readOnly: true, builtIn: true })
    // The built-in preference survives underneath the override.
    expect(design?.defaultModel).toBe("anthropic/claude-opus-4-8")

    const custom = registry.find((agent) => agent.name === "api-reviewer")
    expect(custom).toMatchObject({ description: "Reviews APIs", readOnly: true, builtIn: false })
  })

  test("without config the registry is exactly the built-ins", () => {
    expect(buildAgentRegistry(undefined).map((agent) => agent.name)).toEqual([
      "implementer",
      "pattern-auditor",
      "security-auditor",
      "design-polisher",
      "test-engineer",
      "adversarial-reviewer",
      "review-scope",
      "bug-auditor",
      "clean-code-auditor",
      "security-reviewer",
      "review-adversary",
      "review-fixer",
      "review-validator",
      "review-report",
      "implementation-triage",
      "implementation-final-review",
      "implementation-fixer",
      "implementation-validator",
      "planner",
      "loop-validator",
    ])
  })
})

describe("pipeline selection", () => {
  test("project pipelines shadow built-ins; unknown names list what exists", async () => {
    const dir = await projectDir()
    const config = parse("pipelines:\n  quick:\n    steps:\n      - implementer\n  implement:\n    steps:\n      - tests", dir)

    expect(selectPipelineSpec(config, "quick").steps).toEqual(["implementer"])
    expect(selectPipelineSpec(config, "implement").steps).toEqual(["tests"])
    expect(selectPipelineSpec(undefined, "implement").steps.length).toBeGreaterThan(1)
    expect(() => selectPipelineSpec(config, "ghost")).toThrow(
      'unknown pipeline "ghost" (available: converge, implement, implement-lite, quick, refine, review, review-lite, ultra-implement, ultra-refine)',
    )
    expect(() => selectPipelineSpec(config, "ghost")).toThrow(ConfigError)
  })
})

describe("isValidModelString", () => {
  test("accepts provider/model and provider/model#variant, rejects the rest", () => {
    expect(isValidModelString("openai/gpt-5.5")).toBe(true)
    expect(isValidModelString("openai/gpt-5.5#xhigh")).toBe(true)
    expect(isValidModelString("anthropic/claude/opus")).toBe(true)
    expect(isValidModelString("gpt-5.5")).toBe(false)
    expect(isValidModelString("openai/")).toBe(false)
    expect(isValidModelString("")).toBe(false)
  })
})

describe("config merging", () => {
  test("defaults merge shallow by key; project wins", () => {
    const global = parse("defaults:\n  model: openai/gpt-5.5#xhigh\n  maxAttempts: 9\n  branchNameModel: anthropic/claude-haiku-4-5")
    const project = parse("defaults:\n  maxAttempts: 2\n  baseRef: dev\n  branchNameModel: openai/gpt-5.5-mini")
    expect(mergeWoprConfigs(global, project)?.defaults).toEqual({
      model: "openai/gpt-5.5#xhigh",
      maxAttempts: 2,
      baseRef: "dev",
      branchNameModel: "openai/gpt-5.5-mini",
    })
  })

  test("agents and pipelines merge by name; project entry wins wholesale", () => {
    const global = parse("agents:\n  design-polisher:\n    model: openai/gpt-5.5#xhigh\npipelines:\n  default:\n    steps:\n      - tests\n  shared:\n    steps:\n      - implementer")
    const project = parse("agents:\n  design-polisher:\n    temperature: 0.2\npipelines:\n  default:\n    steps:\n      - implementer")
    const merged = mergeWoprConfigs(global, project)!
    expect(merged.agents["design-polisher"]).toEqual({ temperature: 0.2 })
    expect(merged.pipelines.default?.steps).toEqual(["implementer"])
    expect(merged.pipelines.shared?.steps).toEqual(["implementer"])
  })

  test("permissions and attachments concatenate, global first", () => {
    const global = parse("permissions:\n  allow:\n    - 'a'\nattachments:\n  - 'g.md'")
    const project = parse("permissions:\n  allow:\n    - 'b'\n  deny:\n    - 'x'\nattachments:\n  - 'p.md'")
    const merged = mergeWoprConfigs(global, project)!
    expect(merged.permissions).toEqual({ allow: ["a", "b"], deny: ["x"] })
    expect(merged.attachments).toEqual(["g.md", "p.md"])
  })

  test("hooks concatenate globally and per pipeline, global first", () => {
    const global = parse("hooks:\n  pre:\n    - g-pre\n  pipelines:\n    implement:\n      post:\n        - g-impl-post")
    const project = parse("hooks:\n  post:\n    - p-post\n  pipelines:\n    implement:\n      pre:\n        - p-impl-pre\n      post:\n        - p-impl-post")
    const merged = mergeWoprConfigs(global, project)!
    expect(merged.hooks.pre).toEqual([{ command: "g-pre" }])
    expect(merged.hooks.post).toEqual([{ command: "p-post" }])
    expect(merged.hooks.pipelines.implement).toEqual({
      pre: [{ command: "p-impl-pre" }],
      post: [{ command: "g-impl-post" }, { command: "p-impl-post" }],
    })
  })

  test("a missing side passes the other through unchanged", () => {
    const only = parse("defaults:\n  model: openai/gpt-5.5")
    expect(mergeWoprConfigs(undefined, undefined)).toBeUndefined()
    expect(mergeWoprConfigs(only, undefined)).toBe(only)
    expect(mergeWoprConfigs(undefined, only)).toBe(only)
  })
})

describe("serialization", () => {
  test("omits empty sections and round-trips through parse", () => {
    const config = parse("defaults:\n  model: openai/gpt-5.5#xhigh\npipelines:\n  default:\n    steps:\n      - implementer\n      - human-review")
    const yaml = serializeWoprConfig(config)
    expect(yaml).toContain("version: 1")
    expect(yaml).not.toContain("agents")
    expect(yaml).not.toContain("permissions")
    expect(yaml).not.toContain("hooks")
    expect(yaml).not.toContain("attachments")
    const reparsed = parse(yaml)
    expect(reparsed.defaults).toEqual(config.defaults)
    expect(reparsed.pipelines).toEqual(config.pipelines)
  })

  test("serializes hooks and round-trips through parse", () => {
    const config = parse(
      [
        "hooks:",
        "  pre:",
        "    - pnpm lint",
        "  pipelines:",
        "    implement:",
        "      post:",
        "        - command: gh pr create --fill",
        "          when: success",
        "          continueOnError: true",
      ].join("\n"),
    )
    const reparsed = parse(serializeWoprConfig(config))
    expect(reparsed.hooks).toEqual(config.hooks)
  })

  test("defaultConfigTemplate preserves implement step model overrides and round-trips", () => {
    const template = defaultConfigTemplate()
    expect(template.defaults.model).toBe(`${defaultGptModel}#${defaultGptVariant}`)
    const steps = template.pipelines.implement!.steps
    expect(steps.find((step) => typeof step !== "string" && !isParallelSpec(step) && !isLoopSpec(step) && !isHumanStepSpec(step) && step.agent === "design")).toEqual({ agent: "design", model: defaultImplementReviewModel })
    expect(steps.find((step) => typeof step !== "string" && !isParallelSpec(step) && !isLoopSpec(step) && !isHumanStepSpec(step) && step.agent === "adversarial")).toEqual({ agent: "adversarial", model: defaultImplementReviewModel, reports: "all" })
    const reparsed = parse(serializeWoprConfig(template))
    expect(reparsed.defaults).toEqual(template.defaults)
    expect(reparsed.pipelines).toEqual(template.pipelines)
    expect(reparsed.hooks).toEqual(template.hooks)
  })
})

describe("global config", () => {
  let savedHome: string | undefined
  beforeEach(() => {
    savedHome = process.env.WOPR_HOME
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.WOPR_HOME
    else process.env.WOPR_HOME = savedHome
  })

  // WOPR_HOME points at the directory that contains .wopr, like a repo root.
  async function globalHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wopr-home-"))
    dirs.push(root)
    await mkdir(join(root, ".wopr", "agents"), { recursive: true })
    process.env.WOPR_HOME = root
    return join(root, ".wopr")
  }

  test("loads ~/.wopr/config.yaml and validates global agents against ~/.wopr/agents", async () => {
    const home = await globalHome()
    await writeFile(join(home, "agents", "global-agent.md"), "# global-agent\n")
    await writeFile(join(home, "config.yaml"), "defaults:\n  model: openai/gpt-5.5#xhigh\nagents:\n  global-agent:\n    description: A global agent\n    model: anthropic/claude-opus-4-7\n")

    const config = await loadGlobalWoprConfig()
    expect(config?.defaults.model).toBe("openai/gpt-5.5#xhigh")
    expect(config?.agents["global-agent"]).toMatchObject({ model: "anthropic/claude-opus-4-7" })
  })

  test("merges global under project so the project wins", async () => {
    const home = await globalHome()
    await writeFile(join(home, "config.yaml"), "defaults:\n  model: openai/gpt-5.5#xhigh\n  maxAttempts: 9\n")

    const project = await projectDir("defaults:\n  maxAttempts: 2\n")
    const merged = await loadMergedWoprConfig(project)
    expect(merged?.defaults).toEqual({ model: "openai/gpt-5.5#xhigh", maxAttempts: 2 })
  })
})

describe("default config init", () => {
  test("the default config template is valid and explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-default-config-"))
    dirs.push(dir)
    const path = join(dir, "config.yaml")
    await writeDefaultWoprConfig(path)

    const body = await readFile(path, "utf8")
    const config = parseWoprConfig(body, path, dir)

    expect(body).toContain("# maxAttempts: 2")
    expect(body).toContain("# baseRef: main")
    expect(body).toContain("# pipeline: implement")
    expect(body).toContain("# branchNameModel: anthropic/claude-haiku-4-5")
    expect(body).toContain("# hooks:")
    expect(body).toContain("#           command: gh pr create --fill")
    expect(body).toContain("# agents:")
    expect(body).toContain("#   implementer:")
    expect(body).toContain("#   design-polisher:")
    expect(body).toContain("#   api-reviewer:")
    expect(config.defaults).toEqual({})
    expect(config.agents).toEqual({})
    for (const agent of builtInAgents) {
      expect(await readFile(join(dir, "agents", `${agent.name}.md`), "utf8")).toContain("#")
    }
    expect(config.pipelines.implement?.steps).toEqual([
      { agent: "implementer", reports: "none" },
      "patterns",
      "security",
      { agent: "design", model: defaultImplementReviewModel },
      { agent: "tests", reports: "none" },
      { agent: "adversarial", model: defaultImplementReviewModel, reports: "all" },
    ])
    expect(config.permissions).toEqual({ allow: [], deny: [] })
    expect(config.hooks).toEqual({ pre: [], post: [], pipelines: {} })
    expect(config.attachments).toEqual([])
  })

  test("writes default config without overwriting unless forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-config-write-"))
    dirs.push(dir)
    const path = join(dir, "config.yaml")

    expect(await writeDefaultWoprConfig(path)).toEqual({ path, created: true })
    expect(await readFile(path, "utf8")).toContain("version: 1")
    expect(await readFile(join(dir, "agents", "implementer.md"), "utf8")).toContain("# Implementer")

    await writeFile(path, "version: 1\nattachments:\n  - custom.md\n")
    await writeFile(join(dir, "agents", "implementer.md"), "# Custom Implementer\n")
    expect(await writeDefaultWoprConfig(path)).toEqual({ path, created: false })
    expect(await readFile(path, "utf8")).toContain("custom.md")
    expect(await readFile(join(dir, "agents", "implementer.md"), "utf8")).toContain("# Custom Implementer")

    expect(await writeDefaultWoprConfig(path, true)).toEqual({ path, created: true })
    expect(await readFile(path, "utf8")).not.toContain("custom.md")
    expect(await readFile(join(dir, "agents", "implementer.md"), "utf8")).toContain("# Implementer")
  })

  test("writes project default config under .wopr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-project-config-"))
    dirs.push(dir)
    const path = join(dir, ".wopr", "config.yaml")

    expect(await writeDefaultProjectConfig(dir)).toEqual({ path, created: true })
    expect(await writeDefaultProjectConfig(dir)).toEqual({ path, created: false })
    expect(await readFile(path, "utf8")).toContain("pipelines:")
    expect(await readFile(join(dir, ".wopr", "agents", "implementer.md"), "utf8")).toContain("# Implementer")
  })
})

describe("budget validation", () => {
  test("parses budget in defaults", () => {
    const config = parse(
      [
        "defaults:",
        "  budget:",
        "    perRun: 10.00",
        "    onExceed: warn-and-continue",
      ].join("\n"),
    )
    expect(config.defaults.budget?.perRun).toBe(10.00)
    expect(config.defaults.budget?.onExceed).toBe("warn-and-continue")
  })

  test("budget defaults to abort when onExceed is missing", () => {
    const config = parse(
      [
        "defaults:",
        "  budget:",
        "    perRun: 5.00",
      ].join("\n"),
    )
    expect(config.defaults.budget?.perRun).toBe(5.00)
    expect(config.defaults.budget?.onExceed).toBeUndefined()
  })

  test("budget rejects non-positive perRun", () => {
    expect(() =>
      parse(
        [
          "defaults:",
          "  budget:",
          "    perRun: 0",
        ].join("\n"),
      ),
    ).toThrow("defaults.budget.perRun must be a positive number")

    expect(() =>
      parse(
        [
          "defaults:",
          "  budget:",
          "    perRun: -1",
        ].join("\n"),
      ),
    ).toThrow("defaults.budget.perRun must be a positive number")
  })

  test("budget rejects invalid onExceed", () => {
    expect(() =>
      parse(
        [
          "defaults:",
          "  budget:",
          "    perRun: 5",
          "    onExceed: maybe",
        ].join("\n"),
      ),
    ).toThrow('must be "abort" or "warn-and-continue"')
  })

  test("budget in pipeline overrides defaults", () => {
    const config = parse(
      [
        "defaults:",
        "  budget:",
        "    perRun: 10.00",
        "pipelines:",
        "  quick:",
        "    budget:",
        "      perRun: 5.00",
        "    steps:",
        "      - implementer",
      ].join("\n"),
    )
    expect(config.defaults.budget?.perRun).toBe(10)
    expect(config.pipelines.quick?.budget?.perRun).toBe(5)
  })

  test("budget rejects perPhase with non-positive values", () => {
    expect(() =>
      parse(
        [
          "defaults:",
          "  budget:",
          "    perRun: 10",
          "    perPhase:",
          "      implementer: -1",
        ].join("\n"),
      ),
    ).toThrow("must be a positive number")
  })

  test("budget round-trips through serialize + reparse", () => {
    const config = parse(
      [
        "defaults:",
        "  budget:",
        "    perRun: 10.00",
        "    onExceed: warn-and-continue",
      ].join("\n"),
    )
    const yaml = serializeWoprConfig(config)
    expect(yaml).toContain("perRun")
    const reparsed = parse(yaml)
    expect(reparsed.defaults.budget?.perRun).toBe(10)
    expect(reparsed.defaults.budget?.onExceed).toBe("warn-and-continue")
  })

  describe("approvals config", () => {
    const approveParse = (body: string) => parse(body)

    test("parses approvals section from YAML", () => {
      const config = approveParse(`
approvals:
  topic: ntfy://wopr-approvals-topic
  timeoutSeconds: 600
  onTimeout: allow-once
`)
      expect(config.approvals).toBeDefined()
      expect(config.approvals!.topic.kind).toBe("ntfy")
      expect(config.approvals!.topic.topic).toBe("wopr-approvals-topic")
      expect(config.approvals!.timeoutSeconds).toBe(600)
      expect(config.approvals!.onTimeout).toBe("allow-once")
    })

    test("defaults for timeoutSeconds and onTimeout", () => {
      const config = approveParse(`
approvals:
  topic: ntfy://wopr-approvals-topic
`)
      expect(config.approvals).toBeDefined()
      expect(config.approvals!.timeoutSeconds).toBe(300)
      expect(config.approvals!.onTimeout).toBe("reject")
    })

    test("rejects missing topic", () => {
      expect(() => approveParse(`
approvals:
  timeoutSeconds: 300
`)).toThrow("approvals.topic")
    })

    test("rejects invalid onTimeout value", () => {
      expect(() => approveParse(`
approvals:
  topic: ntfy://wopr-approvals-topic
  onTimeout: maybe
`)).toThrow('must be "reject" or "allow-once"')
    })

    test("omitting approvals defaults to undefined", () => {
      const config = approveParse(`defaults: {}\n`)
      expect(config.approvals).toBeUndefined()
    })

    test("parses self-hosted ntfy server", () => {
      const config = approveParse(`
approvals:
  topic: ntfy://ntfy.example.com/wopr-approvals
`)
      expect(config.approvals!.topic.server).toBe("https://ntfy.example.com")
      expect(config.approvals!.topic.topic).toBe("wopr-approvals")
    })

    test("round-trips through serialize + reparse", () => {
      const config = parse(
        [
          "approvals:",
          "  topic: ntfy://wopr-approvals-topic",
          "  timeoutSeconds: 600",
          "  onTimeout: allow-once",
        ].join("\n"),
      )
      const yaml = serializeWoprConfig(config)
      expect(yaml).toContain("topic")
      const reparsed = parse(yaml)
      expect(reparsed.approvals).toBeDefined()
      expect(reparsed.approvals!.topic.topic).toBe("wopr-approvals-topic")
      expect(reparsed.approvals!.timeoutSeconds).toBe(600)
      expect(reparsed.approvals!.onTimeout).toBe("allow-once")
    })

    test("merge: project overrides global approvals", () => {
      const global = parseWoprConfig(
        "approvals:\n  topic: ntfy://global-approvals\n",
        "~/.wopr/config.yaml",
        "/tmp",
      )
      const project = parseWoprConfig(
        "approvals:\n  topic: ntfy://project-approvals\n",
        ".wopr/config.yaml",
        "/tmp",
      )
      const merged = mergeWoprConfigs(global, project)
      expect(merged!.approvals).toBeDefined()
      expect(merged!.approvals!.topic.topic).toBe("project-approvals")
    })

    test("merge: global approvals used when project has none", () => {
      const global = parseWoprConfig(
        "approvals:\n  topic: ntfy://global-approvals\n",
        "~/.wopr/config.yaml",
        "/tmp",
      )
      const project = parseWoprConfig("defaults: {}", ".wopr/config.yaml", "/tmp")
      const merged = mergeWoprConfigs(global, project)
      expect(merged!.approvals).toBeDefined()
      expect(merged!.approvals!.topic.topic).toBe("global-approvals")
    })
  })
})
