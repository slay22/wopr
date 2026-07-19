import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { parseNotificationUrl } from "../../src/notifications/parse"
import { sendNotification } from "../../src/notifications/ntfy"
import type { NtfyTarget, NotificationPayload } from "../../src/notifications/types"

/**
 * Lightweight integration test: verifies that parsed notification targets
 * produce the expected fetch call when sent, without actually reaching a
 * remote server.
 */
describe("notifications integration", () => {
  let fetchCalls: Array<{ url: string; options: RequestInit }> = []
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    fetchCalls = []
    globalThis.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
      fetchCalls.push({ url: String(url), options: options ?? {} })
      return new Response("ok", { status: 200 })
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("parse → send pipeline produces correct request shape", async () => {
    // Parse a URL the same way CLI config/flag parsing would
    const target = parseNotificationUrl("ntfy://wopr-test-topic") as NtfyTarget

    // Build a payload similar to what the dispatcher's formatEvent builds
    const payload: NotificationPayload = {
      title: "wopr · run started",
      message: "Pipeline: implement\nTarget: /tmp/test",
      priority: "default",
      tags: ["rocket", "wopr"],
    }

    // Send through the same function the dispatcher calls
    await sendNotification(target, payload)

    // Verify the request shape matches what ntfy.sh expects
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]!.url).toBe("https://ntfy.sh/wopr-test-topic")
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("text/plain")
    expect(headers["X-Tags"]).toBe("rocket,wopr")
    // default priority should not send Priority header
    expect(headers["Priority"]).toBeUndefined()
    expect(fetchCalls[0]!.options.method).toBe("POST")
    // Body should contain title and message
    const body = fetchCalls[0]!.options.body as string
    expect(body).toContain("wopr · run started")
    expect(body).toContain("Pipeline: implement")
  })

  test("parse → send with auth produces correct request", async () => {
    const target = parseNotificationUrl("ntfy://alice:secret@ntfy.example.com/team-alerts") as NtfyTarget

    const payload: NotificationPayload = {
      title: "wopr · test",
      message: "auth test",
      priority: "urgent",
      tags: ["bangbang", "wopr"],
    }

    await sendNotification(target, payload)

    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]!.url).toBe("https://ntfy.example.com/team-alerts")
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Authorization"]).toBe(`Basic ${btoa("alice:secret")}`)
    expect(headers["Priority"]).toBe("urgent")
  })

  test("parse → send with click URL produces Click header", async () => {
    const target = parseNotificationUrl("ntfy://wopr-test") as NtfyTarget

    const payload: NotificationPayload = {
      title: "wopr · report ready",
      message: "Click to view",
      priority: "high",
      tags: ["white_check_mark"],
      click: "https://example.com/report",
    }

    await sendNotification(target, payload)

    expect(fetchCalls.length).toBe(1)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Click"]).toBe("https://example.com/report")
  })
})
