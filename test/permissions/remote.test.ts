import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { askRemote, parseReply } from "../../src/permissions/remote"
import type { ApprovalRequest } from "../../src/permissions/remote"
import type { ApprovalsConfig } from "../../src/types"
import type { NtfyReply } from "../../src/notifications/inbox"

describe("parseReply", () => {
  const requestId = "a1b2c3d4e5f6g7h8"
  const idPrefix = "a1b2c3d4"

  function reply(text: string): NtfyReply[] {
    return [{ timestamp: 1712345678, message: text, id: "msg1" }]
  }

  test("returns allow-once for 'allow <id-prefix>'", () => {
    expect(parseReply(reply(`allow ${idPrefix}`), requestId)).toBe("allow-once")
  })

  test("returns always-allow for 'always <id-prefix>'", () => {
    expect(parseReply(reply(`always ${idPrefix}`), requestId)).toBe("always-allow")
  })

  test("returns reject for 'reject <id-prefix>'", () => {
    expect(parseReply(reply(`reject ${idPrefix}`), requestId)).toBe("reject")
  })

  test("parses natural language: 'approve'", () => {
    expect(parseReply(reply(`approve ${idPrefix}`), requestId)).toBe("allow-once")
  })

  test("parses natural language: 'yes'", () => {
    expect(parseReply(reply(`yes ${idPrefix}`), requestId)).toBe("allow-once")
  })

  test("parses natural language: 'deny'", () => {
    expect(parseReply(reply(`deny ${idPrefix}`), requestId)).toBe("reject")
  })

  test("parses natural language: 'no'", () => {
    expect(parseReply(reply(`no ${idPrefix}`), requestId)).toBe("reject")
  })

  test("parses natural language: 'allow always'", () => {
    expect(parseReply(reply(`allow always ${idPrefix}`), requestId)).toBe("always-allow")
  })

  test("parses shorthand: 'o' for once", () => {
    expect(parseReply(reply(`o ${idPrefix}`), requestId)).toBe("allow-once")
  })

  test("parses shorthand: 'a' for always", () => {
    expect(parseReply(reply(`a ${idPrefix}`), requestId)).toBe("always-allow")
  })

  test("parses shorthand: 'r' for reject", () => {
    expect(parseReply(reply(`r ${idPrefix}`), requestId)).toBe("reject")
  })

  test("parses shorthand: 'y' for yes", () => {
    expect(parseReply(reply(`y ${idPrefix}`), requestId)).toBe("allow-once")
  })

  test("parses shorthand: 'n' for no", () => {
    expect(parseReply(reply(`n ${idPrefix}`), requestId)).toBe("reject")
  })

  test("ignores messages without the request ID prefix", () => {
    expect(parseReply(reply("allow unrelated"), requestId)).toBeUndefined()
  })

  test("case-insensitive matching", () => {
    expect(parseReply(reply(`ALLOW ${idPrefix}`), requestId)).toBe("allow-once")
    expect(parseReply(reply(`REJECT ${idPrefix}`), requestId)).toBe("reject")
    expect(parseReply(reply(`ALWAYS ${idPrefix}`), requestId)).toBe("always-allow")
  })

  test("request ID prefix can be anywhere in the message", () => {
    expect(parseReply(reply(`please allow ${idPrefix}`), requestId)).toBe("allow-once")
    expect(parseReply(reply(`${idPrefix} allow`), requestId)).toBe("allow-once")
  })

  test("returns undefined when no reply matches", () => {
    expect(parseReply(reply("hello world"), requestId)).toBeUndefined()
  })

  test("skips messages that don't contain the ID prefix", () => {
    const replies = [
      { timestamp: 1, message: "allow other", id: "msg1" },
      { timestamp: 2, message: `allow ${idPrefix}`, id: "msg2" },
    ]
    expect(parseReply(replies, requestId)).toBe("allow-once")
  })

  test("returns the first matching decision among multiple replies", () => {
    const replies = [
      { timestamp: 1, message: `allow ${idPrefix}`, id: "msg1" },
      { timestamp: 2, message: `reject ${idPrefix}`, id: "msg2" },
    ]
    expect(parseReply(replies, requestId)).toBe("allow-once")
  })
})

describe("askRemote (with mocked network)", () => {
  const originalFetch = globalThis.fetch
  let postBodies: string[] = []

  beforeEach(() => {
    postBodies = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /** Mocks ntfy: records POST bodies, returns the given inbox feed on GET. */
  function mockNtfy(inboxFeed: string) {
    globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
      const urlStr = String(url)
      if (options?.method === "POST") {
        postBodies.push(String(options.body ?? ""))
        return new Response("ok", { status: 200 })
      }
      // GET inbox feed (readInboxSince)
      if (urlStr.includes("/json?")) return new Response(inboxFeed, { status: 200 })
      return new Response("ok", { status: 200 })
    }) as typeof fetch
  }

  const topic: ApprovalsConfig["topic"] = { kind: "ntfy", server: "https://ntfy.sh", topic: "wopr-test" }
  const requestId = "a1b2c3d4-0000-0000-0000-000000000000"
  const allowFeed = `{"id":"m1","time":1712345678,"event":"message","topic":"wopr-test","message":"allow a1b2c3d4"}`

  function baseRequest(extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
      id: requestId,
      command: "rm -rf /tmp/foo",
      agent: "security-auditor",
      phase: "security",
      runId: "run-1",
      timestamp: 1712345670,
      ...extra,
    }
  }

  test("surfaces the safety judge reason in the approval notification", async () => {
    mockNtfy(allowFeed)
    const result = await askRemote(
      baseRequest({ judgeReason: "flagged by safety judge: destructive command" }),
      { topic, timeoutSeconds: 10, onTimeout: "reject" },
    )
    expect(result.decision).toBe("allow-once")
    expect(postBodies.length).toBe(1)
    // The same warning the interactive TTY prompt would show must be present.
    expect(postBodies[0]).toContain("flagged by safety judge: destructive command")
  }, 15000)

  test("omits the judge warning when the command was not flagged", async () => {
    mockNtfy(allowFeed)
    const result = await askRemote(baseRequest(), { topic, timeoutSeconds: 10, onTimeout: "reject" })
    expect(result.decision).toBe("allow-once")
    expect(postBodies.length).toBe(1)
    expect(postBodies[0]).not.toContain("⚠ Safety judge flagged")
  }, 15000)
})
