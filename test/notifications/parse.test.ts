import { describe, expect, test } from "bun:test"

import { parseNotificationUrl } from "../../src/notifications/parse"

describe("parseNotificationUrl", () => {
  test("parses ntfy://<topic> → ntfy.sh shorthand", () => {
    const result = parseNotificationUrl("ntfy://wopr-leo-1234")
    expect(result.kind).toBe("ntfy")
    if (result.kind === "ntfy") {
      expect(result.server).toBe("https://ntfy.sh")
      expect(result.topic).toBe("wopr-leo-1234")
      expect(result.auth).toBeUndefined()
    }
  })

  test("parses ntfy://<server>/<topic> → self-hosted, no auth", () => {
    const result = parseNotificationUrl("ntfy://ntfy.example.com/wopr-team")
    expect(result.kind).toBe("ntfy")
    if (result.kind === "ntfy") {
      expect(result.server).toBe("https://ntfy.example.com")
      expect(result.topic).toBe("wopr-team")
      expect(result.auth).toBeUndefined()
    }
  })

  test("parses ntfy://<user>:<pass>@<server>/<topic> → self-hosted with auth", () => {
    const result = parseNotificationUrl("ntfy://alice:s3cret@ntfy.example.com/wopr-private")
    expect(result.kind).toBe("ntfy")
    if (result.kind === "ntfy") {
      expect(result.server).toBe("https://ntfy.example.com")
      expect(result.topic).toBe("wopr-private")
      expect(result.auth).toEqual({ user: "alice", pass: "s3cret" })
    }
  })

  test("parses ntfy://<user>@<server>/<topic> → self-hosted with user (no pass)", () => {
    const result = parseNotificationUrl("ntfy://alice@ntfy.example.com/wopr-private")
    expect(result.kind).toBe("ntfy")
    if (result.kind === "ntfy") {
      expect(result.server).toBe("https://ntfy.example.com")
      expect(result.topic).toBe("wopr-private")
      // user-only without pass means no auth
      expect(result.auth).toBeUndefined()
    }
  })

  test("throws on non-ntfy URL", () => {
    expect(() => parseNotificationUrl("tg://12345")).toThrow("notification URL must start with \"ntfy://\"")
    expect(() => parseNotificationUrl("https://example.com")).toThrow("notification URL must start with \"ntfy://\"")
  })

  test("throws on empty topic", () => {
    expect(() => parseNotificationUrl("ntfy://")).toThrow()
  })

  test("throws on missing host", () => {
    expect(() => parseNotificationUrl("ntfy:///topic")).toThrow()
  })

  test("throws on empty topic after host", () => {
    expect(() => parseNotificationUrl("ntfy://example.com/")).toThrow()
  })

  test("does not echo credentials in error message", () => {
    // A wrong-scheme URL that happens to carry userinfo must not leak the
    // password when the parser reports the malformed input.
    let message = ""
    try {
      parseNotificationUrl("https://alice:s3cret@example.com/wopr-private")
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).not.toContain("s3cret")
    expect(message).toContain("***@")
  })
})
