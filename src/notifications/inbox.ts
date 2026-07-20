import type { NtfyTarget } from "./types"

/**
 * One reply message from the ntfy inbox.
 */
export type NtfyReply = {
  /** Unix seconds when the message was published. */
  timestamp: number
  /** The plain-text body of the reply. */
  message: string
  /** The ntfy event id (dedup key). */
  id: string
}

/**
 * Reads messages published to an ntfy topic since a given Unix timestamp.
 *
 * Uses ntfy's JSON feed endpoint (`/json?since=<ts>&poll=1`) which returns
 * all messages after `since` and then closes the connection (poll mode).
 *
 * The `since` parameter is a Unix timestamp in seconds; ntfy returns only
 * messages newer than that value. This is used as a watermark so the caller
 * only sees new replies on each poll.
 *
 * Throws on non-2xx, timeout, or network error (same error convention as
 * sendNotification).
 */
export async function readInboxSince(target: NtfyTarget, sinceUnixSec: number): Promise<NtfyReply[]> {
  const url = `${target.server}/${target.topic}/json?since=${sinceUnixSec}&poll=1`
  const headers: Record<string, string> = {
    Accept: "application/json",
  }

  if (target.auth) {
    const encoded = Buffer.from(`${target.auth.user}:${target.auth.pass}`).toString("base64")
    headers["Authorization"] = `Basic ${encoded}`
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "no body")
    throw new Error(`ntfy inbox ${response.status} (${response.statusText}): ${text}`)
  }

  const body = await response.text()
  return parseNtfyJsonFeed(body)
}

/**
 * Parses the ntfy JSON feed format. Each line is a JSON object representing
 * one message. The feed is newline-delimited JSON (one event per line).
 *
 * ntfy's JSON feed formats:
 * - {"id":"...","time":1712345678,"event":"message","topic":"...","message":"..."}
 * - {"id":"...","time":1712345678,"event":"open","topic":"..."} (connection open, skip)
 * - {"id":"...","time":1712345678,"event":"keepalive","topic":"..."} (keepalive, skip)
 */
export function parseNtfyJsonFeed(body: string): NtfyReply[] {
  const replies: NtfyReply[] = []
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      const parsed = JSON.parse(trimmed)
      // Only process actual message events, not open/keepalive
      if (parsed.event !== "message") continue
      if (typeof parsed.message !== "string" || !parsed.message.trim()) continue

      replies.push({
        timestamp: typeof parsed.time === "number" ? parsed.time : 0,
        message: parsed.message,
        id: typeof parsed.id === "string" ? parsed.id : "",
      })
    } catch {
      // Skip malformed JSON lines
      continue
    }
  }
  return replies
}
