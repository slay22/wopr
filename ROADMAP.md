# ROADMAP

> Living document for ideas, follow-ups, and parked work. Three sections: **In flight** (currently being worked on), **Parked** (idea discussed, not yet scoped — pick up when the time comes), **Done** (shipped).
>
> **How to add an item:** drop a bullet under "Parked" with a short title, 1-2 sentence description, why it matters, and an effort estimate (small / medium / large). When you start scoping it as a real PRD, move it to "In flight" and link to the spec file.

## In flight

_(none — v0.2.0 release prep is the next step)_

## Next: v0.2.0 release prep

In the order below, all small follow-ups:

1. **History rewrite** — find the pivot commit (`8418739` is the first WOPR commit, where archer → WOPR happened) and graft it as the new root. Use `git replace --graft`, then `git filter-branch` to materialize. Force-push. Keep a `legacy-archer` branch for the old history.
2. **CI/CD** — `.github/workflows/ci.yml` (PR: typecheck + tests), `.github/workflows/release.yml` (tag push `v*`: build 4 binaries, attach to release). Plus `install.sh` for `curl | bash` install.
3. **Cut `v0.2.0`** — first release from the rewritten history. Stable now: core API, MCP, notifications, dynamic pipelines, pi extension, remote permissions, ROADMAP, report command next.

## Parked

### Core engine

- **Pipeline composition across built-ins** — "do the first 3 phases of `implement`, then 2 of `review`, then 1 of `refine`." The dynamic-pipelines PRD allows arbitrary steps but not "this step from this pipeline + that step from that one." Small follow-up, may not be worth it.
- **Conditional steps** — "run `security` only if `tests` finds issues." Powerful but adds significant complexity. Defer until a real use case appears.
- **Dynamic agent definition at runtime** — currently you compose from registered agents; you can't define a new agent in the spec. Would require a new agent spec format in the MCP/pi tools. Medium effort.
- **Streaming events from wopr to MCP/pi** — currently request/response; the orchestrator polls `get_run_status` every N seconds. Streaming would be nicer (SSE for HTTP, or server-sent events over the pi tool). Small-medium effort, defer until a UX reason.

### Cost & budget

- **Calibration PRD** — `CostTracker.estimateNext` uses a constant `defaultTokenEstimate`. After ~20-30 real runs, we'd have data to learn per-agent averages via EMA. The notifications ADR noted this as the closest "MVP caveats" gap. Closes the post-hoc enforcement gap (currently up to 1 phase of overshoot). Medium effort.
- **Free-tier rate-limit retry strategy** — when an opencode free-tier model returns `FreeUsageLimitError` (the user's `deepseek-v4-flash-free` or `hy3-free`), the runner should: (a) log the failure, (b) wait + retry with exponential backoff, (c) after N attempts, fall back to a paid model if `budget` allows, (d) after M total attempts, fail the phase with a clear error. Currently the error is propagated up and the run dies. Small-medium effort. The dogfooding today hit this — two parallel runs on free-tier pushed past the daily cap.
- **`wopr report` command + `--tag` flag** — a small but useful aggregation layer over the existing `metadata.json` data. `wopr report` aggregates cost/tokens/wall-time across runs, groups by project (`targetDir`), pipeline, or `--tag`, outputs a markdown table (universal format, copy-paste anywhere) + JSON (for tooling). Adds `tag?: string` to `RunOptions` (CLI flag `--tag feature-name`) so a run can be labeled with a feature/PRD name. Small effort, ~200-400 lines + tests. **Intentionally NOT a separate "Report Module" with HTML/PDF/charts** — that's a different product (Notion/Obsidian/custom dashboards do it better, let them consume the JSON/MD). MVP is the command + the tag; HTML/PDF/real-time is out of scope for wopr.
- **LLM-driven cost prediction** — same direction, but the heuristic is replaced with a small model call. The keyword-based `recommendPipeline` could go the same way. Small effort, but requires picking the model.
- **Per-phase budgets** (`Budget.perPhase`) — the type is already in the codebase; the enforcer ignores it. Add per-phase enforcement. Small effort.

### Pipelines & selection

- **LLM-driven pipeline recommendation** — replace the keyword table in `recommendPipeline` with a small model call. Same shape, better accuracy. Small effort.
- **"8 → 3" pipeline collapse** — once `recommendPipeline` + Budgets + dynamic steps all exist, the 8 fixed built-ins (`implement`, `refine`, `converge`, `*-lite`, `ultra-*`, `review`, `review-lite`) collapse to ~3 (`implement`, `refine`, `converge`). The rest are dynamic compositions. The `*-lite` deprecation is already noted in `src/pipeline.ts`. The collapse itself is mostly doc work + a CHANGELOG note.
- **Pipeline templates / starter pack** — `wopr init --template security-audit` scaffolds a `.wopr/config.yaml` + agent prompts for common patterns (security audit, refactor, greenfield, etc.). Small-medium effort. Would make wopr friendlier for new users.

### Transports

- **HTTP/SSE for MCP** — the MCP spec shipped stdio only. HTTP+SSE is needed for remote agents, web UIs, etc. The MCP SDK supports it. Defer until a concrete remote use case.
- **HTTP/SSE for the pi extension** — not needed (pi loads the extension in-process). Listed for completeness.
- **ntfy actions (buttons) for notifications and approvals** — currently users type `allow` / `always` / `reject` in the ntfy app. Buttons would be nicer. Requires an HTTP callback (deferred ntfy action feature) or a small web server. Small effort, defer.
- **Streaming events from wopr to pi** — same as "streaming events" above, surfaced here because the pi extension would benefit most from real-time updates (the LLM can react to phase completions without polling).

### MCP & pi extensions

- **Run replay** — given a `run_id`, can the user "re-run with the same input, see what changes"? Useful for debugging or iterating. Would need to capture the full input (prompt, models, budget) in the run metadata. Small effort.
- **Audit trail / provenance** — when wopr makes a change (commit, file edit, config write), who/what/when/why is captured somewhere queryable. WOPR already records this in the per-phase report + commit message, but a queryable index (`wopr runs --audit-trail`) would be nicer. Medium effort.
- **More tools** — `wopr_get_run_logs`, `wopr_dry_run_validation` (preview without running), `wopr_compare_runs` (diff two runs' outputs). Small effort, add when there's a use case.

### UI

- **`tui.ts` split** (from the architecture review) — 2,819 lines, one class. Split into `tui/format.ts` (~500), `tui/panels.ts` (~700), `tui/input.ts` (~350), `tui/layout.ts` (~250), `tui.ts` shell (~600). Improves maintainability, no behavior change. Medium effort.
- **TUI followups** — budget meter in launcher + runs browser + config editor (currently only in `tui.ts` per the notifications adversarial report). Small effort.
- **Run progress overlay in the runs browser** — when a run is in flight, show live progress (current phase, percent, ETA) instead of just the metadata snapshot. Would require a polling mechanism. Small-medium effort.
- **Animated splash screen** — on `wopr` startup (interactive launch, no subcommand), show a short NORAD-phosphor-style animation before the launcher takes over. A "WOPR ONLINE" or "GREETINGS PROFESSOR FALKEN" reveal, the existing radar spinner, ASCII art fading in. Pure polish, no functional change. Small effort, ~200-300 lines. Plays well with the existing WarGames easter eggs and NORAD phosphor identity (see commits `aed1700 feat(tui): NORAD phosphor identity` and `e30d00e feat(runner): WarGames easter eggs on existing quit + stall paths`). Skip-flag for users who don't want it (`--no-splash` or `WOPR_NO_SPLASH=1`).

### Notifications (gaps noted in the notifications adversarial report)

- **`verdict_received` event not wired** — the dispatcher's `formatEvent` has the case and it's unit-tested, but `runner.ts` never fires it (no validator-report parsing). Was deferred by the implementer. Small fix.
- **`getRunDiff`/`getRunCommits` always returning 0** — only `filesChanged` names are parsed; real hunk-stat parsing is a v1 follow-up. Small effort.
- **`run_failed.failedPhase` hardcoded `"unknown"`** — needs error-type discrimination for precise phase attribution. Small effort.

### Permissions

- **Multi-user auth on the wopr tools** — currently the user has whatever file-system permissions they have. For remote/multi-user deployments, auth is needed. Defer until the user base grows.
- **Permanent `always-allow` rules** (across runs) — currently `always` is scoped to the current run, cleared on completion. For permanent, users use `--yolo` or `permissions.allow` in config. The MVP is fine; revisit if there's demand.

## Done

- **Core API** (`src/core/`, 22 functions: discovery, config, planning, runs, errors) — landed in 0256660. 447 tests pass.
- **MCP server** (`wopr mcp`, 22 tools over stdio JSON-RPC) — landed in 24a1069. 493 tests pass, live-verified with a real `wopr mcp` subprocess.
- **Notifications** (`--notify` flag, ntfy client + dispatcher, off by default) — landed in 24a1069. 500 tests pass.
- **AGENTS.md** — operational manual for coding agents, 14 sections. Landed in main.
- **README updates** — 3 new sections ("Three surfaces", "The MCP server", "Notifications", "Budgets", "For coding agents"). Landed in 24a1069.
- **Bash policy + safety judge hardening** (pipe-split deny pass, first-balanced-object parser, per-phase timeout) — landed in 0993388. The dogfooding catalyst for the platform.
- **Budgets MVP** (`Budget` type, `CostTracker`, naive `estimateCost`, `suggestConfigForBudget`, `--budget` flag, `BudgetExceededError`, TUI meter) — landed in 5f01d0d. The dogfooding target for wopr-on-wopr.
- **`.gitignore` cleanup** — build artifacts (`.bun-build`, `wopr` binary) no longer tracked. Landed in 253cfe9.
- **"Use --yolo for unattended runs"** in AGENTS.md §5 — landed in cd25bb0.
- **Dynamic pipelines** (custom `steps` in `startRun` / `previewRun` / `estimateCost`, `recommendPipeline` core + MCP tool, `--steps` CLI flag, `*-lite` deprecation) — landed in e07262a. 588 tests pass.
- **ROADMAP.md** — living document for parked ideas. 20+ items across 8 categories. Landed in f33c263.
- **Pi extension** (`extensions/wopr-for-pi/`, 22 tools wrapping the core API, hand-written JSON Schemas, SKILL.md, shared `src/core/tools/` refactor) — landed in f0c3b80. 86 new tests in the extension. **8 non-blocking follow-ups:** live `pi` E2E not verified here (the human should run `pi extensions install ./extensions/wopr-for-pi` and smoke-test), plain JSON-Schema cast `as any` (TypeBox `parameters`), extension not a workspace member, diff over PRD's 800-line budget by tests, `bun.lockb` re-serialization, misnamed test, etc.
- **Remote permission approvals via ntfy** (config block, `askRemote` resolver, `readInbox` helper, `always-allow` per-run rule, `--no-tui` integration) — landed in 9217678. 654 tests pass. **6 non-blocking follow-ups:** `parseReply` substring-match is fragile to negation (security MEDIUM, deferred — recommendation: require explicit keywords), `always-allow` is exact-command match (narrower than PRD "rest of run"), `agent`/`phase` shown as "unknown" in phone notifications (architectural — needs threading through tool_call handler), TUI config editor for approvals is read-only viewer only (PRD coverage partial), plaintext ntfy auth in config (pre-existing), no live ntfy E2E test (manual `--no-tui` is the only check).
