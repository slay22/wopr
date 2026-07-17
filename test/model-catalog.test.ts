import { describe, expect, test } from "bun:test"

import type { Model } from "@earendil-works/pi-ai/compat"

import { parseModelsDev, toModelChoices } from "../src/model-catalog"

const piModel = (provider: string, id: string, name: string, contextWindow?: number) =>
  ({ provider, id, name, contextWindow }) as unknown as Model<any>

describe("toModelChoices", () => {
  test("maps pi models to provider/id choices with context size", () => {
    const choices = toModelChoices([
      piModel("openai", "gpt-5.5", "GPT-5.5", 400_000),
      piModel("anthropic", "claude-opus-4-7", "Opus"),
    ])
    expect(choices.map((choice) => choice.value)).toEqual(["openai/gpt-5.5", "anthropic/claude-opus-4-7"])
    expect(choices[0]).toMatchObject({ value: "openai/gpt-5.5", label: "GPT-5.5", providerID: "openai", contextK: 400 })
    expect(choices[1]?.contextK).toBeUndefined()
  })

  test("dedupes repeated provider/id values", () => {
    const choices = toModelChoices([piModel("x", "m", "M"), piModel("x", "m", "M again")])
    expect(choices.map((choice) => choice.value)).toEqual(["x/m"])
  })
})

describe("parseModelsDev", () => {
  test("flattens providers/models and sorts by value", () => {
    const data = {
      openai: { models: { "gpt-5.5": { name: "GPT-5.5", limit: { context: 400_000 } } } },
      anthropic: { models: { "claude-opus-4-7": { name: "Opus" } } },
    }
    const choices = parseModelsDev(data)
    expect(choices.map((choice) => choice.value)).toEqual(["anthropic/claude-opus-4-7", "openai/gpt-5.5"])
    expect(choices.find((choice) => choice.value === "openai/gpt-5.5")).toMatchObject({ label: "GPT-5.5", contextK: 400 })
  })

  test("tolerates providers without models", () => {
    expect(parseModelsDev({ openai: {} })).toEqual([])
  })
})
