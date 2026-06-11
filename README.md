# archer

Sequential [OpenCode](https://opencode.ai) agent pipeline for implementing features on software repos. It works with Flutter, web, backend, CLI, and mixed projects by detecting the repo's existing stack and conventions. Takes a PRD, runs agents in chain, and leaves one commit per phase.

Archer is written in Bun + TypeScript and uses `@opencode-ai/sdk` to control OpenCode. The SDK starts/controls the OpenCode server; Archer no longer manually calls `opencode run` nor parses stdout.

## The Pipeline

```
PRD ──► implementer ──► human-review ──► pattern-auditor ──► security-auditor ──► design-polisher ──► test-engineer ──► adversarial-reviewer
         │                                │                    │                    │                  │                │
         └────────────────────────────────┴────────────────────┴────────────────────┴──────────────────┴────────────────┘
                                                              commit per phase
```

| Phase | Model | What it does |
|---|---|---|
| `implementer` | `openai/gpt-5.5#xhigh` | Implements the feature respecting repo patterns |
| `human-review` | interactive checkpoint | Runs the app, waits for approval, or hands control to OpenCode for manual iteration |
| `patterns` | `openai/gpt-5.5#xhigh` | Refactors without changing behavior, aligns with the rest of the code |
| `security` | `openai/gpt-5.5#xhigh` | Audits and fixes security issues |
| `design` | `anthropic/claude-opus-4-7` | Polishes UI following the repo's design system |
| `tests` | `openai/gpt-5.5#xhigh` | Automated tests + relevant E2E/integration coverage |
| `adversarial` | `anthropic/claude-opus-4-7` | Final adversarial review before PR creation |

## Requirements

- Bun 1.0+
- `opencode` installed and authenticated (`opencode auth login`)
- `git`

## Authentication And Providers

Archer does not store provider credentials. It starts `opencode serve` through the SDK and passes only runtime agent configuration via `OPENCODE_CONFIG_CONTENT`; the server inherits your shell environment and uses the credentials already configured in OpenCode.

Useful commands:

```bash
opencode providers list
opencode providers login --provider openai
opencode providers login --provider anthropic
opencode models openai
opencode models anthropic
```

To use different providers, authenticate them in OpenCode and select models as `provider/model`. Archer defaults to `openai/gpt-5.5` with variant `xhigh` for non-design phases, and `anthropic/claude-opus-4-7` for design and adversarial review.

## Installation

```bash
git clone <this-repo> archer
cd archer
bun install
make install
```

This leaves `archer` in `~/.local/bin/archer`. Make sure it's in your `PATH`.

## Usage

From the root of the target repo, ideally on a working branch:

```bash
# inline prompt
archer "Add onboarding screen with 3 steps and local persistence of progress"

# prompt from file
archer --prompt-file prd.md

# attach files or directories to all phases
archer --prompt-file prd.md --file src/features/onboarding --file tests/onboarding.test.ts

# only one phase
archer --prompt-file prd.md --only implementer

# skip phases
archer --prompt-file prd.md --skip security,design

# force a different model for all phases
archer --prompt-file prd.md --model anthropic/claude-sonnet-4-6

# disable the OpenTUI progress footer
archer --prompt-file prd.md --no-tui

# disable the post-implementer manual checkpoint
archer --prompt-file prd.md --no-human-review

# configure the app command used during manual review
archer --prompt-file prd.md --app-run-command "pnpm dev"

# optional Flutter emulator launch during manual review
archer --prompt-file prd.md --emulator Pixel_8 --app-run-command "flutter run -d emulator-5554"

# resume a failed run (phases that already wrote their report are skipped,
# and the dashboard restores their real duration, cost, and session)
archer --resume 20260519-103045-x7q2

# browse run history in the dashboard TUI: a selectable list (newest first,
# with status, date, cost, and prompt) plus a details panel with the per-phase
# breakdown. ↑/↓ select, [enter] resume, [s]ummary/reports overlay, subshell
# in the run [d]ir under ~/.archer/runs (exit to return), [q]uit.
# Pass a run ID to open the browser with that run preselected.
# Without a TTY (pipes/CI) it falls back to a plain listing.
archer runs
archer runs 20260519-103045-x7q2

# auto-allow ask-level permissions (the hard denylist still applies)
archer --prompt-file prd.md --yolo

# preserve run dir after completion
archer --prompt-file prd.md --keep-run-dir

# change the base branch used to calculate diffs between phases
# (the ref is validated at startup; repos without a local main need this)
archer --prompt-file prd.md --base develop

# include existing local changes in the first commit of the pipeline
archer --prompt-file prd.md --include-dirty --max-attempts 1
```

In interactive terminals, Archer shows a full-screen OpenTUI dashboard: pipeline progress with per-phase duration and cost, plus an activity panel headed by a compact summary of the active session (current tool/thinking/writing, the agent's todo list, files changed, step count, tokens, cost) above a color-coded event feed. The dashboard never paints backgrounds: the canvas is your terminal's own background and panels are delineated by borders alone, derived as subtle elevations of the terminal's reported background color, with dark or light accents picked by its brightness (and a neutral fallback when the terminal doesn't answer); floating modals repaint the reported color exactly to mask the content beneath them. It follows live theme changes. Press `o`, or click the footer, to open the active OpenCode session in a new terminal window attached to Archer's running OpenCode server — clicking any pipeline row opens that phase's session, including phases that already finished. Ghostty is preferred when installed; Terminal.app is the fallback (`ARCHER_TERMINAL=ghostty|terminal` forces a backend). Press `Shift+Tab` to toggle auto-accept (see the permission gate below). Press `Ctrl+C` once to abort the active OpenCode session and shut down Archer cleanly; press it again to force exit if cleanup hangs. The dashboard suspends for the whole `human-review` checkpoint — the prompts, your app command's output, and interactive OpenCode iterations own the terminal — and resumes when the gate finishes. Use `--no-tui` to fall back to plain logs.

Phases run asynchronously: Archer fires the prompt with OpenCode's async API and detects completion through the event stream (`session.idle` / `session.error`), with a 30-second session-status poll as fallback and automatic event-stream reconnection. No HTTP request stays open for the duration of a phase, so long-running phases are immune to client-side socket timeouts. Archer also disables OpenCode's total provider request timeout for its default providers and keeps a 10-minute provider stream idle timeout instead.

## Permission gate

Agents run with a restricted bash policy: a small allowlist of safe Flutter/Dart, web/Node, test/build, and read-only git commands; a denylist of unambiguously dangerous patterns (`git push*`, `gh*`, deployment/publish commands, `sudo*`, recursive deletes against `/` or `~`, `curl … | sh`, package installers); and everything else falls through to `ask`.

When an agent runs a command that isn't on the allowlist, Archer prints the request and prompts:

```
approve? [o]nce, [a]lways, [r]eject >
```

- `o` allows the single call.
- `a` allows future calls matching the same pattern for the rest of the run.
- `r` rejects the call (the agent receives a denial and decides what to do next).

In non-interactive runs (no TTY), unknown commands are auto-rejected and logged. Tighten the policy further or expand the allowlist in `src/agents.ts` (`bashPolicy`).

Archer also allowlists the target repo's own `package.json` scripts whose names look like checks (`test`, `lint`, `typecheck`, `type-check`, `check`, `build`, `format`, `validate`, including suffixed forms like `test:unit`), excluding anything whose name suggests side effects (`deploy`, `publish`, `release`, `migrate`, `seed`, `reset`). Note the trust model: agents can edit the repo, including script bodies, so allowlisted scripts mean trusting the repo's contents — the denylist protects against accidents, it is not a security boundary against a malicious agent.

### Auto-accept (`--yolo` / `Shift+Tab`)

`--yolo` starts the run with auto-accept enabled: every permission request that would normally *ask* is allowed automatically (replied as "once") and logged to the activity feed. In the dashboard, `Shift+Tab` toggles auto-accept at any time — enabling it also resolves any prompts already queued. The footer always shows the current state. The hard denylist is enforced by OpenCode itself and is never relaxed: denied commands are rejected before they ever reach the gate, with or without `--yolo`.

## Commit safety

Before each commit Archer scans the staged files for common secret names (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `*.p12`, `*.keystore`, ...). If any match, the commit is aborted, the index reset, and Archer asks you to add them to `.gitignore` (or delete them) before re-running. Combined with `--include-dirty` this is the only line of defense against accidentally publishing a secret your working tree had lying around — review the resulting commits with `git show` before pushing.

During `human-review`, Archer waits 10 seconds for an explicit action. If nobody answers, it prepares the configured app command in the target worktree. By default the app command is disabled; pass `--app-run-command "pnpm dev"`, `--app-run-command "flutter run"`, or the repo's equivalent. Archer only launches a Flutter emulator when `--emulator <id>` is explicitly provided.

## Project Context And Custom Agents

Archer automatically attaches these target-repo files to every phase when they exist:

```text
.archer/rules.md
AGENTS.md
CLAUDE.md
```

Use `.archer/rules.md` for project-specific Archer instructions. It is intentionally the only Archer rules filename to avoid ambiguous precedence. `AGENTS.md` and `CLAUDE.md` are treated as additional repo context.

Built-in agent prompts live as Markdown files under `prompts/`. A project can fully replace a built-in agent prompt with:

```text
.archer/
└── agents/
    ├── implementer.md
    ├── pattern-auditor.md
    ├── security-auditor.md
    ├── design-polisher.md
    ├── test-engineer.md
    └── adversarial-reviewer.md
```

When a project override exists, it replaces that agent's built-in prompt completely. Archer still appends its non-replaceable runtime safety guard rails from `prompts/runtime-safety.md`.

## Efficient Attachments

`--file` is repeatable and accepts files or directories. Relative paths are resolved against the target repo.

Archer doesn't paste those contents into the prompt. It sends them to the SDK as `FilePartInput` with `file://` URL, just like OpenCode's `--file`. It does the same internally with `prd.md`, previous reports, and phase diffs.

## Anatomy of a Run

Each invocation creates `~/.archer/runs/<run-id>/`:

```
~/.archer/runs/20260519-103045-x7q2/
├── prd.md
├── metadata.json
├── reports/
│   ├── implementer.md
│   ├── human-review.md
│   ├── patterns.md
│   ├── security.md
│   ├── design.md
│   ├── tests.md
│   └── adversarial.md
├── diffs/
│   ├── patterns.pre.diff
│   ├── security.pre.diff
│   ├── design.pre.diff
│   ├── tests.pre.diff
│   └── adversarial.pre.diff
├── logs/
│   ├── implementer.1.json
│   └── ...
└── SUMMARY.md
```

`metadata.json` records each phase's status, session ID, timing, cost, tokens, and model as the run progresses (written atomically, debounced). On `--resume`, phases that already wrote their report are restored in the dashboard with their real duration, cost, and session — and their session can still be opened by clicking the pipeline row.

The run dir is deleted on successful completion unless `--keep-run-dir`. If it fails, it's preserved for inspecting reports, diffs, and logs.

The target repo only sees commits with prefix `archer(<phase>): ...`, made on the current branch. No CLI files are left in the project.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

## Structure

```
archer/
├── src/
│   ├── main.ts          # entrypoint
│   ├── cli.ts           # flag parsing
│   ├── runner.ts        # pipeline orchestration
│   ├── opencode.ts      # startup/control via SDK
│   ├── agents.ts        # prompt loading, agent config, bash policy
│   ├── project-context.ts # automatic .archer/rules.md, AGENTS.md, CLAUDE.md discovery
│   ├── permissions.ts   # live permission gate for tool calls that fall outside the allowlist
│   ├── attachments.ts   # FilePartInput for --file and internal attachments
│   ├── git.ts           # diff, commit, and pre-commit secret scan
│   ├── workspace.ts     # run dir
│   ├── runs.ts          # interactive run-history browser (archer runs)
│   ├── metadata.ts      # per-run metadata.json for --resume restore
│   └── phases.ts        # declarative phase definition
├── prompts/             # built-in agent prompts and runtime safety guard rails
├── test/                # unit tests for CLI/orchestration
├── package.json
├── tsconfig.json
└── Makefile
```
