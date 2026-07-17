import { describe, expect, test } from "bun:test"

import { cleanBranchName, fallbackBranchName, slugifyBranch } from "../src/worktree"

// askForBranchName now drives a real pi session (see src/pi.ts), so its
// behavior is exercised by the end-to-end run rather than unit-mocked here.

describe("worktree branch name helpers", () => {
  test("cleanBranchName coerces model replies into git-safe kebab-case", () => {
    expect(cleanBranchName("Add onboarding flow")).toBe("add-onboarding-flow")
    expect(cleanBranchName("Fix bug #123 (login redirect)")).toBe("fix-bug-123-login-redirect")
    expect(cleanBranchName("`refactor-config-tui`")).toBe("refactor-config-tui")
    expect(cleanBranchName("  FEATURE: dark mode!!  ")).toBe("feature-dark-mode")
    expect(cleanBranchName("implementar onboarding en español")).toBe("implementar-onboarding-en-espa-ol")
  })

  test("cleanBranchName reads the last non-empty line so investigation chatter is ignored", () => {
    expect(cleanBranchName("Looking up DEV-1339…\nThe issue is about push reminders.\n\nadd-push-reminders\n")).toBe("add-push-reminders")
    expect(cleanBranchName("add-onboarding-flow\n")).toBe("add-onboarding-flow")
  })

  test("cleanBranchName prefixes a leading digit so the name isn't ambiguous", () => {
    expect(cleanBranchName("123 fix login")).toBe("task-123-fix-login")
    expect(cleanBranchName("404-page")).toBe("task-404-page")
  })

  test("cleanBranchName rejects empty / punctuation-only replies", () => {
    expect(cleanBranchName("")).toBe("")
    expect(cleanBranchName("--- !!! ---")).toBe("")
    expect(cleanBranchName("a")).toBe("a")
  })

  test("cleanBranchName caps overly long names", () => {
    const long = "fix-" + "a".repeat(60)
    const cleaned = cleanBranchName(long)
    expect(cleaned.length).toBeLessThanOrEqual(40)
    expect(cleaned.startsWith("fix-")).toBe(true)
  })

  test("fallbackBranchName is deterministic in shape and git-safe", () => {
    const name = fallbackBranchName()
    expect(name).toMatch(/^wopr-\d{8}-[a-z0-9]{4}$/)
    expect(name.length).toBeLessThanOrEqual(40)
  })

  test("slugifyBranch mirrors cleanBranchName rules for the worktree directory", () => {
    expect(slugifyBranch("Add Onboarding Flow")).toBe("add-onboarding-flow")
    expect(slugifyBranch("feature/foo bar")).toBe("feature-foo-bar")
    // Always returns something, even for garbage input.
    expect(slugifyBranch("!!!")).toMatch(/^wopr-[a-z0-9]{6}$/)
  })
})
