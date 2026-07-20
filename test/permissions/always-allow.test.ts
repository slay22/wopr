import { existsSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import { AlwaysAllowStore } from "../../src/permissions/always-allow"

// Save original WOPR_HOME
const originalHome = process.env.WOPR_HOME

describe("AlwaysAllowStore", () => {
  const testHome = mkdtempSync(join(tmpdir(), "wopr-test-aa-"))

  beforeEach(() => {
    process.env.WOPR_HOME = testHome
  })

  afterEach(async () => {
    // Clean up state directory
    await rm(join(testHome, ".wopr", "state"), { recursive: true, force: true }).catch(() => {})
  })

  // Restore after all
  afterAll(() => {
    if (originalHome === undefined) delete process.env.WOPR_HOME
    else process.env.WOPR_HOME = originalHome
    rm(testHome, { recursive: true, force: true }).catch(() => {})
  })

  test("check returns false for unknown pattern", async () => {
    const store = new AlwaysAllowStore("test-run-1")
    expect(await store.check("unknown command")).toBe(false)
  })

  test("check returns true after adding a pattern", async () => {
    const store = new AlwaysAllowStore("test-run-2")
    await store.add("find . -name '*.lock'")
    expect(await store.check("find . -name '*.lock'")).toBe(true)
    await store.clear()
  })

  test("state is persisted to disk", async () => {
    const store1 = new AlwaysAllowStore("test-run-3")
    await store1.add("git pull")
    await store1.clear() // flush & cleanup

    // Create a new store for the same run ID and verify
    // The file should have been cleared by clear()
    const store2 = new AlwaysAllowStore("test-run-3")
    expect(await store2.check("git pull")).toBe(false)
  })

  test("state survives restart (file is written)", async () => {
    const store1 = new AlwaysAllowStore("test-run-4")
    await store1.add("deploy command")

    // Check the file exists
    const statePath = join(testHome, ".wopr", "state", "test-run-4-always-allow.json")
    expect(existsSync(statePath)).toBe(true)

    // Read and verify content
    const content = JSON.parse(await readFile(statePath, "utf8"))
    expect(content.patterns).toContain("deploy command")

    // Create a new instance (simulating restart)
    const store2 = new AlwaysAllowStore("test-run-4")
    expect(await store2.check("deploy command")).toBe(true)
    expect(await store2.check("other command")).toBe(false)

    await store2.clear()
    expect(existsSync(statePath)).toBe(false)
  })

  test("clear removes the state file", async () => {
    const store = new AlwaysAllowStore("test-run-5")
    await store.add("some command")
    const statePath = join(testHome, ".wopr", "state", "test-run-5-always-allow.json")
    expect(existsSync(statePath)).toBe(true)

    await store.clear()
    expect(existsSync(statePath)).toBe(false)
    expect(await store.check("some command")).toBe(false)
  })

  test("multiple patterns are stored and checked independently", async () => {
    const store = new AlwaysAllowStore("test-run-6")
    await store.add("cmd-a")
    await store.add("cmd-b")
    await store.add("cmd-c")

    expect(await store.check("cmd-a")).toBe(true)
    expect(await store.check("cmd-b")).toBe(true)
    expect(await store.check("cmd-c")).toBe(true)
    expect(await store.check("cmd-d")).toBe(false)

    await store.clear()
  })
})


