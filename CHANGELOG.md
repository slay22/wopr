# Changelog

## Unreleased

### Added: Core API (`src/core/`)

- **New module `src/core/`.** A typed, callable, awaitable orchestrator surface
  for external consumers. The module exposes 22 functions across 4 concerns:
  discovery (`listPipelines`, `describePipeline`, `listAgents`, `describeAgent`,
  `listModels`, `describeModel`), config (`getConfig`, `validateConfig`,
  `diffConfig`, `setConfig`), planning (`previewRun`, `estimateCost`,
  `suggestConfigForBudget`), and run management (`startRun`, `getRunStatus`,
  `listRuns`, `getRunReport`, `getRunCost`, `getRunDiff`, `getRunCommits`,
  `cancelRun`, `resumeRun`). All functions are importable from
  `src/core/index.ts`.
- **`startRun` returns immediately.** Returns a `RunHandle` with `runId`,
  `promise`, and `abort()`. Callers poll `getRunStatus(runId)` or await
  `handle.promise` for the terminal state.
- **Typed errors.** `RunNotFoundError`, `ValidationError`, `AbortError` join
  the existing `ConfigError` and `BudgetExceededError`, all JSON-serializable.
- **Structured `Finding` type.** Reports can carry a `findings` array alongside
  free-form markdown (opt-in per phase; existing reports are unaffected).
- **`RunRegistry` singleton.** In-memory process-level registry in
  `src/core/_internal.ts` maps `runId → RunRegistration`, enabling
  `cancelRun` and `getRunStatus` to find in-flight runs by ID.
- **AGENTS.md §14** documents the full core API contract for transport PRDs.

### Added: MCP server (`src/mcp/`)

- **New module `src/mcp/`.** A stdio-based MCP (Model Context Protocol) server
  exposing the 22 core API functions as tools. The server speaks JSON-RPC 2.0
  over stdio — the universal transport for LLM-driven coding agents.
- **22 MCP tools.** Every core API function is exposed as a flat, snake_case
  tool with a hand-written JSON Schema for its input. See AGENTS.md §15 for
  the full list.
- **`wopr mcp` subcommand.** Start the MCP server with `wopr mcp`, inspect
  available tools with `wopr mcp --list-tools`, check the version with
  `wopr mcp --version`.
- **Error serialization.** `serializeError()` maps WOPR error classes to MCP
  error codes (`-32001` through `-32005` plus `-32603` for unknown errors).
- **`toJSON()` on all error classes.** `ConfigError`, `RunNotFoundError`,
  `ValidationError`, `AbortError`, and `BudgetExceededError` now have `toJSON()`
  methods so they serialize cleanly over JSON-RPC.
- **New dependency.** `@modelcontextprotocol/sdk` (MIT) — the official MCP SDK.
- **Test coverage.** 20 new tests covering the server setup, tools/list response,
  individual tool calls, error handling, and start/cancel lifecycle.

### Next up (separate PRDs)

- **pi extension** — `@earendil-works/wopr-for-pi` factory

### Added: Budgets (MVP)

- **Run cost cap.** Set a per-run USD budget with `--budget <usd>` (CLI),
  `defaults.budget.perRun` or `pipelines.<name>.budget` in `.wopr/config.yaml`.
  The run aborts cleanly with a `BudgetExceededError` before a phase that would
  exceed the cap; use `--budget-mode warn` (or `onExceed: warn-and-continue`) to
  warn-and-continue instead. `--no-budget` clears any config budget.
- **Cost tracking.** `CostTracker` records per-phase cost in `src/usage.ts`; the
  run's aggregate `RunCost` is persisted to run metadata (`cost`) on every phase
  end and on completion, so past run costs are visible in `wopr runs`.
- **Cost estimation.** `src/cost.ts` reads pi's `models-store.json` and exposes
  `rateForModel` / `estimateCost` / `estimateRunCost` for projecting spend.
- **Budget meter.** The run TUI shows a `BUDGET $spent/$cap (pct%)` bar next to
  the DEFCON meter, colored green < 60%, yellow < 90%, red ≥ 90% / over cap.
- **Config suggestion.** `suggestConfigForBudget()` (in `src/suggest.ts`) is a
  pure, deterministic function that proposes a wopr config (agents + pipeline
  steps) that fits a budget, with per-phase cost estimates — the building block
  for the future `wopr_suggest_config_for_budget` MCP tool.

### Notes / known MVP limitations

- `CostTracker.estimateNext()` uses a constant placeholder estimate
  (`$0.001`) until cost-history calibration lands; the cap is therefore enforced
  post-hoc (after the overshooting phase completes), not strictly pre-emptively.
- `Budget.perPhase` is typed and parsed but not yet enforced (deferred).
- `CostEntry` component costs (`inputCost`, `outputCost`, `cacheReadCost`,
  `cacheWriteCost`) are recorded as `0` for now; `totalCost` is real. Wiring the
  per-component breakdown to model rates is deferred to the calibration PRD.
- The config-TUI budget editor and budget bars in the launch/runs TUIs are
  deferred.
