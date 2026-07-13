import { describe, expect, test } from "bun:test"

import { jwtExpMs, openRouterKeyFrom, parseCodexUsage, parseOpenRouterCredits, parseOpenRouterKey } from "../src/limits"

describe("codex usage parsing", () => {
  test("reads both windows and normalizes reset_at from epoch seconds", () => {
    const limits = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 42, reset_at: 1_752_400_000, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 18, reset_at: 1_752_900_000, limit_window_seconds: 604_800 },
      },
    })

    expect(limits).toEqual({ sessionPct: 42, sessionResetsAt: 1_752_400_000_000, weeklyPct: 18 })
  })

  test("passes reset_at through when already in milliseconds", () => {
    const limits = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 7, reset_at: 1_752_400_000_000 } },
    })

    expect(limits?.sessionResetsAt).toBe(1_752_400_000_000)
  })

  test("session window alone is enough; weekly stays undefined", () => {
    const limits = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 90 } } })

    expect(limits).toEqual({ sessionPct: 90, sessionResetsAt: undefined, weeklyPct: undefined })
  })

  test("non-numeric or missing primary window yields no data", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "42" } } })).toBeUndefined()
    expect(parseCodexUsage({ rate_limit: { secondary_window: { used_percent: 18 } } })).toBeUndefined()
    expect(parseCodexUsage({})).toBeUndefined()
    expect(parseCodexUsage(undefined)).toBeUndefined()
  })
})

describe("jwt expiry", () => {
  test("decodes exp into epoch ms", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_752_400_000 })).toString("base64url")
    expect(jwtExpMs(`header.${payload}.signature`)).toBe(1_752_400_000_000)
  })

  test("fails safe on malformed tokens", () => {
    expect(jwtExpMs("not-a-jwt")).toBeNull()
    const noExp = Buffer.from(JSON.stringify({ sub: "user" })).toString("base64url")
    expect(jwtExpMs(`header.${noExp}.signature`)).toBeNull()
  })
})

describe("openrouter parsing", () => {
  test("credits endpoint: balance is purchased minus used", () => {
    expect(parseOpenRouterCredits({ data: { total_credits: 20, total_usage: 7.66 } })).toEqual({
      kind: "remaining",
      amount: 12.34,
    })
  })

  test("credits endpoint: missing fields yield no data", () => {
    expect(parseOpenRouterCredits({ data: { total_credits: 20 } })).toBeUndefined()
    expect(parseOpenRouterCredits({})).toBeUndefined()
  })

  test("key endpoint: a capped key reports what's left on it", () => {
    expect(parseOpenRouterKey({ data: { limit: 50, limit_remaining: 12.34, usage_monthly: 4.2 } })).toEqual({
      kind: "remaining",
      amount: 12.34,
    })
  })

  test("key endpoint: a limitless key falls back to monthly spend", () => {
    expect(parseOpenRouterKey({ data: { limit: null, limit_remaining: null, usage_monthly: 4.2 } })).toEqual({
      kind: "monthly",
      amount: 4.2,
    })
    expect(parseOpenRouterKey({ data: { limit_remaining: null, usage: 9.5 } })).toEqual({ kind: "monthly", amount: 9.5 })
    expect(parseOpenRouterKey({ data: {} })).toBeUndefined()
    expect(parseOpenRouterKey("garbage")).toBeUndefined()
  })
})

describe("openrouter key resolution", () => {
  const opencodeAuth = { openrouter: { type: "api", key: "sk-or-from-opencode" } }

  test("the environment wins over opencode's stored key", () => {
    expect(openRouterKeyFrom({ OPENROUTER_API_KEY: "sk-or-from-env" }, opencodeAuth)).toBe("sk-or-from-env")
  })

  test("falls back to opencode's api-type entry", () => {
    expect(openRouterKeyFrom({}, opencodeAuth)).toBe("sk-or-from-opencode")
  })

  test("ignores oauth entries, empty keys, and missing files", () => {
    expect(openRouterKeyFrom({}, { openrouter: { type: "oauth" } })).toBeUndefined()
    expect(openRouterKeyFrom({}, { openrouter: { type: "api", key: "" } })).toBeUndefined()
    expect(openRouterKeyFrom({}, undefined)).toBeUndefined()
  })
})
