import { spawnSync } from "node:child_process"
import { createServer } from "node:net"

import { createOpencode } from "@opencode-ai/sdk/v2"

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2"

export type OpencodeHandle = {
  client: OpencodeClient
  url: string
  close(): void
}

export async function startOpencode(config: Config, signal?: AbortSignal): Promise<OpencodeHandle> {
  const port = await freePort()
  const { client, server } = await createOpencode({
    hostname: "127.0.0.1",
    port,
    timeout: 30_000,
    signal,
    config,
  })

  return {
    client,
    url: server.url,
    close: server.close,
  }
}

export function openOpencodeSessionWindow(input: { url: string; targetDir: string; sessionID: string }) {
  if (process.platform !== "darwin") {
    throw new Error("opening a new OpenCode terminal window is currently implemented for macOS only")
  }

  const command = [
    process.env.PATH ? `export PATH=${shellQuote(process.env.PATH)}:$PATH` : "",
    ["opencode", "attach", input.url, "--dir", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "),
  ]
    .filter(Boolean)
    .join("; ")

  const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell`
  const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `osascript exited with status ${result.status}`)
}

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("couldn't find a free port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function appleScriptString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
