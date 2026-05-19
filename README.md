# archer

Sequential [OpenCode](https://opencode.ai) agent pipeline for implementing features on a Flutter repo. Takes a PRD, runs agents in chain, and leaves one commit per phase.

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
| `tests` | `openai/gpt-5.5#xhigh` | Unit/widget tests green + Maestro flows |
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
archer --prompt-file prd.md --file lib/features/onboarding --file test/onboarding_test.dart

# only one phase
archer --prompt-file prd.md --only implementer

# skip phases
archer --prompt-file prd.md --skip security,design

# force a different model for all phases
archer --prompt-file prd.md --model anthropic/claude-sonnet-4-6

# disable the post-implementer manual checkpoint
archer --prompt-file prd.md --no-human-review

# launch a specific Flutter emulator and app command during manual review
archer --prompt-file prd.md --emulator Pixel_8 --app-run-command "flutter run -d emulator-5554"

# resume a failed run
archer --resume 20260519-103045-x7q2

# preserve run dir after completion
archer --prompt-file prd.md --keep-run-dir

# change the base branch used to calculate diffs between phases
archer --prompt-file prd.md --base develop

# include existing local changes in the first commit of the pipeline
archer --prompt-file prd.md --include-dirty --max-attempts 1
```

## Efficient Attachments

`--file` is repeatable and accepts files or directories. Relative paths are resolved against the target repo.

Archer doesn't paste those contents into the prompt. It sends them to the SDK as `FilePartInput` with `file://` URL, just like OpenCode's `--file`. It does the same internally with `prd.md`, previous reports, and phase diffs.

## Anatomy of a Run

Each invocation creates `~/.archer/runs/<run-id>/`:

```
~/.archer/runs/20260519-103045-x7q2/
├── prd.md
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
│   ├── agents.ts        # inline prompts and agent config
│   ├── attachments.ts   # FilePartInput for --file and internal attachments
│   ├── git.ts           # diff and commit
│   ├── workspace.ts     # run dir
│   └── phases.ts        # declarative phase definition
├── test/                # unit tests for CLI/orchestration
├── package.json
├── tsconfig.json
└── Makefile
```
