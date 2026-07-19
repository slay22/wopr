/**
 * recommendPipeline — heuristic pipeline recommender.
 *
 * Keyword-based, no LLM. Maps prompt content + preferences to either a named
 * built-in pipeline or a custom steps array. Pure function, ~90 lines.
 */

import type { StepSpec } from "../pipeline"
import type { PipelineRecommendation, RecommendPipelineInput } from "./types"

/** Keywords that signal intent, ordered by specificity. */
type IntentGroup = {
  name: string
  keywords: string[]
  /* Preferred named pipeline when the intent is matched. */
  named: string
  /* When true, prefer a custom steps array over the named pipeline when combined with certain rigor/readOnly preferences. */
  customPreferred?: (input: RecommendPipelineInput) => boolean
  /* Build a custom steps array. Only called when customPreferred returns true. */
  buildCustom?: (input: RecommendPipelineInput) => StepSpec[]
}

const intentGroups: IntentGroup[] = [
  {
    name: "converge",
    keywords: ["converge", "self-correct", "iterate", "keep trying"],
    named: "converge",
  },
  {
    name: "review",
    keywords: ["review", "audit", "check", "what's wrong", "evaluate"],
    named: "review",
    customPreferred: (input) => input.preferences?.readOnly === true,
    buildCustom: () => [
      "review-scope",
      "clean-code-auditor",
      "security-reviewer",
      "bug-auditor",
      "review-report",
    ],
  },
  {
    name: "refine",
    keywords: ["fix issues", "apply fixes", "polish", "harden", "tidy", "clean up"],
    named: "refine",
    customPreferred: (input) => input.preferences?.rigor === "low",
    buildCustom: () => ["review-scope", "bug-auditor", "review-fixer", "review-validator"],
  },
  {
    name: "implement",
    keywords: ["add", "implement", "build", "create", "write", "feature", "new"],
    named: "implement",
    customPreferred: (input) => input.preferences?.rigor === "low",
    buildCustom: () => ["implementer", "tests"],
  },
]

/**
 * Recommend a pipeline based on prompt content and user preferences.
 *
 * @returns A PipelineRecommendation — either a named built-in pipeline or a
 *          custom steps array.
 */
export function recommendPipeline(input: RecommendPipelineInput): PipelineRecommendation {
  const prompt = input.prompt.toLowerCase()
  const prefs = input.preferences

  // 1. Read-only preference forces review.
  if (prefs?.readOnly) {
    if (prefs.rigor === "high") {
      return {
        kind: "custom",
        steps: [
          "review-scope",
          "security-reviewer",
          "adversarial-reviewer",
          "review-report",
        ],
        reason: "read-only review with high rigor: custom audit pipeline",
      }
    }
    return { kind: "named", pipeline: "review", reason: "read-only review requested" }
  }

  // 2. changeExisting = true → prefer refine or review over implement.
  if (prefs?.changeExisting) {
    if (prefs.rigor === "high") {
      return {
        kind: "custom",
        steps: ["security-auditor", "adversarial-reviewer", "review-fixer", "review-validator"],
        reason: "high-rigor fix pipeline on existing code",
      }
    }
    return { kind: "named", pipeline: "refine", reason: "change existing code; named refine pipeline" }
  }

  // 3. Keyword matching.
  for (const group of intentGroups) {
    const matched = group.keywords.some((kw) => prompt.includes(kw))
    if (!matched) continue

    // Check rigor/readOnly preferences for custom pipeline.
    if (prefs?.rigor === "high") {
      if (group.name === "implement") {
        return { kind: "named", pipeline: "ultra-implement", reason: "high-rigor implementation" }
      }
      if (group.name === "review" || group.name === "refine") {
        return { kind: "named", pipeline: "ultra-refine", reason: "high-rigor review/refine" }
      }
    }

    if (prefs?.rigor === "low") {
      if (group.name === "implement") {
        return { kind: "named", pipeline: "implement-lite", reason: "low-rigor implementation (lite)" }
      }
      if (group.name === "review") {
        return { kind: "named", pipeline: "review-lite", reason: "low-rigor review (lite)" }
      }
    }

    // Custom pipeline preferred?
    if (group.customPreferred && group.buildCustom && group.customPreferred(input)) {
      return {
        kind: "custom",
        steps: group.buildCustom(input),
        reason: `custom pipeline for ${group.name} intent`,
      }
    }

    return { kind: "named", pipeline: group.named, reason: `matched intent: ${group.name}` }
  }

  // 4. Budget preference.
  if (prefs?.budget === "low") {
    return { kind: "named", pipeline: "implement-lite", reason: "low-budget preference" }
  }

  // 5. Fallback: implement with a rationale.
  return {
    kind: "named",
    pipeline: "implement",
    reason: "default: no specific intent detected, using implement pipeline",
  }
}
