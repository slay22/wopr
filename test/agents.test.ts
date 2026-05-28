import { describe, expect, test } from "bun:test"

import { opencodeConfig } from "../src/agents"

describe("opencode config", () => {
  test("disables total provider timeouts but keeps idle stream timeouts", () => {
    const config = opencodeConfig("/tmp/archer-run")

    for (const provider of ["anthropic", "openai", "openrouter"]) {
      expect(config.provider?.[provider]?.options?.timeout).toBe(false)
      expect(config.provider?.[provider]?.options?.chunkTimeout).toBe(600_000)
    }
  })
})
