# AGENTS.md — How to use WOPR

> A guide for **coding agents** (LLM-driven) that need to invoke WOPR to do work on a codebase. WOPR is a multi-agent pipeline runner: you hand it a PRD and a pipeline choice, it drives a sequence of specialized agents in a git worktree, commits per phase, and gives you back a reviewable branch.
>
> Read this end-to-end on first use. After that, jump to the section you need.

---

## 0. Mental model (10 seconds)

```
PRD ──► pipeline ──► phases ──► commits ──► worktree branch ──► review ──► merge
```

- **PRD** is a markdown file you write. WOPR's `implementer` reads it.
- **Pipeline** is a named sequence of steps (implementer, patterns, security, design, tests, adversarial…). You pick one with `-p <name>`.
- **Phases** run sequentially. Each one is a fresh agent session on a model you choose. Each phase commits once at the end (read-only phases don't commit).
- **Worktree** is `~/.wopr/worktrees/<slug>` on a branch named from the prompt. Main checkout is never touched.
- **Reports** drop into `~/.wopr/runs/<run-id>/reports/<phase>.md` as phases finish.
- **Validator** (the last `adversarial` phase) reads the diff and emits PASS / PARTIAL / REJECT.

WOPR is not a chatbot. WOPR doesn't ask clarifying questions. The PRD has to be concrete enough that the implementer can act without checking back. If your PRD is vague, the output will be vague.

---

## 1. Quickstart (30 seconds)

```bash
# Write a PRD
cat > /tmp/prd.md << 'EOF'
# Add a dark mode toggle

## Why
Users have asked for dark mode. The app is a Flutter project at /Users/me/myapp.

## In scope
- Add a `ThemeMode` setting persisted in shared_preferences
- Add a toggle in the settings screen
- Use the existing color tokens, do not introduce new ones

## Out of scope
- System-follow mode (later PRD)
- Per-screen dark mode overrides (later PRD)

## Success criteria
- `flutter analyze` clean
- `flutter test` passes
- Toggle persists across restarts
EOF

# Pick a pipeline and run it
wopr --worktree -p implement --prompt-file /tmp/prd.md --keep-run-dir

# Wait. When it's done, inspect the worktree:
cd ~/.wopr/worktrees/dark-mode-toggle
git log --oneline
git diff main..HEAD
```

That's the basic flow. Everything below is the operational detail that makes it actually work.

---

## 2. Choosing a pipeline

Pick the smallest pipeline that does the job. More phases = more time, more cost, more places for things to go wrong.

| If you want to… | Pipeline | Notes |
|---|---|---|
| Add a feature or implement a spec | `implement` | 6 phases: implementer, patterns, security, design, tests, adversarial |
| Same as above, but cost-sensitive | `implement-lite` _(deprecated)_ | Swaps to cheaper models. Prefer `implement` + `suggestConfigForBudget({ tier: "free-only" })`. |
| Audit a branch without changing code | `review` | Read-only. Output: `reports/report.md` |
| Same, but cost-sensitive | `review-lite` _(deprecated)_ | Prefer `review` + `suggestConfigForBudget({ tier: "free-only" })`. |
| Audit **and apply accepted fixes** | `refine` | 7 phases: scope, bugs, clean-code, security, triage, fixes, validator |
| Same, but every audit runs on two models in parallel | `ultra-refine` | |
| Implement + multi-model review of initial diff + final audit | `ultra-implement` | Heaviest; for risky changes |
| Self-correcting: re-plan from validator findings until PASS or cap | `converge` | The headline "closes the loop" mode. Most expensive. |
| Pick your own steps | **dynamic custom pipeline** | Pass a `steps` array or use `--steps` CLI flag. See §17. |

**Decision rules:**

- **"Add a feature"** → `implement` (default)
- **"Improve the current branch"** (without a spec) → `refine`
- **"Tell me what's wrong with this branch, no fixes"** → `review`
- **"Hard change that needs to converge"** (e.g. swap a database layer, big refactor) → `converge`
- **"Quick sanity check, low cost"** → `implement-lite` or `review-lite`

Custom pipelines live in `.wopr/config.yaml` under `pipelines.<name>` or globally at `~/.wopr/config.yaml`. See §5 for model selection.

---

## 3. Writing a PRD

The implementer agent reads your PRD and acts on it **without asking questions**. Vague PRDs produce vague results. Here's the structure that works:

```markdown
# <Short, verb-led title>

## Why
1-2 paragraphs. What's the problem, who benefits, why now.

## In scope
Numbered items. Each one has:
- **File:line** (if you know it)
- **Current** behavior
- **Desired** behavior
- **Tests to add** (specific cases)

### 1. `src/foo.ts:42` — fix X
**Current:** does Y
**Desired:** does Z
**Tests:** add a test that asserts Z

### 2. `src/bar.ts:100` — refactor W
...

## Out of scope (intentionally)
- X (land separately, different shape of change)
- Y (deferred, needs more design)

## Success criteria
- `bun run typecheck` clean (or `flutter analyze`, etc.)
- `bun test` passes
- Specific behavior assertions (the user can now do X)
- Public API change: none / list the changes

## Assumptions
- Stack: X
- Tooling: Y
- Anything you decided without checking

## Report
- What the report at the orchestrator-provided path should contain
```

**Two real examples in this repo:**
- `prompts/implementer.md` — the implementer agent's system prompt (it tells the agent what shape to expect)
- The PRD the project dogfooded on is at `reports/` of past runs in `~/.wopr/runs/<id>/prd.md` — read one for tone

**Common PRD mistakes:**

| Mistake | Fix |
|---|---|
| "Make the code better" | Be specific: which files, what kinds of improvements, what tests pin the new behavior |
| "Refactor the auth system" | Pick the seam: which module, which dependency to break, what success looks like |
| Lists of features without priorities | Number the in-scope items, and tell the agent which is the headline vs nice-to-have |
| No out-of-scope section | The agent will scope-creep. The out-of-scope list is the most useful section for keeping the agent honest |
| "Should I use library X or Y?" | Don't ask. Pick one, document the choice under "Assumptions", let the agent run with it |

---

## 4. Choosing models

WOPR's model catalog is whatever the user has authenticated in [`pi`](https://github.com/earendil-works/pi). The model name is `<provider>/<model>` (e.g. `opencode/deepseek-v4-flash-free`).

**Three tiers (rough):**

| Tier | Example | Cost | Use when |
|---|---|---|---|
| **Free** | `opencode/deepseek-v4-flash-free`, `opencode/hy3-free` | $0 | Default. Most runs should be on free tier. |
| **Cheap** | `opencode/deepseek-v4-flash` (1M ctx), `opencode/claude-haiku-4-5` | <$1/run | When free-tier quality isn't enough and a single paid run is fine |
| **Frontier** | `opencode/claude-opus-4-8`, `opencode/gpt-5.6-pro` | $5-30/run | Risky changes, security-critical work, when quality matters and budget allows |

**Per-agent guidance (when in doubt):**

- `implementer`, `pattern-auditor`, `test-engineer`, `review-fixer`, `review-scope` → free tier is fine
- `security-auditor`, `security-reviewer`, `review-adversary`, `review-validator`, `adversarial-reviewer` → **strongest free** (`hy3-free`) or **frontier** if you can afford it
- `design-polisher` → free or cheap (only matters for UI work)
- `planner`, `loop-validator` (converge only) → strong model. These plan and gate; they're worth the cost

**How to set the models:**

- Per-run via `--model <provider/model[#variant]>` (overrides everything)
- Per-step via the project config (`.wopr/config.yaml` under `pipelines.<name>.steps[].model`)
- Per-agent via `agents.<name>.model` in config (less specific than per-step)

Precedence: **CLI flag > step-level model > agent-level model > `defaults.model` > built-in agent default**.

---

## 5. Running wopr

### The basic command

```bash
wopr --worktree -p <pipeline> --prompt-file <prd.md> --keep-run-dir
```

| Flag | What it does |
|---|---|
| `--worktree` | Run in `~/.wopr/worktrees/<slug>` on a new branch. **Always use this** for runs that produce code — keeps your main checkout clean. |
| `-p, --pipeline` | Pipeline name (default: `implement`) |
| `--prompt-file <path>` | Path to the PRD markdown |
| `--file, -f <path>` | Attach a file or directory to every step (repeatable) |
| `--model <provider/model[#variant]>` | Force a model for all steps |
| `--keep-run-dir` | Keep `~/.wopr/runs/<id>` after success (default) |
| `--yolo` | Auto-allow ask-level permissions (hard denylist still applies) |
| `--smart` | Use an AI judge to auto-allow safe asks, escalate risky ones |
| `--max-attempts <n>` | Attempts per phase before failing (default: 2) |
| `--base <ref>` | Branch/base for diff calculation (default: auto-detected) |
| `--dir <path>` | Target repo (default: cwd) |
| `--no-tui` | Plain logs, no TUI dashboard (for CI) |
| `--no-human-step` | Drop all human gates from the pipeline (for non-interactive) |

### Run in the background

WOPR is a long-running process. If you're using a TUI multiplexed terminal (Herdr, tmux, etc.):

```bash
# 1. start a monitor that ntfy-pings your phone (optional, see §8)
nohup /tmp/wopr-monitor.sh > /tmp/wopr-monitor.log 2>&1 &

# 2. start wopr in a dedicated pane/screen
wopr --worktree -p <pipeline> --prompt-file <prd.md> --keep-run-dir
```

### Permissions during the run

WOPR has a permission gate that intercepts bash commands. The default policy:
- `allow` for: test runners, linters, formatters, `git status/diff/log`, `ls/cat/grep/...`
- `deny` for: `git push`, `git reset --hard`, `rm -rf /`, `curl|sh`, `sudo`, `npm publish`, etc.
- `ask` for: anything else

`--yolo` short-circuits `ask → allow` (deny still wins). `shift+tab` cycles this live in the TUI.

For an agent (you), the practical guidance: **don't pass `--yolo` for security-relevant runs**. The permission gate is the safety rail; the agent is the one whose judgment is in question.

### Use `--yolo` for unattended runs

If you're walking away from the computer (long run, dogfooding, lunch break), **always pass `--yolo`**. The denylist (`git push`, `rm -rf /`, `sudo`, `curl|sh`, etc.) still applies — `--yolo` only auto-allows the `ask` tier. Without it, the run blocks at the first `ask` prompt and you have to be at the keyboard to answer. The cost of `--yolo` is zero in practice: every "ask" command in a typical wopr run is something like `cd <worktree>` or `ls <file>` — the kind of thing a human would approve without thinking.

**Pattern for any wopr run that you won't watch live:**

```bash
wopr --worktree --yolo --prompt-file prd.md --keep-run-dir
# walk away. get a phone ping on every phase + verdict + finish.
```

For live progress pings on a run you're not watching, see §14 (Notifications). `--yolo` is the simple "I trust the agent, denylist is enough" path.

> The remote-permissions feature (ntfy approval from your phone) is on the [ROADMAP](ROADMAP.md) — when it lands, the workflow above changes from "auto-allow all" to "phone-prompted decisions."

---

## 6. Reading results

WOPR writes a run directory at `~/.wopr/runs/<run-id>/`:

```
~/.wopr/runs/20260718-220419-b5lc/
├── prd.md                    # the PRD as WOPR saw it
├── metadata.json             # pipeline, phases, cost, worktree path
├── reports/
│   ├── implementer.md        # per-phase report
│   ├── patterns.md
│   ├── security.md
│   ├── design.md
│   ├── tests.md
│   └── adversarial.md        # validator verdict
├── logs/
│   └── <phase>.<attempt>.json   # raw agent output per attempt
├── diffs/                    # cumulative diffs against base
└── SUMMARY.md                # human-readable run summary
```

The **worktree** is at `~/.wopr/worktrees/<slug>`, branch `<slug>`. Inspect with:

```bash
cd ~/.wopr/worktrees/<slug>
git log --oneline main..HEAD         # commits WOPR made
git diff main..HEAD --stat            # the diff at a glance
git show <sha>                        # a specific phase's commit
```

The **validator report** (`adversarial.md`) is the most important output. It says:
- `Validation result:` `pass` / `partial` / `reject`
- `PR readiness:` `ready` / `not ready`
- Specific findings (if any) — and crucially, the adversarial phase **may have applied fixes** for blocking findings

**Trust but verify.** WOPR's validator can be wrong. Read the diff yourself before merging.

---

## 7. Iterating

WOPR's output is a **draft**. The pattern is:

1. **Run** with `refine` or `implement`
2. **Read** the per-phase reports + the diff
3. **Decide** what to keep, what to revert, what to fix by hand
4. **Either** merge, or write a follow-up PRD and run again

**When to use `refine` for the follow-up:**
- The current branch has changes you want to audit (e.g. a hand-written fix or another agent's output)
- `refine` does scope → bugs → clean-code → security → **adversary triages findings** → fixer applies accepted ones → validator confirms

**When to re-run with a new PRD:**
- The original PRD was too vague and the output is off-target
- You want a new feature added on top of the existing work
- The previous run timed out or hit an error

**When to abort:**
- The run is going in a wrong direction (per-phase reports show a misunderstanding)
- Cost is climbing beyond the budget (use `--budget <usd>` to cap this — see §9)

`Ctrl+C` in the TUI sends SIGINT, which gracefully aborts the current phase and tears down. SIGKILL skips the teardown and orphans the worktree (use `wopr worktrees prune` to clean up).

---

## 8. Monitoring and notifications

For long runs (1-3 hours typical), monitoring helps. A minimal setup with `ntfy.sh`:

```bash
# On the Mac, set up the topics
TOPIC="wopr-$(whoami)-$(date +%s | tail -c 5)"
echo "$TOPIC" > /tmp/ntfy-topic
curl -d "🔭 wopr monitor live" https://ntfy.sh/$TOPIC

# On your phone, install "ntfy" (Play Store / App Store, by Philipp C. Heckel)
# Subscribe to the topic. Notifications appear in real time.

# Helper to send
cat > /tmp/notify.sh << 'EOF'
#!/bin/bash
TOPIC=$(cat /tmp/ntfy-topic)
curl -s -d "$2" -H "Title: $1" -H "Priority: $3" https://ntfy.sh/$TOPIC
EOF
chmod +x /tmp/notify.sh
```

Then a background monitor that polls the run dir and sends notifications on phase transitions:

```bash
# /tmp/wopr-monitor.sh
while true; do
  pid=$(pgrep -f "wopr --worktree" | head -1)
  [ -z "$pid" ] && break
  reports=$(ls ~/.wopr/runs/$(ls -t ~/.wopr/runs/ | head -1)/reports/ 2>/dev/null)
  # ... diff against last seen, send on change ...
  sleep 30
done
```

The repo ships a full version of this at `wopr-monitor.sh` in past run reports (search this repo's history for `wopr-monitor`). Use it as a starting point.

---

## 9. Budgets (cost cap)

WOPR supports per-run cost caps. The feature is opt-in — runs without a budget behave exactly as before, except that `metadata.json` now includes a `cost` field recording what was actually spent (free telemetry for everyone).

**Set a budget on a run:**

```bash
wopr --budget 5.00 -p implement --prompt-file prd.md
# Cap at $5 USD. The run aborts cleanly with BudgetExceededError
# if a phase would push spent + next_estimate above the cap.
```

**Set a project-wide default** in `.wopr/config.yaml`:

```yaml
defaults:
  budget:
    perRun: 5.00
    onExceed: abort  # or "warn-and-continue" for soft cap
```

**Set a per-pipeline override** (e.g. `converge` is allowed to spend more):

```yaml
pipelines:
  converge:
    budget:
      perRun: 15.00
```

**Precedence:** `wopr --budget` CLI flag > `pipelines.<name>.budget` > `defaults.budget` > none.

**Important caveat (MVP):** cost estimation is naive (constant token assumption per phase). Enforcement is **post-hoc**: the cap fires *after* `spent` already exceeds `perRun`, allowing up to one phase of overshoot. For multi-phase pipelines this is fine; for a single-phase pipeline the cap is essentially a no-op. A future "calibration" PRD closes this gap with per-agent historical token averages.

**For the agent picking the config** (when WOPR has an MCP server wired): `suggestConfigForBudget({ budget, pipeline, targetDir, preferences? })` returns a proposed config + cost estimate that fits the budget. See `src/suggest.ts` for the pure function and the README for the MCP server status.

### Remote approvals

If you're not at the keyboard but still want to review each permission prompt, configure `approvals:` in your config. The permission gate sends a high-priority ntfy notification for every `ask`-tier command; you reply from the ntfy app on the same topic.

```yaml
# ~/.wopr/config.yaml
notifications:
  - ntfy://wopr-leo-1234
approvals:
  topic: ntfy://wopr-approvals-leo-1234   # same topic, two-way
  timeoutSeconds: 300                       # default: 5 min
  onTimeout: reject                         # or allow-once
```

The approval flow:
1. A command hits the `ask` tier (no TTY, or `--no-tui` was passed)
2. The gate sends a high-priority ntfy notification with the command, agent, phase, and a prompt ID
3. Your phone buzzes. Open the ntfy app and reply with `allow <id>` or `reject <id>` or `always <id>`
4. The gate receives the reply within seconds and the run continues
5. If you don't reply within `timeoutSeconds`, the config's `onTimeout` decision is applied (default: reject)

The `always` reply persists for the remainder of the current run, so you don't see the same prompt twice. The state is cleaned up when the run completes.

**Security boundary:** the ntfy topic name is the only access control. Anyone with the topic name can approve commands. This is acceptable for a local CLI tool; for multi-user or remote deployments, a follow-up will add authentication.

**Off by default:** without `approvals:` in your config, no ntfy traffic happens for permissions and the run blocks on a TTY prompt (or fails if there's no TTY).

---

## 10. Common pitfalls

| Pitfall | What goes wrong | Fix |
|---|---|---|
| Vague PRD | Agent guesses, output is off-target, you re-run anyway | Spend 10 min on a specific PRD; it's cheaper than the re-run |
| No out-of-scope section | Agent scope-creeps into adjacent code | Always include a short out-of-scope list, even for "obvious" work |
| `--worktree` not used on a dirty tree | WOPR commits your uncommitted changes to the worktree branch | Always use `--worktree`. If you forgot, `git restore` the worktree before merging. |
| Paid models by default | Surprise $5-30 bill | Configure `defaults.model` in `.wopr/config.yaml` to a free model |
| Hitting `401 Missing Authentication header` | Built-in pipeline used a paid model the user hasn't authed for | Add a `pipelines.<name>` override in `.wopr/config.yaml` with free-tier models |
| Run takes 3 hours and you were expecting 30 min | Code-writing on free-tier is slow; security/review are faster | Set expectations; use `--smart` or `--yolo` if you need to skip permission prompts |
| Run blocked on permission prompt while you're away | The TUI prompt waited for keyboard input; the run stalled | Pass `--yolo` for unattended runs, or configure `approvals:` in your config for remote approval from your phone |
| Validator says PASS but the diff is bad | Validator can miss things (it's an LLM too) | Always read the diff yourself before merging |
| Run produced 12 failing tests | Agent shipped tests with wrong assertions (e.g. expected `ask`, got `allow`) | Read the test file, fix by hand, re-run `bun test` |
| `--yolo` on a security run | Permission gate becomes a rubber stamp | Don't. Use `--yolo` only for trusted, low-risk iterations |
| The wopr binary is stale | New features don't take effect at runtime | `cd <repo> && make build && make install` before re-running |

---

## 11. The dogfood loop

WOPR is good at running on **its own codebase** because the codebase is well-structured, the tests are comprehensive, and the patterns are clear. The pattern:

1. Run a deep review (manual or via sub-agents)
2. Distill the findings into a PRD with file:line refs and tests
3. Run WOPR on the PRD with `--worktree`
4. Read the diff; the agent's `adversarial` phase is usually right but not always
5. Manually fix any test-assertion bugs the agent introduced (this is a known weakness)
6. Land via fast-forward or PR
7. **Repeat** — each cycle of dogfooding surfaces the next layer of issues

The two real PRDs the project has dogfooded on (both kept in run history, both resulted in shippable branches):

- **harden-permissions** — security fixes for the bash policy, safety judge, and per-phase timeout (4 fixes, 1 manual test-assertion cleanup)
- **budgets-mvp** — the budgets feature, including the headline `suggestConfigForBudget` function

The pattern that emerged: a wopr `refine` run catches 80% of issues; the other 20% (test-assertion drift, post-hoc enforcement gaps) is the human's job.

---

## 12. Reference: full CLI

```
wopr [prompt]

Commands:
  wopr                       Open interactive TUI launcher
  init                       Create .wopr/config.yaml and .wopr/agents/*.md
  init --global              Create ~/.wopr/config.yaml and ~/.wopr/agents/*.md
  runs [run-id]              Browse run history
  config                     Edit global + project config in TUI
  worktrees [list|prune]     Manage worktrees created by --worktree

Flags:
  --prompt-file <path>       PRD markdown
  --file, -f <path>          Attach file/dir to every step (repeatable)
  --pipeline, -p <name>      Pipeline to run (default: "implement")
  --only <steps>             Run only these steps
  --skip <steps>             Skip these steps
  --resume <id>              Resume a previous run
  --keep-run-dir             Keep run dir (default)
  --no-keep-run-dir          Delete run dir on success
  --yolo                     Auto-allow ask-level permissions
  --smart                    Smart auto-accept via AI judge
  --smart-model <model>      Model for the safety judge
  --include-dirty            Include existing changes in first commit
  --model <provider/model[#variant]>
  --tui                      TUI dashboard (default in interactive terminals)
  --no-tui                   Plain logs (for CI)
  --human-step               Enable human steps (default in interactive)
  --no-human-step            Drop all human steps
  --max-attempts <n>         Attempts per step (default: 2)
  --base <ref>               Branch/base for diff (default: auto-detected)
  --dir <path>               Target repo (default: cwd)
  --worktree                 Run in a new worktree on a new branch
  --keep-worktree            Keep the worktree checkout (default)
  --no-keep-worktree         Remove the worktree on success
  --budget <usd>             Hard cost cap; run aborts if exceeded
  --budget-mode abort|warn   Override budget's onExceed mode
```

---

## 13. Reference: built-in pipelines at a glance

| Pipeline | Changes code? | Phases |
|---|---|---|
| `implement` | yes | implementer, patterns, security, design, tests, adversarial |
| `implement-lite` | yes | same, with cheap models on heavy phases |
| `ultra-implement` | yes | initial + parallel multi-model reviews + final audit + fixer + validator |
| `refine` | yes | scope, bugs, clean-code, security, triage, fixes, validator |
| `ultra-refine` | yes | like `refine`, but every audit runs on two models in parallel |
| `converge` | yes | parallel panel review + plan→implement→validate loop, re-plans from validator findings |
| `review` | no | scope + parallel multi-model audits + report (read-only) |
| `review-lite` | no | same, cost-sensitive |

Default models per phase (override in `.wopr/config.yaml` if needed):

| Agent | Default model | Override for |
|---|---|---|
| `implementer` | strong reasoning (e.g. `gpt-5.6-terra#xhigh`) | code generation |
| `pattern-auditor` | strong reasoning | pattern alignment |
| `security-auditor` | strong reasoning | security |
| `design-polisher` | mid-tier (e.g. `opus`, `glm-5.2`) | UI work, lower stakes |
| `test-engineer` | strong reasoning | test generation |
| `adversarial-reviewer` | mid-tier | final review, lower stakes |

In the project's own `.wopr/config.yaml` (dogfooding setup), the defaults are flipped: free-tier models everywhere, with `hy3-free` reserved for the three security-critical agents (security, adversary, validator).

---

## 14. Notifications (built-in ntfy)

WOPR ships with built-in ntfy notification support. Off by default — no config, no network I/O.

### Quickstart

```bash
# Send a test notification (verify connectivity)
wopr notify test ntfy://my-phone-topic

# Run with notifications
wopr --notify ntfy://my-phone-topic --prompt-file prd.md
```

### URL format

```
ntfy://<topic>                              # ntfy.sh (default server)
ntfy://<server>/<topic>                    # self-hosted, no auth
ntfy://<user>:<pass>@<server>/<topic>      # self-hosted with auth
```

### Events and priorities

| Event | When | Priority |
|---|---|---|
| `run_started` | Run starts | default |
| `phase_done` | Phase completes successfully | default |
| `phase_failed` | Phase fails after all attempts | high |
| `verdict_received` | *(not yet wired — see Limitations)* Adversarial validator renders a verdict | pass=default, fail=high |
| `budget_warning` | Run exceeds budget cap (warn mode) | high |
| `budget_exceeded` | Budget cap hit (abort mode) | urgent |
| `run_completed` | Pipeline completes successfully | high |
| `run_failed` | Pipeline fails | urgent |

### Config

```yaml
# ~/.wopr/config.yaml or .wopr/config.yaml
notifications:
  - ntfy://wopr-leo-1234
  - ntfy://ntfy.example.com/wopr-team
```

Project config overrides global config (they don't merge). Use `--no-notify` to clear all targets for a single run.

### Failure behavior

- **Per-target failure** (ntfy 5xx, timeout, network error): logged as `warn`, run continues
- **Per-event failure**: same as per-target — log and move on
- **Config-time failure** (malformed URL): `ConfigError` at startup
- **No targets**: dispatcher is a no-op; no network calls

### Limitations (MVP)

- Only ntfy supported (pluggable via the `NotificationTarget` union)
- No 2-way communication (inbox, replies)
- No retry with backoff — fire once, log on fail, move on
- No notification templates / customization
- No per-agent filtering — every event fires to every target
- No bidirectional click actions on the ntfy side
- **`verdict_received` is not yet wired** in this MVP. The dispatcher has the
  formatter and tests, but the runner does not currently parse the validator
  report to extract the verdict, so no validator notification is sent yet.
  Tracked as a follow-up; all other events fire as listed above.

## 15. Core API (`src/core/index.ts`)

WOPR ships a typed, callable, awaitable core API at `src/core/index.ts` (re-exported as `@earendil-works/wopr-core` in spirit). Every operation an external agent needs is exposed here as a pure or async function. The MCP server and pi extension are thin transports over this surface; the CLI/TUI also go through it internally.

### The 13 exported functions

| Category | Function | Description |
|---|---|---|
| Discovery | `listPipelines(targetDir?)` | Returns all available pipelines (built-in + project). |
| Discovery | `describePipeline(name, targetDir?)` | Full step-by-step detail for one pipeline. |
| Discovery | `listAgents(targetDir?)` | Returns all agents (built-in + project). |
| Discovery | `describeAgent(name, targetDir?)` | Detail for one agent including resolved model. |
| Discovery | `listModels(filter?)` | Models from pi's catalog, filterable by tag/free/reasoning. |
| Discovery | `describeModel(modelID)` | Cost, context window, and tags for one model. |
| Config | `getConfig(scope?, targetDir?)` | Load merged/project/global config. |
| Config | `validateConfig(yaml, targetDir?)` | Validate YAML against the config schema. |
| Config | `diffConfig(scope, yaml, targetDir?)` | Show what would change without writing. |
| Config | `setConfig(scope, yaml, options?)` | Write config with `validateOnly` dry-run mode. |
| Planning | `previewRun(input)` | Complete run preview without creating a workspace. |
| Planning | `estimateCost(input)` | Pure cost projection for a pipeline. |
| Planning | `suggestConfigForBudget({budget, pipeline, ...})` | Proposes a config that fits a budget. |
| Runs | `startRun(input)` | Start a run; returns a `RunHandle` immediately. |
| Runs | `getRunStatus(runId)` | Poll in-flight or finished run status. |
| Runs | `listRuns(filter?)` | List past runs. |
| Runs | `getRunReport(runId, phase)` | Read a phase report (markdown + structured findings). |
| Runs | `getRunCost(runId)` | Cost breakdown by phase and model. |
| Runs | `getRunDiff(runId)` | File-level diff summary. |
| Runs | `getRunCommits(runId)` | Commit list with phase annotations. |
| Runs | `cancelRun(runId, reason?)` | Abort an in-flight run. |
| Runs | `resumeRun(runId)` | Resume an incomplete run. |

### Typed errors

- `ConfigError` — invalid configuration
- `RunNotFoundError` — unknown run ID
- `ValidationError` — config validation with the errors array
- `AbortError` — user-requested abort
- `BudgetExceededError` — budget cap hit

### Worked example

```typescript
// 1. Discover what's available
const pipelines = listPipelines("/Users/me/myapp")
// → [{ name: "implement", stepCount: 6, ... }, ...]

const pipeline = describePipeline("implement", "/Users/me/myapp")
// → { name: "implement", steps: [{ name: "implementer", model: "openai/gpt-5.6-terra#xhigh", ... }, ...] }

// 2. Plan within budget
const suggestion = suggestConfigForBudget({
  budget: 2.00,
  pipeline: "implement",
  targetDir: "/Users/me/myapp",
})
// → { proposed: {...}, estimatedCost: { expected: 0.85, ... }, fitsBudget: true }

// 3. Preview
const preview = previewRun({
  prompt: "Add dark mode toggle",
  pipeline: "implement",
  targetDir: "/Users/me/myapp",
  ...suggestion.proposed,
})
// → { runId: "20260719-...", steps: [...], estimatedCost: {...}, warnings: [] }

// 4. Start the run
const handle = startRun({
  prompt: "Add dark mode toggle",
  pipeline: "implement",
  targetDir: "/Users/me/myapp",
})
// → { runId: "20260719-...", promise: <pending>, abort: <fn> }

// 5. Poll
const status = await getRunStatusAsync(handle.runId)
// → { state: "running", currentPhase: "implementer", ... }

// 6. Read results
const finalStatus = await handle.promise
const report = await getRunReport(handle.runId, "adversarial")
// → { markdown: "...", verdict: "pass", stats: {...} }
const diff = await getRunDiff(handle.runId)
// → { filesChanged: [...], totalAdditions: 142, totalDeletions: 38, ... }
```

### Contract for transport PRDs

The MCP server and pi extension (both separate PRDs) are thin wrappers over these functions. Each function is:

- **Pure or async where I/O is required** — callers never block the event loop on CPU work
- **Typed** — all inputs and outputs are fully typed in TypeScript
- **Self-contained** — no implicit state from the CLI or TUI

When building a transport, import from `src/core/index.ts` and wrap each function in the protocol's request/response shape. No `wopr` shell calls, no `parseAndRun`, no direct imports from `src/runner.ts`.

## 16. MCP server (`wopr mcp`)

The wopr MCP server runs as a stdio-based JSON-RPC server that wraps the core API
for LLM-driven coding agents (Claude Code, Cursor, Codex, Continue, etc.).

### Installation

Add the following to your agent's MCP configuration (e.g. `.mcp.json`):

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

### CLI usage

```bash
wopr mcp              # Start the MCP server (stdio, runs until SIGINT/SIGTERM)
wopr mcp --version    # Print version + "MCP server ready"
wopr mcp --list-tools # Print all 23 tool names and descriptions
```

### The 23 tools

All tools are flat (no namespacing). Inputs accept JSON objects matching the tool's
input schema. Tools return JSON-stringified results in a `text` content block.

| Tool | Calls | Description |
|---|---|---|
| `list_pipelines` | `listPipelines()` | All available pipelines (built-in + project) |
| `describe_pipeline` | `describePipeline(name)` | Step-by-step detail for one pipeline |
| `list_agents` | `listAgents()` | All agents (built-in + project) |
| `describe_agent` | `describeAgent(name)` | Detail for one agent including resolved model |
| `list_models` | `listModels(filter?)` | Models from pi's catalog, filterable by tag/free/reasoning |
| `describe_model` | `describeModel(modelID)` | Cost, context window, and tags for one model |
| `get_config` | `getConfig(scope?)` | Load merged/project/global config |
| `validate_config` | `validateConfig(yaml)` | Validate YAML against the config schema |
| `diff_config` | `diffConfig(scope, yaml)` | Show what would change without writing |
| `set_config` | `setConfig(scope, yaml, ...)` | Write config; `validateOnly: true` for dry-run |
| `preview_run` | `previewRun(input)` | Complete run preview without creating a workspace |
| `estimate_cost` | `estimateCost(input)` | Pure cost projection for a pipeline |
| `suggest_config_for_budget` | `suggestConfigForBudget({...})` | Proposes a config that fits a budget |
| `start_run` | `startRun(input)` | Start a run; returns `runId` immediately |
| `get_run_status` | `getRunStatus(runId)` | Poll in-flight or finished run status |
| `list_runs` | `listRuns(filter?)` | List past runs |
| `get_run_report` | `getRunReport(runId, phase)` | Read a phase report (markdown + findings) |
| `get_run_cost` | `getRunCost(runId)` | Cost breakdown by phase and model |
| `get_run_diff` | `getRunDiff(runId)` | File-level diff summary |
| `get_run_commits` | `getRunCommits(runId)` | Commit list with phase annotations |
| `cancel_run` | `cancelRun(runId, reason?)` | Abort an in-flight run |
| `resume_run` | `resumeRun(runId)` | Resume an incomplete run |

### Error codes

| Code | Meaning | Description |
|---|---|---|
| `-32001` | `config_error` | Invalid wopr configuration |
| `-32002` | `run_not_found` | Requested run ID does not exist |
| `-32003` | `validation_error` | Input failed validation |
| `-32004` | `aborted` | Operation was aborted |
| `-32005` | `budget_exceeded` | Run exceeded its budget cap |
| `-32603` | `internal_error` | Unexpected server error |

### Worked example (Claude Code)

User configures `.mcp.json` as above and types:
> *"Use wopr to add a dark mode toggle. I have $2 to spend."*

The agent calls (programmatically):

1. `list_pipelines` to discover available pipelines
2. `suggest_config_for_budget` with budget=$2, pipeline=implement
3. `preview_run` with the suggested config
4. Narrates the plan to the user
5. `start_run` to begin execution
6. `get_run_status` (polling loop) to track progress
7. `get_run_report` to read the adversarial validator's verdict
8. `get_run_cost` to confirm the total stayed under budget

### Installing in your agent

See [`docs/mcp-installation.md`](./docs/mcp-installation.md) for ready-to-use
`.mcp.json` / `.cursor/mcp.json` / Codex `config.toml` snippets for
Claude Code, Cursor, and Codex.

## 16.5 Pi extension (`extensions/wopr-for-pi/`)

The same 23 tools are available as a [pi](https://github.com/earendil-works/pi)
native extension. Instead of MCP/JSON-RPC, the extension registers each tool
directly with pi's `ExtensionAPI.registerTool()` — tools are part of the same
pi process, no subprocess, no JSON-RPC.

### Install

```bash
# From the wopr repo root
pi extensions install ./extensions/wopr-for-pi

# Or from anywhere
pi extensions install /path/to/wopr/extensions/wopr-for-pi
```

### Tool surface

All 23 tools share the same schemas and behavior as the MCP server's tools; pi adds a `wopr_` prefix to each name. The extension registers them as
`wopr_list_pipelines`, `wopr_start_run`, etc., and the bundled `skill.md` teaches pi when and how to call them.

### The skill

The extension ships a `skill.md` that pi loads into context. It teaches pi
*when* to use wopr tools (multi-step implementation, quality-sensitive work)
and *how* to compose them (the natural sequence of discover → plan → preview
→ start → poll → report).

### When to use it

Use the pi extension when you're inside a `pi` session and want to drive wopr
without shelling out. The tools are request/response; poll `get_run_status`
for async progress.

### Shared source

Both the MCP server and the pi extension consume tool definitions from
`src/core/tools/`. Adding a tool to that directory makes it available on
both transports automatically.

## 17. Composing pipelines dynamically

Instead of picking a named pipeline, you can pass a custom `steps` array.
The agent (or the spec) decides which steps to run, in what order. WOPR
still wraps the steps in a `Plan`-shaped `Pipeline` internally (with the
per-phase commit, diff, and report machinery), so the experience is
identical — just without the constraint of the 8 built-in shapes.

```typescript
// MCP / Claude Code example — recommend a pipeline, then run exactly those steps.
// recommendPipeline returns `custom` steps for high-rigor audit/security contexts:
import { recommendPipeline, startRun } from "./src/core"

const rec = await recommendPipeline({
  prompt: "check the auth module for security issues",
  preferences: { readOnly: true, rigor: "high" },
})
// → {
//     kind: "custom",
//     reason: "read-only review with high rigor: custom audit pipeline",
//     steps: [
//       { agent: "review-scope" },
//       { agent: "security-reviewer" },
//       { agent: "adversarial-reviewer" },
//       { agent: "review-report" },
//     ],
//   }

// Start a run with those exact steps. For a trivial fix you'd usually skip
// recommendPipeline and pass a minimal `steps` array directly:
const handle = startRun({
  prompt: "check the auth module for security issues",
  targetDir: "/Users/me/myapp",
  steps: rec.kind === "custom" ? rec.steps : undefined,
  budget: { perRun: 0.50 },
})
```

### Via CLI

```bash
wopr --steps "implementer,tests" --prompt-file prd.md
wopr --steps "security-auditor,review-fixer,review-validator" "Fix things"
```

Comma-separated agent names resolve to `{ agent: <name> }` steps. The `--steps`
flag is mutually exclusive with `--pipeline`.

### Via MCP `start_run`

The `start_run` tool accepts a `steps` array directly. When `steps` is set,
`pipeline` is ignored.

```json
{
  "prompt": "fix the typo in src/foo.ts",
  "targetDir": "/Users/me/myapp",
  "steps": [
    { "agent": "implementer" },
    { "agent": "test-engineer" }
  ]
}
```

### Via `recommend_pipeline` (MCP tool)

The `recommend_pipeline` MCP tool (and its core function counterpart) uses a
keyword-based heuristic to recommend either a named pipeline or a custom steps
array. No LLM cost — pure string matching + preference logic.

### Step names

Step names correspond to agent names from the registry (`list_agents`). Each
step can also specify an optional `model` override and an optional `name`.

### Deprecation of `*-lite`

The `*-lite` pipelines (`implement-lite`, `review-lite`) are pre-baked budget
presets. With Budgets (`--budget`, `suggestConfigForBudget`) in main, these are
redundant — use `implement` or `review` with `suggestConfigForBudget({ budget,
tier: "free-only" })` instead. They stay for back-compat; removed in v0.3.

---

## 18. One last thing

WOPR is a **draft generator**, not a final-answer machine. Every output needs human review before it ships to a real codebase. The pipeline's job is to do the 80% — the boring implementation, the standard patterns, the obvious tests — so the human can spend their attention on the 20% that matters: is the architecture right, are the tradeoffs the right ones, does this actually solve the user's problem.

If a run produces 2000 lines of code and your reaction is "wow, that's a lot", something's wrong — the PRD was too broad. A good run produces 200-400 lines, well-tested, with a tight diff and a clear commit history. If the diff is bigger than that, narrow the next PRD.

If a run fails partway, read the failing phase's report. The answer is usually there.

If a run succeeds and the validator says PASS and you read the diff and it looks good — congratulations, you have a shippable branch. Merge it, run the real test suite, push the PR. The loop is complete.

**Now go write a good PRD.** 🛠️
