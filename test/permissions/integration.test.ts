import { describe, expect, test } from "bun:test"

import { parseReply } from "../../src/permissions/remote"
import type { NtfyReply } from "../../src/notifications/inbox"

/**
 * Integration-level tests for the remote approvals pipeline.
 *
 * The parseReply function is the core parsing logic shared by askRemote.
 * The sendNotification and readInboxSince functions are thin network wrappers
 * tested separately in test/notifications/.
 *
 * The full askRemote flow (send → poll → parse) is exercised by the unit
 * tests for parseReply combined with the network mocks in test/notifications/.
 * A true end-to-end test requires a live ntfy topic and is out of scope for
 * automated CI.
 */

describe("remote approvals pipeline", () => {
  function reply(text: string): NtfyReply[] {
    return [{ timestamp: 1712345678, message: text, id: "msg1" }]
  }

  const requestId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

  test("full pipeline: parse natural language reply with ID prefix", () => {
    // Simulate: user replies "allow a1b2c3d4" to a permission prompt
    const result = parseReply(reply("allow a1b2c3d4"), requestId)
    expect(result).toBe("allow-once")
  })

  test("full pipeline: parse reject reply with ID prefix", () => {
    const result = parseReply(reply("reject a1b2c3d4"), requestId)
    expect(result).toBe("reject")
  })

  test("full pipeline: parse always-allow reply", () => {
    const result = parseReply(reply("always a1b2c3d4"), requestId)
    expect(result).toBe("always-allow")
  })

  test("full pipeline: ID prefix anywhere in message", () => {
    // User writes: "a1b2c3d4 allow" (prefix first)
    const result1 = parseReply(reply("a1b2c3d4 allow"), requestId)
    expect(result1).toBe("allow-once")

    // User writes: "please allow a1b2c3d4" (prefix last)
    const result2 = parseReply(reply("please allow a1b2c3d4"), requestId)
    expect(result2).toBe("allow-once")
  })

  test("full pipeline: shared topic ignores unrelated messages", () => {
    // The approvals topic is shared with notifications; unrelated messages
    // without the right ID prefix are ignored.
    const replies = [
      { timestamp: 1, message: "wopr · implementer done", id: "notif-1" },
      { timestamp: 2, message: "allow a1b2c3d4", id: "approval-1" },
      { timestamp: 3, message: "wopr · run complete", id: "notif-2" },
    ]
    const result = parseReply(replies, requestId)
    expect(result).toBe("allow-once")
  })

  test("full pipeline: multiple pending prompts distinguished by prefix", () => {
    // Two concurrent requests
    const requestId2 = "z9y8x7w6-v5u4-3210-abcd-ef1234567890"

    const replies = [
      { timestamp: 1, message: "reject a1b2c3d4", id: "reply-1" },
      { timestamp: 2, message: "allow z9y8x7w6", id: "reply-2" },
    ]

    const result1 = parseReply(replies, requestId)
    expect(result1).toBe("reject")

    const result2 = parseReply(replies, requestId2)
    expect(result2).toBe("allow-once")
  })
})
