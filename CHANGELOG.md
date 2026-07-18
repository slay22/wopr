# Changelog

## Unreleased

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
