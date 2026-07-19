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

### Next up (separate PRDs)

- **MCP server** — JSON-RPC transport over the core API
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
