import type { NtfyTarget, NotificationPayload } from "./types"

/**
 * Sends a notification to an ntfy server via a fire-and-forget POST.
 * Uses a 3-second AbortSignal.timeout.
 * Throws on non-2xx, timeout, or network error.
 */
export async function sendNotification(target: NtfyTarget, payload: NotificationPayload): Promise<void> {
  const url = `${target.server}/${target.topic}`
  const headers: Record<string, string> = {
    "Content-Type": "text/plain",
  }

  if (payload.tags.length > 0) {
    headers["X-Tags"] = payload.tags.join(",")
  }
  if (payload.priority !== "default") {
    headers["Priority"] = payload.priority
  }
  if (payload.click) {
    headers["Click"] = payload.click
  }
  if (target.auth) {
    const encoded = btoa(`${target.auth.user}:${target.auth.pass}`)
    headers["Authorization"] = `Basic ${encoded}`
  }

  const body = `${payload.title}\n${payload.message}`

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(3_000),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "no body")
    throw new Error(`ntfy ${response.status} (${response.statusText}): ${text}`)
  }
}
