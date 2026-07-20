# wopr-for-pi --- wopr orchestration tools for pi

[pi](https://github.com/earendil-works/pi) extension that registers all 23
wopr tools as first-class pi-native tools. No shelling out to `wopr`, no MCP
subprocess --- every tool runs in-proc over the same typed core API the CLI and
MCP server use.

## Install

```bash
# From the wopr repo root
pi extensions install ./extensions/wopr-for-pi

# Or from anywhere
pi extensions install /path/to/wopr/extensions/wopr-for-pi
```

## What you get

23 tools with the `wopr_` prefix:

| Tool | What it does |
|---|---|
| `wopr_list_pipelines` | List available pipelines |
| `wopr_describe_pipeline` | Detail for one pipeline |
| `wopr_list_agents` | List all agents |
| `wopr_describe_agent` | Detail for one agent |
| `wopr_list_models` | List models from pi's catalog |
| `wopr_describe_model` | Cost + context for one model |
| `wopr_get_config` | Load merged/project/global config |
| `wopr_validate_config` | Validate YAML config |
| `wopr_diff_config` | Show what would change |
| `wopr_set_config` | Write config (dry-run with validateOnly) |
| `wopr_preview_run` | Dry-run a pipeline without running it |
| `wopr_estimate_cost` | Cost projection for a pipeline |
| `wopr_suggest_config_for_budget` | Config that fits a budget |
| `wopr_recommend_pipeline` | Recommend a pipeline or custom steps |
| `wopr_start_run` | Start a pipeline run |
| `wopr_get_run_status` | Poll run status |
| `wopr_list_runs` | List past runs |
| `wopr_get_run_report` | Read a phase report |
| `wopr_get_run_cost` | Cost breakdown |
| `wopr_get_run_diff` | File-level diff summary |
| `wopr_get_run_commits` | Commit list |
| `wopr_cancel_run` | Abort an in-flight run |
| `wopr_resume_run` | Resume an incomplete run |

## Usage

Once installed, start `pi` in any directory that has wopr installed (or in the
wopr repo itself). The tools are automatically discovered. Ask pi to use wopr:

```
> Use wopr to add a dark mode toggle. I have $5 to spend.
```

Pi discovers the tools, loads the wopr skill, and orchestrates the run
end-to-end --- discover, plan, preview, run, report.

## Minimum pi version

Requires pi >= 0.80.7.

## Architecture

```
pi session -> wopr extension -> registerAllWoprTools(pi) -> pi.registerTool(...)
                                   |
                                   +-> src/core/tools/ (shared ToolDef source)
                                         |
                                         +-> src/core/ (typed core API)
```

The 23 tool definitions are shared between this extension and the MCP server.
Both are thin transports over the same underlying functions.
