import { sendNotification } from "../notifications/ntfy"
import { readInboxSince, type NtfyReply } from "../notifications/inbox"
import { AlwaysAllowStore } from "./always-allow"
import type { ApprovalsConfig } from "../types"

/**
 * A single permission approval request sent to the user.
 */
export type ApprovalRequest = {
  /** UUID identifying this specific prompt. */
  id: string
  /** The bash command the agent wants to run. */
  command: string
  /** Which agent asked. */
  agent: string
  /** Which phase. */
  phase: string
  /** Run ID. */
  runId: string
  /** Unix timestamp when the request was created. */
  timestamp: number
  /** When the safety judge flagged the command, its reason is escalated here. */
  judgeReason?: string
}

/**
 * The decision the user (or timeout) returned.
 */
export type ApprovalDecision = "allow-once" | "always-allow" | "reject"

export type AskRemoteResult = {
  decision: ApprovalDecision
  source: "user" | "timeout"
}

const defaultTimeoutSeconds = 300
const pollIntervalMs = 5_000

/**
 * Sends a permission request notification to the configured ntfy topic and
 * polls for the user's reply. Returns the decision or times out.
 */
export async function askRemote(
  request: ApprovalRequest,
  config: ApprovalsConfig,
  alwaysAllow?: AlwaysAllowStore,
): Promise<AskRemoteResult> {
  // Check if this command has been always-allowed already
  if (alwaysAllow) {
    const alreadyAllowed = await alwaysAllow.check(request.command)
    if (alreadyAllowed) {
      return { decision: "always-allow", source: "user" }
    }
  }

  // 1. Send the notification
  const priority = "high" as const
  const tags = ["key", "wopr"]

  const messageLines = [
    `Phase: ${request.phase}`,
    `Run:   ${request.runId}`,
    `Command: ${request.command}`,
  ]
  // Surface the safety judge's reasoning so the user reviewing on their phone
  // sees the same warning the interactive TTY prompt would show. Without this,
  // unattended approvals would happen blind to flagged-risk commands.
  if (request.judgeReason) {
    messageLines.push(``, `⚠ Safety judge flagged this command: ${request.judgeReason}`)
  }
  messageLines.push(
    ``,
    `Reply with:`,
    `  allow   — allow this once`,
    `  always  — allow for the rest of this run`,
    `  reject  — reject (run fails this phase)`,
  )

  await sendNotification(config.topic, {
    title: `🔐 wopr · ${request.agent} wants: ${truncate(request.command, 80)}`,
    message: messageLines.join("\n"),
    priority,
    tags,
  })

  // 2. Poll for the response
  const start = Date.now()
  const timeoutMs = (config.timeoutSeconds || defaultTimeoutSeconds) * 1000
  let since = Math.floor(request.timestamp)

  while (Date.now() - start < timeoutMs) {
    await sleep(pollIntervalMs)

    let replies: NtfyReply[]
    try {
      replies = await readInboxSince(config.topic, since)
    } catch {
      // Network error polling; continue trying until timeout
      continue
    }

    if (replies.length > 0) {
      // Update watermark to the latest message timestamp
      const latest = replies.reduce((max, r) => Math.max(max, r.timestamp), since)
      since = latest

      const decision = parseReply(replies, request.id)
      if (decision) {
        // If always-allow, persist it
        if (decision === "always-allow" && alwaysAllow) {
          await alwaysAllow.add(request.command)
        }
        return { decision, source: "user" }
      }
    }
  }

  // 3. Timeout
  return { decision: config.onTimeout || "reject", source: "timeout" }
}

/**
 * Parses natural-language replies from the ntfy topic to find a decision
 * matching the given request ID prefix.
 *
 * The reply format is loose: any message containing "allow", "always", or
 * "reject" prefixed with the first 8 chars of the request ID is parsed.
 * Users can write natural language like "allow", "allow always", "approve",
 * "deny", "reject", "no", etc.
 */
export function parseReply(replies: NtfyReply[], requestId: string): ApprovalDecision | undefined {
  const idPrefix = requestId.slice(0, 8).toLowerCase()

  for (const reply of replies) {
    const text = reply.message.trim().toLowerCase()

    // Must reference the request by ID prefix; the prefix can appear anywhere
    // in the message so users can write natural language like "allow a1b2c3d4"
    // or "a1b2c3d4 allow" or "please allow a1b2c3d4".
    if (!text.includes(idPrefix)) continue

    // Extract the decision text by removing the ID prefix
    const decisionText = text.replace(idPrefix, "").trim()

    // Check for always-allow
    if (decisionText.includes("always") || decisionText === "a") {
      return "always-allow"
    }

    // Check for allow (but not "always" which is caught above)
    if (decisionText.includes("allow") || decisionText.includes("approve") || decisionText.includes("yes") || decisionText === "y" || decisionText === "o" || decisionText === "once") {
      return "allow-once"
    }

    // Check for reject
    if (decisionText.includes("reject") || decisionText.includes("deny") || decisionText.includes("no") || decisionText === "n" || decisionText === "r") {
      return "reject"
    }
  }

  return undefined
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
