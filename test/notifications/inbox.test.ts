import { describe, expect, test } from "bun:test"

import { parseNtfyJsonFeed } from "../../src/notifications/inbox"

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
