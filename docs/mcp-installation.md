# Installing the wopr MCP server

`wopr mcp` exposes the 23 core API functions as MCP tools over **stdio** (JSON-RPC 2.0). It is intended for **local, trusted coding agents** — there is no authentication and no remote transport (HTTP/SSE is a follow-up). The agent launches `wopr mcp` as a child process and talks to it over stdin/stdout.

> **`cwd` matters.** Most tools accept an optional `targetDir`. When omitted they default to the server's working directory, so set the agent's `cwd` to the project you want wopr to operate on (as shown below).

## Claude Code

Add to your project's `.mcp.json` (or `~/.claude.json` for a global server):

```json
{
  "mcpServers": {
    "wopr": {
      "command": "wopr",
      "args": ["mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

## Cursor

Add to `.cursor/mcp.json` in your project (same shape as the Claude Code config):

```json
{
  "mcpServers": {
    "wopr": {
      "command": "wopr",
      "args": ["mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

## Codex (OpenAI Codex CLI)

Add a `[mcp_servers.<name>]` table to `~/.codex/config.toml`:

```toml
[mcp_servers.wopr]
command = "wopr"
args = ["mcp"]
```

> Codex does not take a `cwd` in this table; run `codex` from inside your project directory so wopr's default `targetDir` resolves correctly.

## Verifying the install

After configuring, confirm the server resolves and lists its tools:

```bash
wopr mcp --version      # → wopr 0.1.0 (MCP server ready)
wopr mcp --list-tools   # → 23 tool names + descriptions
```

When the agent starts, it will call `tools/list` and receive all 23 tools
(`list_pipelines`, `describe_pipeline`, `start_run`, `get_run_status`, …). See
`AGENTS.md` §15 for the full tool table, error codes, and a worked example.

## Notes / caveats

- **stdio only.** No HTTP/SSE, no auth. Run behind a tunnel if you need remote access.
- **No namespacing.** All 23 tools are flat with `snake_case` names.
- **`set_config` and `start_run --yolo/--smart` are powerful.** They can write config (including global) and run headless bash. This is by design for a trusted local agent; gate it before any non-local exposure.
