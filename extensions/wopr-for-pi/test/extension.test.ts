import { describe, expect, test, mock } from "bun:test"
import { allToolDefs } from "../../../src/core/tools"

describe("wopr-for-pi extension", () => {
  test("allToolDefs has 23 tools (6 discovery + 4 config + 4 planning + 9 runs)", () => {
    expect(allToolDefs.length).toBe(23)
  })

  test("all tools have required fields", () => {
    for (const def of allToolDefs) {
      expect(def.name).toBeTruthy()
      expect(def.description).toBeTruthy()
      expect(def.inputSchema).toBeTruthy()
      expect(typeof def.execute).toBe("function")
    }
  })

  test("all tools have unique names", () => {
    const names = allToolDefs.map((d) => d.name)
    const uniqueNames = new Set(names)
    expect(uniqueNames.size).toBe(names.length)
  })

  test("tool names use snake_case", () => {
    for (const def of allToolDefs) {
      expect(def.name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  test("registerAllWoprTools registers all 23 tools", async () => {
    // Create a mock ExtensionAPI
    const registered: string[] = []
    const mockPi = {
      registerTool: mock((tool: { name: string }) => {
        registered.push(tool.name)
      }),
      on: mock(() => {}),
      registerCommand: mock(() => {}),
      registerShortcut: mock(() => {}),
      registerFlag: mock(() => {}),
      getFlag: mock(() => undefined),
      registerMessageRenderer: mock(() => {}),
      registerEntryRenderer: mock(() => {}),
      sendMessage: mock(() => {}),
      sendUserMessage: mock(() => {}),
      appendEntry: mock(() => {}),
      setSessionName: mock(() => {}),
      getSessionName: mock(() => undefined),
      setLabel: mock(() => {}),
      exec: mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })),
      getActiveTools: mock(() => []),
      getAllTools: mock(() => []),
      setActiveTools: mock(() => {}),
      getCommands: mock(() => []),
      setModel: mock(() => Promise.resolve(true)),
      getThinkingLevel: mock(() => "off" as const),
      setThinkingLevel: mock(() => {}),
      registerProvider: mock(() => {}),
      unregisterProvider: mock(() => {}),
      events: {} as any,
    }

    // Dynamic import to avoid type issues with the mock
    const { registerAllWoprTools } = await import("../tools")

    registerAllWoprTools(mockPi as any)

    expect(registered.length).toBe(23)
    expect(registered).toContain("wopr_list_pipelines")
    expect(registered).toContain("wopr_start_run")
    expect(registered).toContain("wopr_get_run_status")
    expect(registered).toContain("wopr_cancel_run")
    expect(registered).toContain("wopr_suggest_config_for_budget")
    expect(registered).toContain("wopr_set_config")
  })

  test("extension entry point loads without error", async () => {
    // The extension must export a default InlineExtension
    const ext = await import("../index")
    expect(ext.default).toBeDefined()
    expect(typeof ext.default).toBe("object")

    const inlineExt = ext.default as { name?: string; factory?: Function }
    // It can be a factory function or an object with name + factory
    if (inlineExt.name) {
      expect(inlineExt.name).toBe("wopr")
      expect(typeof inlineExt.factory).toBe("function")
    } else {
      expect(typeof inlineExt).toBe("function")
    }
  })
})
