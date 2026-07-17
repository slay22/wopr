import { describe, expect, test } from "bun:test"

import { variantToThinkingLevel } from "../src/pi"

describe("variantToThinkingLevel", () => {
  test("maps known variants to pi thinking levels", () => {
    expect(variantToThinkingLevel("xhigh")).toBe("xhigh")
    expect(variantToThinkingLevel("high")).toBe("high")
    expect(variantToThinkingLevel("minimal")).toBe("minimal")
  })

  test("returns undefined for no variant or an unknown one", () => {
    expect(variantToThinkingLevel(undefined)).toBeUndefined()
    expect(variantToThinkingLevel("ludicrous")).toBeUndefined()
  })
})
