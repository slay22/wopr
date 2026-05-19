import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import { addAllAndCommit } from "./git"
import { log } from "./log"
import type { RunOptions } from "./types"
import type { Workspace } from "./workspace"

type AppProcess = ReturnType<typeof Bun.spawn>

export async function runHumanReviewGate(workspace: Workspace, options: RunOptions, opencodeUrl: string) {
  if (!options.humanReview) return

  if (!stdin.isTTY || !stdout.isTTY) {
    log.warn("[human-review] skipped because stdin/stdout are not interactive")
    return
  }

  log.section("human-review - implementation checkpoint")
  log.info("review the running app, then choose whether to continue, iterate in OpenCode, rerun the app, or abort")

  if (options.emulatorID) await launchEmulator(options)

  let iterations = 0
  let app = await startApp(options)

  try {
    for (;;) {
      const action = await askHumanAction()

      if (action === "continue") {
        await commitHumanChanges(options)
        await writeHumanReviewReport(workspace, options, "approved", iterations)
        return
      }

      if (action === "iterate") {
        iterations++
        await stopApp(app)
        app = undefined
        await runInteractiveOpencode(options, opencodeUrl)
        await commitHumanChanges(options)
        if (options.emulatorID) await launchEmulator(options)
        app = await startApp(options)
        continue
      }

      if (action === "rerun") {
        await stopApp(app)
        app = await startApp(options)
        continue
      }

      await writeHumanReviewReport(workspace, options, "aborted", iterations)
      throw new Error("aborted by human review")
    }
  } finally {
    await stopApp(app)
  }
}

async function launchEmulator(options: RunOptions) {
  log.info(`[human-review] launching emulator ${options.emulatorID}`)
  const proc = Bun.spawn(["flutter", "emulators", "--launch", options.emulatorID], {
    cwd: options.targetDir,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })
  const code = await proc.exited
  if (code !== 0) log.warn(`[human-review] emulator launch exited with code ${code}; start it manually if needed`)
}

async function startApp(options: RunOptions): Promise<AppProcess | undefined> {
  if (!options.appRunCommand) {
    log.warn("[human-review] app launch disabled; start the app manually before continuing")
    return undefined
  }

  log.info(`[human-review] starting app: ${options.appRunCommand}`)
  const proc = Bun.spawn(["sh", "-lc", options.appRunCommand], {
    cwd: options.targetDir,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })

  return proc
}

async function askHumanAction() {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    for (;;) {
      const answer = (await rl.question("Human review: [c]ontinue, [i]terate, [r]erun app, [a]bort > "))
        .trim()
        .toLowerCase()
      if (answer === "c" || answer === "continue") return "continue" as const
      if (answer === "i" || answer === "iterate") return "iterate" as const
      if (answer === "r" || answer === "rerun") return "rerun" as const
      if (answer === "a" || answer === "abort") return "abort" as const
      stdout.write("Choose c, i, r, or a.\n")
    }
  } finally {
    rl.close()
  }
}

async function runInteractiveOpencode(options: RunOptions, opencodeUrl: string) {
  const args = [
    "run",
    "--interactive",
    "--attach",
    opencodeUrl,
    "--dir",
    options.targetDir,
    "--model",
    options.interactiveModel,
  ]
  if (options.interactiveVariant) args.push("--variant", options.interactiveVariant)

  log.info(`[human-review] handing control to OpenCode (${options.interactiveModel}${options.interactiveVariant ? `#${options.interactiveVariant}` : ""})`)
  const proc = Bun.spawn(["opencode", ...args], {
    cwd: options.targetDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })

  const code = await proc.exited
  if (code !== 0) throw new Error(`[human-review] interactive OpenCode exited with code ${code}`)
}

async function commitHumanChanges(options: RunOptions) {
  const committed = await addAllAndCommit("archer(human-review): apply manual iteration", options.targetDir)
  if (committed) log.info("[human-review] committed manual changes")
}

async function writeHumanReviewReport(workspace: Workspace, options: RunOptions, result: "approved" | "aborted", iterations: number) {
  const reportPath = join(workspace.dir, "reports", "human-review.md")
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(
    reportPath,
    [
      "# human review",
      "",
      `- Result: ${result}`,
      `- Manual OpenCode iterations: ${iterations}`,
      `- App command: ${options.appRunCommand || "disabled"}`,
      `- Emulator: ${options.emulatorID || "not launched by Archer"}`,
      `- Interactive model: ${options.interactiveModel}${options.interactiveVariant ? `#${options.interactiveVariant}` : ""}`,
      "",
    ].join("\n"),
  )
}

async function stopApp(proc: AppProcess | undefined) {
  if (!proc) return
  proc.kill("SIGTERM")
  const code = await Promise.race([
    proc.exited,
    sleep(5_000).then(() => {
      proc.kill("SIGKILL")
      return proc.exited
    }),
  ])
  if (![0, 130, 143].includes(code)) log.warn(`[human-review] stopped app process with code ${code}`)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
