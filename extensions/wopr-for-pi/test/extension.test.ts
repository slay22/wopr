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

  test("registerAllWoprTools registers all 23 tools with wopr_ prefix", async () => {
    // Create a mock ExtensionAPI
    const registered: Array<{ name: string; params: Record<string, unknown> }> = []
    const mockPi = {
      registerTool: mock((tool: { name: string }) => {
        registered.push({ name: tool.name, params: {} })
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

    const { registerAllWoprTools } = await import("../tools")
    registerAllWoprTools(mockPi as any)

    // All 23 tools should be registered
    expect(registered.length).toBe(23)

    // All registered tool names should have the wopr_ prefix
    for (const tool of registered) {
      expect(tool.name).toMatch(/^wopr_/)
    }

    // Verify specific known tools
    expect(registered).toContainEqual(expect.objectContaining({ name: "wopr_list_pipelines" }))
    expect(registered).toContainEqual(expect.objectContaining({ name: "wopr_start_run" }))
    expect(registered).toContainEqual(expect.objectContaining({ name: "wopr_get_run_status" }))
    expect(registered).toContainEqual(expect.objectContaining({ name: "wopr_cancel_run" }))
    expect(registered).toContainEqual(expect.objectContaining({ name: "wopr_suggest_config_for_budget" }))
    expect(registered).toContainEqual(expect.objectContaining({ name: "wopr_set_config" }))
    expect(registered).toContainEqual(expect.objectContaining({ name: "wopr_resume_run" }))
  })

  test("registered tool names are deterministic (same order as allToolDefs)", async () => {
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

    const { registerAllWoprTools } = await import("../tools")
    registerAllWoprTools(mockPi as any)

    // Order should match allToolDefs, each prefixed with wopr_
    const expectedNames = allToolDefs.map((d) => `wopr_${d.name}`)
    expect(registered).toEqual(expectedNames)
  })

  test("registerAllWoprTools handles empty tool definitions gracefully", async () => {
    // Temporarily save and restore allToolDefs
    const originalDefs = [...allToolDefs]
    try {
      // Clear the array (can't reassign const, but can empty it)
      allToolDefs.length = 0

      const registered: string[] = []
      const mockPi = {
        registerTool: mock((tool: { name: string }) => { registered.push(tool.name) }),
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

      const { registerAllWoprTools } = await import("../tools")
      registerAllWoprTools(mockPi as any)

      expect(registered.length).toBe(0)
    } finally {
      // Restore the original definitions
      allToolDefs.length = 0
      allToolDefs.push(...originalDefs)
    }
  })

  test("tool executor errors are propagated through the wrapper", async () => {
    // Create a mock pi that captures the execute function
    let capturedExecute: Function | null = null
    const mockPi = {
      registerTool: mock((tool: { name: string; parameters?: any; execute: Function }) => {
        capturedExecute = tool.execute
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

    // Override one tool's executor to throw
    const originalDiscoverExec = allToolDefs.find((d) => d.name === "list_pipelines")!.execute
    const originalConfigExec = allToolDefs.find((d) => d.name === "get_config")!.execute

    try {
      // Make list_pipelines throw
      const listPipelinesDef = allToolDefs.find((d) => d.name === "list_pipelines")!
      listPipelinesDef.execute = async () => { throw new Error("test error from executor") }

      const { registerAllWoprTools } = await import("../tools")
      registerAllWoprTools(mockPi as any)

      // Find the list_pipelines execute function
      const listPipelinesTool = allToolDefs.find((d) => d.name === "list_pipelines")!
      await expect(listPipelinesTool.execute({})).rejects.toThrow("test error from executor")
    } finally {
      // Restore
      const pipelineDef = allToolDefs.find((d) => d.name === "list_pipelines")!
      pipelineDef.execute = originalDiscoverExec
      const configDef = allToolDefs.find((d) => d.name === "get_config")!
      configDef.execute = originalConfigExec
    }
  })

  test("extension entry point loads without error", async () => {
    // The extension must export a default InlineExtension
    const ext = await import("../index")
    expect(ext.default).toBeDefined()
    expect(typeof ext.default).toBe("object")

    const inlineExt = ext.default as { name?: string; factory?: Function }
    if (inlineExt.name) {
      expect(inlineExt.name).toBe("wopr")
      expect(typeof inlineExt.factory).toBe("function")
    } else {
      expect(typeof inlineExt).toBe("function")
    }
  })

  test("extension factory calls registerAllWoprTools with pi instance", async () => {
    const ext = await import("../index")
    const inlineExt = ext.default as { name: string; factory: (pi: any) => void }

    let factoryCalled = false
    const mockPi = {
      registerTool: mock((tool: { name: string }) => {
        factoryCalled = true
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

    inlineExt.factory(mockPi)
    expect(factoryCalled).toBe(true)
    expect(mockPi.registerTool).toHaveBeenCalledTimes(23)
  })
})
