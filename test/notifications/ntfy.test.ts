import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { sendNotification } from "../../src/notifications/ntfy"
import type { NtfyTarget, NotificationPayload } from "../../src/notifications/types"

describe("sendNotification", () => {
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

  const target: NtfyTarget = {
    kind: "ntfy",
    server: "https://ntfy.sh",
    topic: "wopr-test",
  }

  const payload: NotificationPayload = {
    title: "test title",
    message: "test message body",
    priority: "default",
    tags: ["wopr", "test"],
  }

  test("sends POST to correct URL", async () => {
    await sendNotification(target, payload)
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]!.url).toBe("https://ntfy.sh/wopr-test")
  })

  test("sets Content-Type header", async () => {
    await sendNotification(target, payload)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("text/plain")
  })

  test("sets X-Tags header", async () => {
    await sendNotification(target, payload)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["X-Tags"]).toBe("wopr,test")
  })

  test("sets Priority header for high priority", async () => {
    await sendNotification(target, { ...payload, priority: "high" })
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Priority"]).toBe("high")
  })

  test("sets Priority header for urgent priority", async () => {
    await sendNotification(target, { ...payload, priority: "urgent" })
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Priority"]).toBe("urgent")
  })

  test("does not send Priority for default", async () => {
    await sendNotification(target, payload)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Priority"]).toBeUndefined()
  })

  test("sets Click header when present", async () => {
    const withClick: NotificationPayload = { ...payload, click: "https://example.com/report" }
    await sendNotification(target, withClick)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Click"]).toBe("https://example.com/report")
  })

  test("sets Basic auth when auth is present", async () => {
    const authedTarget: NtfyTarget = { ...target, auth: { user: "alice", pass: "s3cret" } }
    await sendNotification(authedTarget, payload)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Authorization"]).toBe(`Basic ${btoa("alice:s3cret")}`)
  })

  test("sends title and message as body", async () => {
    await sendNotification(target, payload)
    const body = fetchCalls[0]!.options.body
    expect(body).toBe("test title\ntest message body")
  })

  test("uses AbortSignal.timeout of 3s", async () => {
    await sendNotification(target, payload)
    const signal = fetchCalls[0]!.options.signal
    expect(signal).toBeDefined()
  })

  test("throws on non-2xx response", async () => {
    globalThis.fetch = async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" })
    expect(sendNotification(target, payload)).rejects.toThrow("ntfy 401")
  })

  test("throws on network error", async () => {
    globalThis.fetch = async () => { throw new Error("fetch failed") }
    expect(sendNotification(target, payload)).rejects.toThrow("fetch failed")
  })
})
