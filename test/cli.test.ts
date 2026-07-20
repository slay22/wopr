import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import { parseAndRun, parseArgs, parseCommand, resolveRunOptions } from "../src/cli"
import { addWorktree } from "../src/git"
import { stepNames } from "../src/pipeline"

const homeDirs: string[] = []
let savedHome: string | undefined

beforeEach(async () => {
  savedHome = process.env.WOPR_HOME
  const root = await mkdtemp(join(tmpdir(), "wopr-cli-home-"))
  homeDirs.push(root)
  await mkdir(join(root, ".wopr"), { recursive: true })
  process.env.WOPR_HOME = root
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.WOPR_HOME
  else process.env.WOPR_HOME = savedHome
})

afterAll(async () => {
  await Promise.all(homeDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("cli parsing", () => {
  test("parses pipeline flags without side effects", () => {
    const parsed = parseArgs([
      "--only",
      "implementer,tests",
      "--skip=design",
      "--file",
      "lib/onboarding",
      "--include-dirty",
      "add",
      "onboarding",
    ])

    expect(parsed.onlySteps).toEqual(["implementer", "tests"])
    expect(parsed.skipSteps).toEqual(["design"])
    expect(parsed.files).toEqual(["lib/onboarding"])
    expect(parsed.includeDirty).toBe(true)
    expect(parsed.prompt).toBe("add onboarding")
  })

  test("returns help as a command", async () => {
    const command = await parseCommand(["--help"])

    expect(command.type).toBe("help")
    if (command.type === "help") expect(command.text).toContain("wopr [prompt]")
  })

  test("requires prompt unless resuming", async () => {
    await expect(parseCommand([])).rejects.toThrow("need a prompt")

    const command = await parseCommand(["--resume", "20260519-103045-x7q2"])
    expect(command.type).toBe("run")
    if (command.type === "run") expect(command.options.resumeRunID).toBe("20260519-103045-x7q2")
  })

  test("rejects invalid max attempts", () => {
    expect(() => parseArgs(["--max-attempts", "0", "prompt"])).toThrow("--max-attempts")
  })

  test("rejects unknown step names against the resolved pipeline", async () => {
    await expect(parseCommand(["--only", "secuirty", "prompt"])).rejects.toThrow('unknown step "secuirty"')
    await expect(parseCommand(["--skip", "desing", "prompt"])).rejects.toThrow('unknown step "desing"')

    // human-review is a legacy human step name; referencing it stays valid even when
    // the gate was dropped from the pipeline (non-interactive runs).
    const command = await parseCommand(["--skip", "human-review", "prompt"])
    expect(command.type).toBe("run")
  })

  test("rejects a flag where a value is expected", () => {
    expect(() => parseArgs(["--prompt-file", "--only"])).toThrow("--prompt-file requires a value")
  })

  test("rejects conflicting prompt sources", async () => {
    await expect(parseCommand(["--prompt-file", "prd.md", "inline prompt"])).rejects.toThrow("not both")
    await expect(parseCommand(["--resume", "20260519-103045-x7q2", "new prompt"])).rejects.toThrow("--resume")
  })

  test("parses human step flags", () => {
    const parsed = parseArgs(["--human-step", "--no-tui", "prompt"])

    expect(parsed.humanReview).toBe(true)
    expect(parsed.tui).toBe(false)
    expect(parseArgs(["--no-human-step", "prompt"]).humanReview).toBe(false)
  })

  test("yolo is opt-in", async () => {
    const plain = await parseCommand(["prompt"])
    if (plain.type === "run") expect(plain.options.yolo).toBe(false)

    const yolo = await parseCommand(["--yolo", "prompt"])
    if (yolo.type === "run") expect(yolo.options.yolo).toBe(true)
  })

  test("keepWorktree defaults on; --no-keep-worktree turns it off", async () => {
    const plain = await parseCommand(["prompt"])
    if (plain.type === "run") expect(plain.options.keepWorktree).toBe(true)

    const off = await parseCommand(["--no-keep-worktree", "prompt"])
    if (off.type === "run") expect(off.options.keepWorktree).toBe(false)
  })

  test("smart auto-accept is opt-in and resolves a judge model", async () => {
    const plain = await parseCommand(["prompt"])
    // Unset, the judge model still resolves (falls back to the run's model).
    if (plain.type === "run") {
      expect(plain.options.smart).toBe(false)
      expect(plain.options.smartJudgeModel.length).toBeGreaterThan(0)
    }

    const smart = await parseCommand(["--smart", "--smart-model", "anthropic/claude-haiku-4-5", "prompt"])
    if (smart.type === "run") {
      expect(smart.options.smart).toBe(true)
      expect(smart.options.smartJudgeModel).toBe("anthropic/claude-haiku-4-5")
    }
  })

  test("parses --budget flag", () => {
    const parsed = parseArgs(["--budget", "5.00", "prompt"])
    expect(parsed.budget).toBe("5.00")
  })

  test("--budget-mode defaults to abort", () => {
    const parsed = parseArgs(["--budget", "5.00", "prompt"])
    // When --budget-mode is not set, budgetMode is undefined
    expect(parsed.budgetMode).toBeUndefined()
  })

  test("parses --budget-mode warn", () => {
    const parsed = parseArgs(["--budget", "5.00", "--budget-mode", "warn", "prompt"])
    expect(parsed.budgetMode).toBe("warn")
  })

  test("--no-budget clears the budget", () => {
    const parsed = parseArgs(["--no-budget", "prompt"])
    expect(parsed.budget).toBeUndefined()
    expect(parsed.noBudget).toBe(true)
  })

  test("rejects invalid --budget-mode", () => {
    expect(() => parseArgs(["--budget", "5", "--budget-mode", "maybe", "prompt"])).toThrow(
      '--budget-mode must be "abort" or "warn"',
    )
  })

  test("parses --notify flag", () => {
    const parsed = parseArgs(["--notify", "ntfy://wopr-leo", "prompt"])
    expect(parsed.notify).toEqual(["ntfy://wopr-leo"])
  })

  test("--notify is repeatable", () => {
    const parsed = parseArgs(["--notify", "ntfy://topic-a", "--notify", "ntfy://topic-b", "prompt"])
    expect(parsed.notify).toEqual(["ntfy://topic-a", "ntfy://topic-b"])
  })

  test("--no-notify clears notifications", () => {
    const parsed = parseArgs(["--notify", "ntfy://wopr-leo", "--no-notify", "prompt"])
    expect(parsed.notify).toEqual([])
    expect(parsed.noNotify).toBe(true)
  })

  test("parses --version flag", () => {
    const parsed = parseArgs(["--version"])
    expect(parsed.version).toBe(true)
  })

  test("parses -v flag", () => {
    const parsed = parseArgs(["-v"])
    expect(parsed.version).toBe(true)
  })

  test("--version returns a version command", async () => {
    const command = await parseCommand(["--version"])
    expect(command.type).toBe("version")
    if (command.type === "version") {
      expect(command.text).toMatch(/^wopr /)
    }
  })

  test("-v returns a version command", async () => {
    const command = await parseCommand(["-v"])
    expect(command.type).toBe("version")
    if (command.type === "version") {
      expect(command.text).toMatch(/^wopr /)
    }
  })

  test("--version outputs version and exits (no prompt needed)", async () => {
    // parseCommand should succeed without a prompt when --version is set
    const command = await parseCommand(["--version"])
    expect(command.type).toBe("version")
  })

  test("version subcommand prints version", async () => {
    const command = await parseCommand(["version"])
    expect(command.type).toBe("version")
    if (command.type === "version") {
      expect(command.text).toMatch(/^wopr /)
    }
  })

  test("version subcommand rejects extra arguments", async () => {
    await expect(parseCommand(["version", "--flag"])).rejects.toThrow("usage: wopr version")
    await expect(parseCommand(["version", "extra"])).rejects.toThrow("usage: wopr version")
  })

  test("parses --steps flag", () => {
    const parsed = parseArgs(["--steps", "implementer,tests", "prompt"])
    expect(parsed.steps).toBeDefined()
    expect(parsed.steps!.length).toBe(2)
    expect(parsed.steps![0]).toEqual({ agent: "implementer" })
    expect(parsed.steps![1]).toEqual({ agent: "tests" })
  })

  test("--steps and --pipeline are mutually exclusive", async () => {
    await expect(parseCommand(["--steps", "implementer", "--pipeline", "review", "prompt"])).rejects.toThrow(
      "mutually exclusive",
    )
  })

  test("parses the notify test subcommand", async () => {
    const cmd = await parseCommand(["notify", "test", "ntfy://wopr-test"])
    expect(cmd.type).toBe("notify-test")
    if (cmd.type === "notify-test") {
      expect(cmd.urls).toEqual(["ntfy://wopr-test"])
      expect(cmd.targets.length).toBe(1)
    }
  })

  test("parses the runs subcommand", async () => {
    const bare = await parseCommand(["runs"])
    expect(bare.type).toBe("runs")
    if (bare.type === "runs") expect(bare.runID).toBeUndefined()

    const withID = await parseCommand(["runs", "20260519-103045-x7q2"])
    expect(withID.type).toBe("runs")
    if (withID.type === "runs") expect(withID.runID).toBe("20260519-103045-x7q2")
  })

  test("rejects bad runs subcommand arguments", async () => {
    await expect(parseCommand(["runs", "latest"])).rejects.toThrow("invalid run id")
    await expect(parseCommand(["runs", "20260519-103045-x7q2", "extra"])).rejects.toThrow("usage: wopr runs")
  })
})

describe("config precedence", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function projectWithConfig() {
    const dir = await mkdtemp(join(tmpdir(), "wopr-cli-config-"))
    dirs.push(dir)
    await mkdir(join(dir, ".wopr"), { recursive: true })
    await writeFile(join(dir, "docs.md"), "# notes")
    await writeFile(
      join(dir, ".wopr", "config.yaml"),
      [
        "defaults:",
        "  maxAttempts: 5",
        "  baseRef: develop",
        "  pipeline: quick",
        "pipelines:",
        "  quick:",
        "    steps:",
        "      - implementer",
        "      - tests",
        "attachments:",
        "  - docs.md",
      ].join("\n"),
    )
    return dir
  }

  test("config defaults apply when flags are absent", async () => {
    const dir = await projectWithConfig()
    const command = await parseCommand(["--dir", dir, "prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.maxAttempts).toBe(5)
    expect(command.options.baseRef).toBe("develop")
    expect(command.options.pipeline.name).toBe("quick")
    expect(stepNames(command.options.pipeline)).toEqual(["implementer", "tests"])
    expect(command.options.files).toEqual(["docs.md"])
  })

  async function projectWithBudgetConfig() {
    const dir = await mkdtemp(join(tmpdir(), "wopr-cli-budget-"))
    dirs.push(dir)
    await mkdir(join(dir, ".wopr"), { recursive: true })
    await writeFile(join(dir, "docs.md"), "# notes")
    await writeFile(
      join(dir, ".wopr", "config.yaml"),
      [
        "defaults:",
        "  budget:",
        "    perRun: 10.00",
        "  pipeline: quick",
        "pipelines:",
        "  quick:",
        "    steps:",
        "      - implementer",
        "      - tests",
      ].join("\n"),
    )
    return dir
  }

  test("config budget applies when no flag is passed", async () => {
    const dir = await projectWithBudgetConfig()
    const parsed = parseArgs(["prompt"])
    parsed.targetDir = dir
    const options = await resolveRunOptions(parsed)
    expect(options.budget?.perRun).toBe(10)
    // onExceed omitted in config -> defaults to abort
    expect(options.budget?.onExceed).toBeUndefined()
  })

  test("--no-budget clears a config budget", async () => {
    const dir = await projectWithBudgetConfig()
    const parsed = parseArgs(["--no-budget", "prompt"])
    parsed.targetDir = dir
    const options = await resolveRunOptions(parsed)
    expect(options.budget).toBeUndefined()
  })

  test("--budget-mode overrides a config budget's onExceed", async () => {
    const dir = await projectWithBudgetConfig()
    const parsed = parseArgs(["--budget-mode", "warn", "prompt"])
    parsed.targetDir = dir
    const options = await resolveRunOptions(parsed)
    expect(options.budget?.perRun).toBe(10)
    expect(options.budget?.onExceed).toBe("warn-and-continue")
  })

  describe("notification config resolution", () => {
    async function projectWithNotifyConfig() {
      const dir = await mkdtemp(join(tmpdir(), "wopr-cli-notify-"))
      dirs.push(dir)
      await mkdir(join(dir, ".wopr"), { recursive: true })
      await writeFile(join(dir, ".wopr", "config.yaml"), [
        "notifications:",
        "  - ntfy://config-topic",
      ].join("\n"))
      return dir
    }

    test("config notification targets appear in resolved options", async () => {
      const dir = await projectWithNotifyConfig()
      const parsed = parseArgs(["prompt"])
      parsed.targetDir = dir
      const options = await resolveRunOptions(parsed)
      expect(options.notifications.length).toBe(1)
      if (options.notifications[0]!.kind === "ntfy") {
        expect(options.notifications[0]!.topic).toBe("config-topic")
      }
    })

    test("--notify CLI flag overrides config notifications", async () => {
      const dir = await projectWithNotifyConfig()
      const parsed = parseArgs(["--notify", "ntfy://cli-topic", "prompt"])
      parsed.targetDir = dir
      const options = await resolveRunOptions(parsed)
      expect(options.notifications.length).toBe(1)
      if (options.notifications[0]!.kind === "ntfy") {
        expect(options.notifications[0]!.topic).toBe("cli-topic")
      }
    })

    test("--no-notify clears all notification targets", async () => {
      const dir = await projectWithNotifyConfig()
      const parsed = parseArgs(["--no-notify", "prompt"])
      parsed.targetDir = dir
      const options = await resolveRunOptions(parsed)
      expect(options.notifications).toEqual([])
    })

    test("no config and no --notify means empty notifications", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wopr-cli-no-notify-"))
      dirs.push(dir)
      await mkdir(join(dir, ".wopr"), { recursive: true })
      const parsed = parseArgs(["prompt"])
      parsed.targetDir = dir
      const options = await resolveRunOptions(parsed)
      expect(options.notifications).toEqual([])
    })
  })

  test("CLI flags always win over config defaults", async () => {
    const dir = await projectWithConfig()
    const command = await parseCommand([
      "--dir",
      dir,
      "--max-attempts",
      "1",
      "--base",
      "main",
      "--pipeline",
      "implement",
      "prompt",
    ])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.maxAttempts).toBe(1)
    expect(command.options.baseRef).toBe("main")
    expect(command.options.pipeline.name).toBe("implement")
  })

  test("an unknown pipeline lists what exists", async () => {
    const dir = await projectWithConfig()
    await expect(parseCommand(["--dir", dir, "--pipeline", "ghost", "prompt"])).rejects.toThrow(
      'unknown pipeline "ghost" (available: converge, implement, implement-lite, quick, refine, review, review-lite, ultra-implement, ultra-refine)',
    )
  })
})

describe("base ref auto-detection", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "wopr-test",
        GIT_AUTHOR_EMAIL: "wopr-test@example.invalid",
        GIT_COMMITTER_NAME: "wopr-test",
        GIT_COMMITTER_EMAIL: "wopr-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function repoOn(branch: string) {
    const dir = await mkdtemp(join(tmpdir(), "wopr-cli-base-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", branch], dir)
    await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
    return dir
  }

  test("auto-detects the base ref when flag and config are absent", async () => {
    const dir = await repoOn("develop")
    const command = await parseCommand(["--dir", dir, "prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.baseRef).toBe("develop")
  })

  test("falls back to HEAD outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-cli-base-"))
    dirs.push(dir)
    const command = await parseCommand(["--dir", dir, "prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.baseRef).toBe("HEAD")
  })

  test("worktree runs detect against the original repo, not the worktree", async () => {
    const repo = await repoOn("squad-x")
    const worktree = await mkdtemp(join(tmpdir(), "wopr-cli-base-wt-"))
    await rm(worktree, { recursive: true, force: true })
    dirs.push(worktree)
    await addWorktree(worktree, "agent-branch", "HEAD", repo)

    const parsed = parseArgs(["prompt"])
    parsed.targetDir = worktree
    parsed.baseDetectionDir = repo

    const options = await resolveRunOptions(parsed)
    expect(options.baseRef).toBe("squad-x")
  })

  test("--worktree rejects a repo with no commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-cli-wt-empty-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", "main"], dir)
    await expect(parseCommand(["--dir", dir, "--worktree", "prompt"])).rejects.toThrow("at least one commit")
  })

  test("--worktree can't be combined with --resume", async () => {
    await expect(parseCommand(["--worktree", "--resume", "20260519-103045-x7q2"])).rejects.toThrow("can't be combined with --resume")
  })
})

describe("init command", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("parses init options without requiring a prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-cli-init-"))
    dirs.push(dir)

    const local = await parseCommand(["init", "--dir", dir, "--force", "--quiet"])
    expect(local.type).toBe("init")
    if (local.type === "init") {
      expect(local.options).toMatchObject({ targetDir: dir, global: false, force: true, quiet: true })
    }

    const global = await parseCommand(["init", "--global", "--force"])
    expect(global.type).toBe("init")
    if (global.type === "init") expect(global.options).toMatchObject({ global: true, force: true })
  })

  test("rejects incompatible init options", async () => {
    await expect(parseCommand(["init", "--global", "--dir", "."])).rejects.toThrow("either --global or --dir")
    await expect(parseCommand(["init", "extra"])).rejects.toThrow("usage: wopr init")
  })

  test("creates project config without overwriting unless forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-cli-init-write-"))
    dirs.push(dir)
    const path = join(dir, ".wopr", "config.yaml")

    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("version: 1")
    expect(await readFile(path, "utf8")).toContain("#   implementer:")
    expect(await readFile(path, "utf8")).toContain("# maxAttempts: 2")
    expect(await readFile(join(dir, ".wopr", "agents", "implementer.md"), "utf8")).toContain("# Implementer")

    await writeFile(path, "version: 1\nattachments:\n  - custom.md\n")
    await writeFile(join(dir, ".wopr", "agents", "implementer.md"), "# Custom Implementer\n")
    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("custom.md")
    expect(await readFile(join(dir, ".wopr", "agents", "implementer.md"), "utf8")).toContain("# Custom Implementer")

    await parseAndRun(["init", "--dir", dir, "--force", "--quiet"])
    expect(await readFile(path, "utf8")).not.toContain("custom.md")
    expect(await readFile(join(dir, ".wopr", "agents", "implementer.md"), "utf8")).toContain("# Implementer")
  })
})
