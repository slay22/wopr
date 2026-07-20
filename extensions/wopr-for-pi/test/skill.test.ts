import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const skillPath = resolve(__dirname, "..", "skill.md")

describe("wopr-for-pi SKILL.md", () => {
  test("skill.md exists and is readable", () => {
    const content = readFileSync(skillPath, "utf8")
    expect(content.length).toBeGreaterThan(0)
  })

  test("skill.md has a top-level heading", () => {
    const content = readFileSync(skillPath, "utf8")
    const lines = content.split("\n")
    const heading = lines.find((l) => l.startsWith("# "))
    expect(heading).toBeTruthy()
    expect(heading).toContain("wopr")
  })

  test("skill.md references all 23 tool names", () => {
    const content = readFileSync(skillPath, "utf8")
    const toolNames = [
      "list_pipelines",
      "describe_pipeline",
      "list_agents",
      "describe_agent",
      "list_models",
      "describe_model",
      "get_config",
      "validate_config",
      "diff_config",
      "set_config",
      "preview_run",
      "estimate_cost",
      "suggest_config_for_budget",
      "recommend_pipeline",
      "start_run",
      "get_run_status",
      "list_runs",
      "get_run_report",
      "get_run_cost",
      "get_run_diff",
      "get_run_commits",
      "cancel_run",
      "resume_run",
    ]

    for (const name of toolNames) {
      expect(content).toContain(name)
    }
  })

  test("skill.md has sections for usage guidance", () => {
    const content = readFileSync(skillPath, "utf8")
    expect(content).toContain("When to use wopr")
    expect(content).toContain("The natural sequence")
    expect(content).toContain("Don't shell out to the `wopr` CLI")
    expect(content).toContain("Cost and time")
    expect(content).toContain("Permission prompts")
  })

  test("skill.md has no broken markdown links", () => {
    const content = readFileSync(skillPath, "utf8")
    // Check for markdown links [...]() - they should either be empty or have content
    const linkPattern = /\[([^\]]*)\]\(([^)]*)\)/g
    let match
    while ((match = linkPattern.exec(content)) !== null) {
      const [, text, url] = match
      // Text should not be empty
      expect(text.trim().length).toBeGreaterThan(0)
      // URL should either be empty (placeholder) or valid
      if (url.length > 0) {
        expect(url.startsWith("http") || url.startsWith("#") || url.startsWith("./") || url.startsWith("../") || url.startsWith("mailto:")).toBe(true)
      }
    }
  })
})
