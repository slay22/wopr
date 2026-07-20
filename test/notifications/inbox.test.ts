import { afterEach, describe, expect, test } from "bun:test"

import { parseNtfyJsonFeed, readInboxSince } from "../../src/notifications/inbox"
import type { NtfyTarget } from "../../src/notifications/types"

describe("parseNtfyJsonFeed", () => {
  test("parses message events", () => {
    const body = `{"id":"msg1","time":1712345678,"event":"message","topic":"test","message":"allow abc12345"}
{"id":"msg2","time":1712345679,"event":"message","topic":"test","message":"reject def56789"}`
    const replies = parseNtfyJsonFeed(body)
    expect(replies.length).toBe(2)
    expect(replies[0]!.message).toBe("allow abc12345")
    expect(replies[0]!.timestamp).toBe(1712345678)
    expect(replies[0]!.id).toBe("msg1")
    expect(replies[1]!.message).toBe("reject def56789")
  })

  test("skips open and keepalive events", () => {
    const body = `{"id":"open1","time":1712345670,"event":"open","topic":"test"}
{"id":"msg1","time":1712345678,"event":"message","topic":"test","message":"allow abc12345"}
{"id":"ka1","time":1712345680,"event":"keepalive","topic":"test"}`
    const replies = parseNtfyJsonFeed(body)
    expect(replies.length).toBe(1)
    expect(replies[0]!.message).toBe("allow abc12345")
  })

  test("skips messages with empty body", () => {
    const body = `{"id":"msg1","time":1712345678,"event":"message","topic":"test","message":""}
{"id":"msg2","time":1712345679,"event":"message","topic":"test","message":"allow abc12345"}`
    const replies = parseNtfyJsonFeed(body)
    expect(replies.length).toBe(1)
    expect(replies[0]!.message).toBe("allow abc12345")
  })

  test("skips malformed JSON lines", () => {
    const body = `not json at all
{"id":"msg1","time":1712345678,"event":"message","topic":"test","message":"allow abc12345"}
{garbage`
    const replies = parseNtfyJsonFeed(body)
    expect(replies.length).toBe(1)
    expect(replies[0]!.message).toBe("allow abc12345")
  })

  test("returns empty array for empty input", () => {
    const replies = parseNtfyJsonFeed("")
    expect(replies).toEqual([])
  })
})

describe("readInboxSince (with mocked fetch)", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const target: NtfyTarget = {
    kind: "ntfy",
    server: "https://ntfy.sh",
    topic: "wopr-test",
  }

  const targetWithAuth: NtfyTarget = {
    kind: "ntfy",
    server: "https://ntfy.sh",
    topic: "wopr-test-auth",
    auth: { user: "admin", pass: "secret" },
  }

  /** Creates a properly-typed mock fetch function for the given behavior. */
  function makeFetch(fn: (url: string, options?: RequestInit) => Promise<Response>): typeof fetch {
    return fn as unknown as typeof fetch
  }

  test("sends GET request to correct URL with since and poll=1", async () => {
    let capturedUrl = ""
    globalThis.fetch = makeFetch((url) => {
      capturedUrl = url
      return Promise.resolve(new Response("", { status: 200 }))
    })
    await readInboxSince(target, 1712345600)
    expect(capturedUrl).toBe("https://ntfy.sh/wopr-test/json?since=1712345600&poll=1")
  })

  test("sets Accept header", async () => {
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = makeFetch((_url, options) => {
      capturedHeaders = (options?.headers ?? {}) as Record<string, string>
      return Promise.resolve(new Response("", { status: 200 }))
    })
    await readInboxSince(target, 1712345600)
    expect(capturedHeaders["Accept"]).toBe("application/json")
  })

  test("sets Basic auth when auth is present", async () => {
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = makeFetch((_url, options) => {
      capturedHeaders = (options?.headers ?? {}) as Record<string, string>
      return Promise.resolve(new Response("", { status: 200 }))
    })
    await readInboxSince(targetWithAuth, 1712345600)
    expect(capturedHeaders["Authorization"]).toBeDefined()
    // base64 of "admin:secret"
    expect(capturedHeaders["Authorization"]).toBe("Basic YWRtaW46c2VjcmV0")
  })

  test("parses messages from the response body", async () => {
    const body = `{"id":"m1","time":1712345678,"event":"message","topic":"test","message":"allow abc12345"}
{"id":"m2","time":1712345679,"event":"message","topic":"test","message":"reject def56789"}`
    globalThis.fetch = makeFetch(() => Promise.resolve(new Response(body, { status: 200 })))
    const replies = await readInboxSince(target, 1712345600)
    expect(replies.length).toBe(2)
    expect(replies[0]!.message).toBe("allow abc12345")
    expect(replies[1]!.message).toBe("reject def56789")
  })

  test("throws on non-2xx response", async () => {
    globalThis.fetch = makeFetch(() => Promise.resolve(new Response("Not Found", { status: 404 })))
    await expect(readInboxSince(target, 1712345600)).rejects.toThrow("ntfy inbox 404")
  })

  test("throws on network error", async () => {
    globalThis.fetch = makeFetch(() => Promise.reject(new Error("socket hang up")))
    await expect(readInboxSince(target, 1712345600)).rejects.toThrow("socket hang up")
  })

  test("handles empty response body", async () => {
    globalThis.fetch = makeFetch(() => Promise.resolve(new Response("", { status: 200 })))
    const replies = await readInboxSince(target, 1712345600)
    expect(replies).toEqual([])
  })

  test("uses AbortSignal.timeout of 10s", async () => {
    let capturedSignal: AbortSignal | null | undefined
    globalThis.fetch = makeFetch((_url, options) => {
      capturedSignal = options?.signal
      return Promise.resolve(new Response("", { status: 200 }))
    })
    await readInboxSince(target, 1712345600)
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(false)
  })
})
