import type { Phase } from "./types"

export const defaultGptModel = "openai/gpt-5.5"
export const defaultGptVariant = "xhigh"
export const defaultOpusModel = "anthropic/claude-opus-4-7"

export const phases = [
  {
    name: "implementer",
    agentName: "implementer",
    model: defaultGptModel,
    variant: defaultGptVariant,
    description: "Implements the feature described in the PRD",
    inputFiles: ["prd.md"],
    inputDiff: false,
    reportPath: "reports/implementer.md",
  },
  {
    name: "patterns",
    agentName: "pattern-auditor",
    model: defaultGptModel,
    variant: defaultGptVariant,
    description: "Audits patterns and best practices, applies refactoring",
    inputFiles: ["prd.md", "reports/implementer.md"],
    inputDiff: true,
    reportPath: "reports/patterns.md",
  },
  {
    name: "security",
    agentName: "security-auditor",
    model: defaultGptModel,
    variant: defaultGptVariant,
    description: "Audits security and applies fixes",
    inputFiles: ["prd.md", "reports/patterns.md"],
    inputDiff: true,
    reportPath: "reports/security.md",
  },
  {
    name: "design",
    agentName: "design-polisher",
    model: defaultOpusModel,
    description: "Polishes UI following the repo's design system",
    inputFiles: ["prd.md", "reports/security.md"],
    inputDiff: true,
    reportPath: "reports/design.md",
  },
  {
    name: "tests",
    agentName: "test-engineer",
    model: defaultGptModel,
    variant: defaultGptVariant,
    description: "Ensures automated tests and relevant E2E coverage",
    inputFiles: ["prd.md"],
    inputDiff: true,
    reportPath: "reports/tests.md",
  },
  {
    name: "adversarial",
    agentName: "adversarial-reviewer",
    model: defaultOpusModel,
    description: "Performs a final adversarial review before PR creation",
    inputFiles: [
      "prd.md",
      "reports/implementer.md",
      "reports/patterns.md",
      "reports/security.md",
      "reports/design.md",
      "reports/tests.md",
    ],
    inputDiff: true,
    reportPath: "reports/adversarial.md",
  },
] as const satisfies readonly Phase[]

export type PhaseName = (typeof phases)[number]["name"]
export type AgentName = (typeof phases)[number]["agentName"]
