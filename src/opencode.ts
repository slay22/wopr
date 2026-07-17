import "./polyfills"

import { stat } from "node:fs/promises"
import { homedir } from "node:os"

// wopr drives the model in-process via pi now (see src/pi.ts), so there is no
// OpenCode server/client here anymore. What remains are the macOS helpers that
// open an interactive `opencode` terminal window for hands-on iteration.
// ponytail: MVP has no pi server to attach to, so these `opencode attach <url>`
// windows degrade (empty url) — the callers already try/catch. Rework to pi's
// JSONL session when a "reopen my session" story is needed.

export type SessionWindowBackend = "ghostty" | "terminal"

// Async on purpose: this is called from the TUI's render path, and a sync
// osascript call would freeze the dashboard while macOS opens the window.
// Prefers Ghostty when installed; Terminal.app is the fallback that always
// works on macOS. WOPR_TERMINAL=ghostty|terminal forces a backend.
export async function openOpencodeSessionWindow(input: {
  url: string
  targetDir: string
  sessionID: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(
    ["opencode", "attach", input.url, "--dir", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "),
  )
}

// `run --interactive` needs a message and exits immediately without one, so
// the window attaches the full TUI to the run's server instead; --continue
// resumes the run's latest session with its context.
export async function openInteractiveOpencodeWindow(input: {
  url: string
  targetDir: string
}): Promise<SessionWindowBackend> {
  const args = ["opencode", "attach", input.url, "--dir", input.targetDir, "--continue"]
  return openSessionCommand(args.map(shellQuote).join(" "))
}

// Opens a standalone opencode TUI on a stored session — it starts its own
// server and reads the session from disk — for runs whose live server is gone
// (so `[o]` in a re-opened finished-run dashboard still works).
export async function openStoredSessionWindow(input: {
  targetDir: string
  sessionID: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(["opencode", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "))
}

// Opens a standalone opencode TUI on a brand-new session seeded with an
// initial prompt (--prompt submits it on startup). Standalone on purpose: the
// run's server dies when the finish screen closes, and this window must
// outlive wopr so the user can keep iterating.
export async function openIterateOpencodeWindow(input: {
  targetDir: string
  prompt: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(["opencode", input.targetDir, "--prompt", input.prompt].map(shellQuote).join(" "))
}

async function openSessionCommand(coreCommand: string): Promise<SessionWindowBackend> {
  if (process.platform !== "darwin") {
    throw new Error("opening a new OpenCode terminal window is currently implemented for macOS only")
  }

  // A login shell keeps the user's PATH for `opencode`.
  const command = [process.env.PATH ? `export PATH=${shellQuote(process.env.PATH)}:$PATH` : "", coreCommand]
    .filter(Boolean)
    .join("; ")

  const forced = process.env.WOPR_TERMINAL?.toLowerCase()
  if (forced === "terminal") {
    await openInTerminalApp(command)
    return "terminal"
  }
  if (forced === "ghostty" || (await ghosttyInstalled())) {
    try {
      await openInGhostty(command)
      return "ghostty"
    } catch (error) {
      if (forced === "ghostty") throw error
      // Best effort: Ghostty's macOS CLI has no window/tab IPC, so launch
      // failures here are expected on some setups; Terminal always works.
    }
  }
  await openInTerminalApp(command)
  return "terminal"
}

async function ghosttyInstalled() {
  const bundles = ["/Applications/Ghostty.app", `${homedir()}/Applications/Ghostty.app`]
  for (const bundle of bundles) {
    if (await exists(bundle)) return true
  }
  return Bun.which("ghostty") !== null
}

// `open -na` asks macOS to launch a new Ghostty instance; `-e` makes Ghostty
// run the command. A login shell keeps the user's PATH for `opencode`.
async function openInGhostty(command: string) {
  await spawnChecked(["open", "-na", "Ghostty", "--args", "-e", "zsh", "-lc", command])
}

async function openInTerminalApp(command: string) {
  const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell`
  await spawnChecked(["osascript", "-e", script])
}

async function spawnChecked(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (status !== 0) throw new Error(stderr.trim() || `${cmd[0]} exited with status ${status}`)
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function appleScriptString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
