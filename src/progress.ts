import type { BoxOptions, BoxRenderable, CliRenderer, KeyEvent, TextOptions, TextRenderable } from "@opentui/core"

import { log } from "./log"
import { openOpencodeSessionWindow } from "./opencode"
import type { Phase } from "./types"

export type ProgressPhase = Pick<Phase, "name" | "description">

export type ProgressTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export type ProgressUsage = {
  sessionID?: string
  cost?: number
  tokens?: ProgressTokens
  model?: string
}

export type ProgressStepUsage = ProgressUsage & {
  stepID?: string
}

export type ProgressUI = {
  start(runID: string, targetDir: string): void
  serverReady(url: string): void
  phaseStarted(name: string, detail?: string): void
  phaseRunning(name: string, detail?: string): void
  phaseSession(name: string, sessionID: string): void
  phaseActivity(name: string, detail: string): void
  phaseStepUsage(name: string, usage: ProgressStepUsage): void
  phaseUsageTotal(name: string, usage: ProgressUsage): void
  phaseCompleted(name: string, detail?: string): void
  phaseSkipped(name: string): void
  phaseFailed(name: string, detail?: string): void
  message(message: string): void
  suspend(): void
  resume(): void
  stop(): void
}

type PhaseStatus = "pending" | "running" | "completed" | "skipped" | "failed"

type PhaseState = ProgressPhase & {
  status: PhaseStatus
  detail: string
  sessionID: string
  cost: number
  tokens: ProgressTokens
  stepCount: number
  lastStepCost?: number
  lastStepTokens?: ProgressTokens
  lastStepModel: string
  usageReported: boolean
  usageSessions: Map<string, UsageSessionState>
  seenStepIDs: Set<string>
  updatedAt: number
}

type UsageSessionState = {
  cost: number
  tokens: ProgressTokens
  steps: number
  model: string
  reported: boolean
  totalReported: boolean
}

type ActivityEntry = {
  time: number
  phase: string
  message: string
}

type BoxCtor = new (ctx: CliRenderer, options: BoxOptions) => BoxRenderable
type TextCtor = new (ctx: CliRenderer, options: TextOptions) => TextRenderable

export const noopProgress: ProgressUI = {
  start() {},
  serverReady() {},
  phaseStarted() {},
  phaseRunning() {},
  phaseSession() {},
  phaseActivity() {},
  phaseStepUsage() {},
  phaseUsageTotal() {},
  phaseCompleted() {},
  phaseSkipped() {},
  phaseFailed() {},
  message() {},
  suspend() {},
  resume() {},
  stop() {},
}

export async function createProgressUI(phases: readonly ProgressPhase[], enabled: boolean, onAbort?: () => void): Promise<ProgressUI> {
  if (!enabled || !process.stdout.isTTY) return noopProgress

  try {
    const { BoxRenderable, TextRenderable, createCliRenderer } = await import("@opentui/core")
    const renderer = await createCliRenderer({
      screenMode: "alternate-screen",
      consoleMode: "console-overlay",
      exitOnCtrlC: false,
      targetFps: 12,
      backgroundColor: theme.bg,
    })

    log.mute(true)
    return new OpenTuiProgress(renderer, BoxRenderable, TextRenderable, phases, onAbort)
  } catch (error) {
    log.mute(false)
    log.warn(`OpenTUI unavailable; falling back to plain logs: ${error instanceof Error ? error.message : String(error)}`)
    return noopProgress
  }
}

const theme = {
  bg: "#0B1020",
  panel: "#11182A",
  panelAlt: "#0F1726",
  border: "#334155",
  accent: "#7AA2F7",
  accent2: "#8BD5CA",
  text: "#D8DEE9",
}

class OpenTuiProgress implements ProgressUI {
  private runID = ""
  private targetDir = ""
  private serverUrl = ""
  private status = "starting"
  private activePhase = ""
  private lastActivityAt = Date.now()
  private readonly startedAt = Date.now()
  private readonly phases: PhaseState[]
  private readonly recent: ActivityEntry[] = []
  private readonly ticker: ReturnType<typeof setInterval>
  private readonly headerText: TextRenderable
  private readonly phaseText: TextRenderable
  private readonly detailText: TextRenderable
  private readonly eventText: TextRenderable
  private readonly footerText: TextRenderable
  private readonly handleKeyPress = (key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      this.addEvent("system", "Ctrl+C received; shutting down Archer")
      this.render()
      this.onAbort?.()
      return
    }
    if (key.name !== "o" || key.ctrl || key.meta || key.option) return
    key.preventDefault()
    key.stopPropagation()
    this.openActiveSessionWindow("key")
  }

  constructor(
    private readonly renderer: CliRenderer,
    Box: BoxCtor,
    Text: TextCtor,
    phases: readonly ProgressPhase[],
    private readonly onAbort?: () => void,
  ) {
    this.phases = phases.map((phase) => ({
      ...phase,
      status: "pending",
      detail: "",
      sessionID: "",
      cost: 0,
      tokens: emptyTokens(),
      stepCount: 0,
      lastStepModel: "",
      usageReported: false,
      usageSessions: new Map<string, UsageSessionState>(),
      seenStepIDs: new Set<string>(),
      updatedAt: Date.now(),
    }))

    const shell = new Box(renderer, {
      id: "archer-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      gap: 1,
    })

    const header = panel(Box, Text, renderer, {
      id: "archer-header",
      height: 6,
      borderColor: theme.accent,
      backgroundColor: theme.panel,
      title: " ARCHER ",
      titleAlignment: "center",
    })

    const body = new Box(renderer, {
      id: "archer-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    })

    const phasesPanel = panel(Box, Text, renderer, {
      id: "archer-phases",
      width: 38,
      height: "100%",
      borderColor: theme.accent2,
      backgroundColor: theme.panelAlt,
      title: " Pipeline ",
    })

    const right = new Box(renderer, {
      id: "archer-right",
      height: "100%",
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
    })

    const detailPanel = panel(Box, Text, renderer, {
      id: "archer-detail",
      flexGrow: 1,
      width: "100%",
      borderColor: theme.accent,
      backgroundColor: theme.panel,
      title: " Current Session ",
    })

    const eventsPanel = panel(Box, Text, renderer, {
      id: "archer-events",
      height: "38%",
      width: "100%",
      borderColor: theme.border,
      backgroundColor: theme.panelAlt,
      title: " Live Events ",
    })

    const openFromFooter = (event: { preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      this.openActiveSessionWindow("click")
    }

    const footer = panel(Box, Text, renderer, {
      id: "archer-footer",
      height: 3,
      borderColor: theme.border,
      backgroundColor: theme.panel,
      onMouseDown: openFromFooter,
    })
    footer.text.onMouseDown = openFromFooter

    this.headerText = header.text
    this.phaseText = phasesPanel.text
    this.detailText = detailPanel.text
    this.eventText = eventsPanel.text
    this.footerText = footer.text

    right.add(detailPanel.box)
    right.add(eventsPanel.box)
    body.add(phasesPanel.box)
    body.add(right)
    shell.add(header.box)
    shell.add(body)
    shell.add(footer.box)
    renderer.root.add(shell)
    renderer.keyInput.on("keypress", this.handleKeyPress)

    this.ticker = setInterval(() => this.render(), 500)
    this.render()
  }

  start(runID: string, targetDir: string) {
    this.runID = runID
    this.targetDir = targetDir
    this.status = "booting opencode"
    this.addEvent("system", `run ${runID} started`)
    this.render()
  }

  serverReady(url: string) {
    this.serverUrl = url
    this.status = "opencode SDK ready"
    this.addEvent("system", `opencode server ${url}`)
    this.render()
  }

  phaseStarted(name: string, detail = "") {
    this.setPhase(name, "running", detail || "started")
    this.addEvent(name, detail || "phase started")
  }

  phaseRunning(name: string, detail = "") {
    this.setPhase(name, "running", detail)
    if (detail) this.addEvent(name, detail)
  }

  phaseSession(name: string, sessionID: string) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.sessionID = sessionID
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.addEvent(name, `session ${sessionID}`)
    this.render()
  }

  phaseActivity(name: string, detail: string) {
    this.setPhase(name, "running", detail)
    this.addEvent(name, detail)
  }

  phaseStepUsage(name: string, usage: ProgressStepUsage) {
    const phase = this.findPhase(name)
    if (!phase || isDuplicateStep(phase, usage.stepID)) return

    const session = this.usageSession(phase, usage.sessionID)
    if (!session.totalReported) {
      session.cost += safeCost(usage.cost)
      if (usage.tokens) session.tokens = addTokens(session.tokens, usage.tokens)
    }
    session.steps += 1
    session.model = usage.model || session.model
    session.reported = true

    phase.lastStepCost = typeof usage.cost === "number" ? usage.cost : undefined
    phase.lastStepTokens = usage.tokens
    phase.lastStepModel = usage.model || phase.lastStepModel
    phase.updatedAt = Date.now()
    this.recalculateUsage(phase)
    this.render()
  }

  phaseUsageTotal(name: string, usage: ProgressUsage) {
    const phase = this.findPhase(name)
    if (!phase) return

    const session = this.usageSession(phase, usage.sessionID)
    if (typeof usage.cost === "number") session.cost = safeCost(usage.cost)
    if (usage.tokens) session.tokens = cloneTokens(usage.tokens)
    session.model = usage.model || session.model
    session.reported = true
    session.totalReported = true

    if (usage.model) phase.lastStepModel = usage.model
    phase.updatedAt = Date.now()
    this.recalculateUsage(phase)
    this.render()
  }

  phaseCompleted(name: string, detail = "") {
    this.setPhase(name, "completed", detail || "done")
    this.addEvent(name, detail || "phase completed")
  }

  phaseSkipped(name: string) {
    this.setPhase(name, "skipped", "skipped by flag")
    this.addEvent(name, "skipped")
  }

  phaseFailed(name: string, detail = "") {
    this.setPhase(name, "failed", detail || "failed")
    this.addEvent(name, detail || "failed")
  }

  message(message: string) {
    this.status = message
    this.addEvent("system", message)
    this.render()
  }

  suspend() {
    if (this.renderer.isDestroyed) return
    log.mute(false)
    this.renderer.suspend()
  }

  resume() {
    if (this.renderer.isDestroyed) return
    log.mute(true)
    this.renderer.resume()
    this.render()
  }

  stop() {
    clearInterval(this.ticker)
    log.mute(false)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    if (this.renderer.isDestroyed) return
    this.renderer.destroy()
  }

  private openActiveSessionWindow(source: "click" | "key") {
    const active = this.findPhase(this.activePhase) ?? this.phases.find((phase) => phase.status === "running")
    if (!this.serverUrl) {
      this.addEvent("system", "OpenCode server is not ready yet")
      this.render()
      return
    }
    if (!active?.sessionID) {
      this.addEvent("system", "No active OpenCode session to open yet")
      this.render()
      return
    }

    try {
      openOpencodeSessionWindow({ url: this.serverUrl, targetDir: this.targetDir || process.cwd(), sessionID: active.sessionID })
      this.addEvent("system", `${source === "key" ? "O key" : "footer click"}: opening ${active.name} session ${shortID(active.sessionID)}`)
    } catch (error) {
      this.addEvent("system", `couldn't open OpenCode session: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.render()
  }

  private setPhase(name: string, status: PhaseStatus, detail: string) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.status = status
    phase.detail = detail
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.status = `${name}: ${detail || status}`
    this.lastActivityAt = Date.now()
    this.render()
  }

  private findPhase(name: string) {
    return this.phases.find((item) => item.name === name)
  }

  private addEvent(phase: string, message: string) {
    this.lastActivityAt = Date.now()
    this.recent.push({ time: this.lastActivityAt, phase, message: truncate(message, 220) })
    if (this.recent.length > 80) this.recent.splice(0, this.recent.length - 80)
  }

  private usageSession(phase: PhaseState, sessionID?: string) {
    const key = sessionID || phase.sessionID || "phase"
    const existing = phase.usageSessions.get(key)
    if (existing) return existing

    const created: UsageSessionState = { cost: 0, tokens: emptyTokens(), steps: 0, model: "", reported: false, totalReported: false }
    phase.usageSessions.set(key, created)
    return created
  }

  private recalculateUsage(phase: PhaseState) {
    let cost = 0
    let tokens = emptyTokens()
    let stepCount = 0
    let usageReported = false
    for (const session of phase.usageSessions.values()) {
      cost += session.cost
      tokens = addTokens(tokens, session.tokens)
      stepCount += session.steps
      usageReported ||= session.reported
    }
    phase.cost = cost
    phase.tokens = tokens
    phase.stepCount = stepCount
    phase.usageReported = usageReported
  }

  private render() {
    if (this.renderer.isDestroyed) return
    const now = Date.now()
    const done = this.phases.filter((phase) => phase.status === "completed" || phase.status === "skipped").length
    const total = this.phases.length
    const active = this.findPhase(this.activePhase) ?? this.phases.find((phase) => phase.status === "running")
    const spinner = active?.status === "running" ? `${spinnerFrame(now)} ` : ""
    const current = active ? `${spinner}${active.name}: ${active.detail || active.status}` : this.status
    const width = Math.max(40, this.renderer.width - 8)
    const runUsage = totalUsage(this.phases)

    this.headerText.content = [
      `Sequential agent pipeline for feature work`,
      truncate(current, width),
      truncate(
        `run ${this.runID || "pending"} | ${done}/${total} phases | cost ${formatMoney(runUsage.cost)} | tokens ${formatTokenPair(
          runUsage.tokens,
        )} | elapsed ${formatElapsed(now - this.startedAt)} | last event ${formatAgo(now - this.lastActivityAt)}`,
        width,
      ),
      truncate(`target ${this.targetDir || process.cwd()}`, width),
      this.serverUrl ? truncate(`opencode ${this.serverUrl}`, width) : "opencode starting",
    ].join("\n")

    this.phaseText.content = [progressBar(done, total, 28), "", ...this.phases.map((phase) => phaseLine(phase))].join("\n")

    this.detailText.content = detailLines(active, this.recent, now, width).join("\n")
    this.eventText.content = eventLines(this.recent, width).join("\n")
    this.footerText.content = "[O] open active OpenCode session in Terminal | click this footer | Ctrl+C aborts | --no-tui for plain logs"
    this.renderer.requestRender()
  }
}

function panel(Box: BoxCtor, Text: TextCtor, renderer: CliRenderer, options: BoxOptions) {
  const box = new Box(renderer, {
    border: true,
    borderStyle: "rounded",
    paddingX: 1,
    paddingY: 0,
    ...options,
  })
  const text = new Text(renderer, {
    content: "",
    fg: theme.text,
    width: "100%",
    height: "100%",
  })
  box.add(text)
  return { box, text }
}

function phaseLine(phase: PhaseState) {
  const marker = phase.status === "completed" ? "[OK]" : phase.status === "running" ? "[RUN]" : phase.status === "failed" ? "[ERR]" : phase.status === "skipped" ? "[SKIP]" : "[ ]"
  const session = phase.sessionID ? ` ${shortID(phase.sessionID)}` : ""
  const detailParts: string[] = []
  if (phase.usageReported) detailParts.push(`cost ${formatMoney(phase.cost)}`)
  if (phase.stepCount > 0) detailParts.push(`${phase.stepCount} ${plural(phase.stepCount, "step")}`)
  if (phase.detail) detailParts.push(truncate(phase.detail, phase.usageReported ? 18 : 30))
  const detail = detailParts.length > 0 ? `\n     ${truncate(detailParts.join(" | "), 32)}` : ""
  return `${marker} ${phase.name.padEnd(13)} ${phase.status}${session}${detail}`
}

function detailLines(active: PhaseState | undefined, recent: ActivityEntry[], now: number, width: number) {
  if (!active) {
    return ["Waiting for the first phase to start.", "", "When OpenCode emits activity, this panel will show tools, retries, status, and output previews."]
  }

  const phaseEvents = recent.filter((entry) => entry.phase === active.name).slice(-8).reverse()
  return [
    `phase       ${active.name}`,
    `state       ${active.status}`,
    `session     ${active.sessionID || "creating..."}`,
    `cost        ${active.usageReported ? formatMoney(active.cost) : "not reported yet"}`,
    `tokens      ${active.usageReported ? formatTokens(active.tokens) : "not reported yet"}`,
    `steps       ${formatStepCount(active)}`,
    ...(active.lastStepCost !== undefined || active.lastStepTokens
      ? [`last step   ${formatLastStep(active)}`]
      : active.lastStepModel
        ? [`last model  ${active.lastStepModel}`]
        : []),
    `updated     ${formatAgo(now - active.updatedAt)}`,
    `activity    ${truncate(active.detail || "waiting for OpenCode event", width - 12)}`,
    "",
    "recent phase activity",
    ...(phaseEvents.length > 0 ? phaseEvents.map((entry) => ` ${formatTime(entry.time)}  ${truncate(entry.message, width - 12)}`) : [" no events yet; still waiting on the provider or SDK stream"]),
  ]
}

function eventLines(recent: ActivityEntry[], width: number) {
  const events = recent.slice(-12).reverse()
  if (events.length === 0) return ["Waiting for live events..."]
  return events.map((entry) => `${formatTime(entry.time)} ${entry.phase.padEnd(13)} ${truncate(entry.message, width - 22)}`)
}

function emptyTokens(): ProgressTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function cloneTokens(tokens: ProgressTokens): ProgressTokens {
  return { ...tokens }
}

function addTokens(left: ProgressTokens, right: ProgressTokens): ProgressTokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
  }
}

function totalUsage(phases: PhaseState[]) {
  return phases.reduce(
    (usage, phase) => ({ cost: usage.cost + phase.cost, tokens: addTokens(usage.tokens, phase.tokens) }),
    { cost: 0, tokens: emptyTokens() },
  )
}

function isDuplicateStep(phase: PhaseState, stepID?: string) {
  if (!stepID) return false
  if (phase.seenStepIDs.has(stepID)) return true
  phase.seenStepIDs.add(stepID)
  return false
}

function safeCost(cost: number | undefined) {
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0
}

function formatStepCount(phase: PhaseState) {
  if (phase.stepCount > 0) return `${phase.stepCount} ${plural(phase.stepCount, "step")}`
  return phase.usageReported ? "reported as phase total" : "0"
}

function formatLastStep(phase: PhaseState) {
  const parts: string[] = []
  if (phase.lastStepCost !== undefined) parts.push(formatMoney(phase.lastStepCost))
  if (phase.lastStepTokens) parts.push(formatTokenPair(phase.lastStepTokens))
  if (phase.lastStepModel) parts.push(phase.lastStepModel)
  return parts.join(" | ")
}

function formatMoney(cost: number) {
  return `$${cost.toFixed(cost >= 1 ? 2 : 4)}`
}

function formatTokens(tokens: ProgressTokens) {
  const cache = tokens.cacheRead || tokens.cacheWrite ? `, cache ${formatCount(tokens.cacheRead)}/${formatCount(tokens.cacheWrite)}` : ""
  const reasoning = tokens.reasoning ? `, reason ${formatCount(tokens.reasoning)}` : ""
  return `in/out ${formatCount(tokens.input)}/${formatCount(tokens.output)}${reasoning}${cache}`
}

function formatTokenPair(tokens: ProgressTokens) {
  return `${formatCount(tokens.input)}/${formatCount(tokens.output)}`
}

function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function plural(count: number, word: string) {
  return count === 1 ? word : `${word}s`
}

function progressBar(done: number, total: number, width: number) {
  const safeTotal = Math.max(1, total)
  const filled = Math.round((done / safeTotal) * width)
  return `[${"=".repeat(filled)}${".".repeat(Math.max(0, width - filled))}] ${done}/${total}`
}

function spinnerFrame(now: number) {
  return ["|", "/", "-", "\\"][Math.floor(now / 250) % 4]
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function formatAgo(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds <= 1) return "now"
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`
}

function formatTime(time: number) {
  return new Date(time).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function shortID(value: string) {
  if (value.length <= 12) return value
  return `${value.slice(0, 7)}...${value.slice(-4)}`
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`
}
