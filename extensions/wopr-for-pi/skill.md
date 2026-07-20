# wopr — multi-agent orchestrator

You have access to 23 `wopr_*` tools for orchestrating multi-agent work.
Each tool is a thin wrapper over the wopr engine: same code path as the
`wopr` CLI, but callable from inside a pi session.

## When to use wopr

DO use wopr when the user asks for work that is:

- **Multi-step** (multiple files, multiple phases) — wopr runs each step
  as a fresh agent session, with a per-phase commit and report
- **Quality-sensitive** — wopr ships audits (security, patterns, design)
  and an adversarial review by default
- **Multi-model** — different phases can use different models; the user
  picks via config or runtime suggestions

DO NOT use wopr when:

- The work is a 1-line fix or a question
- The user is just exploring (no commit)
- The user wants to read/explain code (use Read/Grep/Glob instead)

## The natural sequence

For a non-trivial implementation request, the standard pattern is:

1. `wopr_list_pipelines` — see what's available
2. `wopr_describe_pipeline <name>` — full step-by-step detail
3. `wopr_suggest_config_for_budget { budget, pipeline, targetDir }` —
   if the user mentioned a budget, get a config that fits
4. `wopr_preview_run { prompt, pipeline, targetDir, ... }` — see what
   would happen (worktree path, base, estimated cost)
5. **Narrate the plan to the user** — this is the moment for human
   approval. Don't start a run without the user seeing the plan.
6. On user approval: `wopr_start_run { ... }` — returns a `runId`
7. Poll `wopr_get_run_status { runId }` every 30s. The state field
   is "running" / "completed" / "failed" / "aborted" / "budget_exceeded"
8. On completion: `wopr_get_run_report { runId, phase: "adversarial" }`
   for the verdict, plus `wopr_get_run_cost` and `wopr_get_run_diff` for
   the summary
9. Narrate the result to the user — verdict, cost, time, files changed

## The 23 tools at a glance

| Category | Tools |
|---|---|
| Discovery | list_pipelines, describe_pipeline, list_agents, describe_agent, list_models, describe_model |
| Config | get_config, validate_config, diff_config, set_config |
| Planning | preview_run, estimate_cost, suggest_config_for_budget, recommend_pipeline |
| Runs | start_run, get_run_status, list_runs, get_run_report, get_run_cost, get_run_diff, get_run_commits, cancel_run, resume_run |

## Don't shell out to the `wopr` CLI

The wopr tools go through the same engine as the `wopr` CLI. If a
user asks "run wopr", use the tools — don't recommend `wopr
--prompt-file ...` shell commands. The tools give you structured
results, async polling, and the same permission/notification/budget
features the CLI has.

## Cost and time

- Free tier: deepseek-flash-free for code work, hy3-free for
  security-critical phases. Total per run: typically $0
- A 6-phase `implement` run on free tier: 1-3 hours wall clock
- The TUI dashboard shows live cost; `wopr_get_run_cost` reads it
  back after the fact

## Permission prompts

If a phase hits the `ask` tier of the permission gate, the run blocks
on a TUI prompt. The user must answer (allow once / always / reject)
in the terminal. For unattended runs, they can:
- Pre-configure `--yolo` (auto-allow, denylist still applies)
- Use the TUI's `shift+tab` to cycle to yolo-mode live
- Configure `approvals:` in `~/.wopr/config.yaml` for remote approval
  via ntfy (see the "Remote permissions" feature in the wopr docs)
