import { describe, expect, test } from "bun:test"

import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent"

import { startPermissionGate, type StartGateOptions } from "../src/permissions"
import { noopProgress, type PermissionPromptInfo, type PermissionReply, type ProgressUI } from "../src/progress"

type Handler = (event: ToolCallEvent) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void

// Pull the tool_call handler out of the gate's pi extension so we can invoke it
// with a synthetic tool call and assert the block/allow decision directly.
function toolCallHandler(options: StartGateOptions): Handler {
  const gate = startPermissionGate(options)
  const ext = gate.extension
  const factory = typeof ext === "function" ? ext : ext.factory
  let handler: Handler | undefined
  const pi = {
    on: (event: string, h: Handler) => {
      if (event === "tool_call") handler = h
    },
  } as unknown as ExtensionAPI
  factory(pi)
  if (!handler) throw new Error("gate did not register a tool_call handler")
  return handler
}

function bash(command: string): ToolCallEvent {
  return { type: "tool_call", toolName: "bash", toolCallId: "call-1", input: { command } } as ToolCallEvent
}

async function decideBash(command: string, options: Partial<StartGateOptions> = {}) {
  const handler = toolCallHandler({ interactive: true, directory: "/tmp/non-existent-archer-target", ...options })
  return (await handler(bash(command))) ?? {}
}

const blocked = (result: ToolCallEventResult) => result.block === true

describe("permission gate (tool_call hook)", () => {
  test("denies a hard-denied command regardless of mode", async () => {
    expect(blocked(await decideBash("git push origin main"))).toBe(true)
  })

  test("allows a known-safe command without prompting", async () => {
    const asked: PermissionPromptInfo[] = []
    const progress: ProgressUI = { ...noopProgress, askPermission: async (info) => (asked.push(info), "reject") }
    expect(blocked(await decideBash("git status", { progress }))).toBe(false)
    expect(asked).toHaveLength(0)
  })

  test("non-bash tools are always allowed (read/edit/write gated by tool set)", async () => {
    const handler = toolCallHandler({ interactive: true, directory: "/tmp" })
    const result = (await handler({ type: "tool_call", toolName: "edit", toolCallId: "c", input: {} } as ToolCallEvent)) ?? {}
    expect(blocked(result)).toBe(false)
  })

  test("mode 'all' auto-allows an ask-level command", async () => {
    expect(blocked(await decideBash("./deploy-prod.sh", { autoAccept: { mode: "all" } }))).toBe(false)
  })

  test("interactive prompt: reject blocks, once allows", async () => {
    const reply = (answer: PermissionReply): ProgressUI => ({ ...noopProgress, askPermission: async () => answer })
    expect(blocked(await decideBash("./deploy-prod.sh", { progress: reply("reject") }))).toBe(true)
    expect(blocked(await decideBash("./deploy-prod.sh", { progress: reply("once") }))).toBe(false)
  })

  test("non-interactive run rejects ask-level commands", async () => {
    expect(blocked(await decideBash("./deploy-prod.sh", { interactive: false }))).toBe(true)
  })
})
