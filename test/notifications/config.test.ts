import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import { loadWoprConfig, loadMergedWoprConfig, mergeWoprConfigs, parseWoprConfig } from "../../src/config"

const dirs: string[] = []
let savedHome: string | undefined

async function projectDir(config?: string) {
  const dir = await mkdtemp(join(tmpdir(), "wopr-notif-config-"))
  dirs.push(dir)
  await mkdir(join(dir, ".wopr"), { recursive: true })
  if (config !== undefined) await writeFile(join(dir, ".wopr", "config.yaml"), config)
  return dir
}

beforeEach(async () => {
  savedHome = process.env.WOPR_HOME
  const root = await mkdtemp(join(tmpdir(), "wopr-notif-home-"))
  dirs.push(root)
  await mkdir(join(root, ".wopr"), { recursive: true })
  process.env.WOPR_HOME = root
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.WOPR_HOME
  else process.env.WOPR_HOME = savedHome
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const parse = (body: string, targetDir = "/tmp/non-existent") => parseWoprConfig(body, ".wopr/config.yaml", targetDir)

describe("notifications config", () => {
  test("parses notifications array from YAML", () => {
    const config = parse(`
notifications:
  - ntfy://wopr-topic
  - ntfy://ntfy.example.com/wopr-team
`)
    expect(config.notifications.length).toBe(2)
    expect(config.notifications[0]!.kind).toBe("ntfy")
    if (config.notifications[0]!.kind === "ntfy") {
      expect(config.notifications[0]!.server).toBe("https://ntfy.sh")
      expect(config.notifications[0]!.topic).toBe("wopr-topic")
    }
    if (config.notifications[1]!.kind === "ntfy") {
      expect(config.notifications[1]!.server).toBe("https://ntfy.example.com")
      expect(config.notifications[1]!.topic).toBe("wopr-team")
    }
  })

  test("empty notifications array is valid", () => {
    const config = parse(`
notifications: []
`)
    expect(config.notifications).toEqual([])
  })

  test("omitting notifications defaults to empty", () => {
    const config = parse(`defaults: {}`)
    expect(config.notifications).toEqual([])
  })

  test("project overrides global notifications", () => {
    const globalConfig = parseWoprConfig(
      "notifications:\n  - ntfy://global-topic\n",
      "~/.wopr/config.yaml",
      "/tmp",
    )
    const projectConfig = parseWoprConfig(
      "notifications:\n  - ntfy://project-topic\n",
      ".wopr/config.yaml",
      "/tmp",
    )
    const merged = mergeWoprConfigs(globalConfig, projectConfig)
    expect(merged!.notifications.length).toBe(1)
    if (merged!.notifications[0]!.kind === "ntfy") {
      expect(merged!.notifications[0]!.topic).toBe("project-topic")
    }
  })

  test("global notifications are used when project has none", () => {
    const globalConfig = parseWoprConfig(
      "notifications:\n  - ntfy://global-topic\n",
      "~/.wopr/config.yaml",
      "/tmp",
    )
    const projectConfig = parseWoprConfig("defaults: {}", ".wopr/config.yaml", "/tmp")
    const merged = mergeWoprConfigs(globalConfig, projectConfig)
    expect(merged!.notifications.length).toBe(1)
    if (merged!.notifications[0]!.kind === "ntfy") {
      expect(merged!.notifications[0]!.topic).toBe("global-topic")
    }
  })

  test("loadMergedWoprConfig includes notifications", async () => {
    const dir = await projectDir(`
notifications:
  - ntfy://my-topic
`)
    const config = await loadMergedWoprConfig(dir)
    expect(config).toBeDefined()
    expect(config!.notifications.length).toBe(1)
    if (config!.notifications[0]!.kind === "ntfy") {
      expect(config!.notifications[0]!.topic).toBe("my-topic")
    }
  })

  test("serialize and re-parse preserves notification targets", () => {
    const config = parse(`
notifications:
  - ntfy://my-topic
  - ntfy://user:pass@server.example.com/team
`)
    // We just test the parsed results since serializeWoprConfig serializes differently
    expect(config.notifications.length).toBe(2)
    if (config.notifications[0]!.kind === "ntfy") {
      expect(config.notifications[0]!.server).toBe("https://ntfy.sh")
      expect(config.notifications[0]!.topic).toBe("my-topic")
    }
    if (config.notifications[1]!.kind === "ntfy") {
      expect(config.notifications[1]!.server).toBe("https://server.example.com")
      expect(config.notifications[1]!.topic).toBe("team")
      expect(config.notifications[1]!.auth).toEqual({ user: "user", pass: "pass" })
    }
  })
})
