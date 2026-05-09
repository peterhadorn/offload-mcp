# agent-router-mcp Rough Spec

## Goal

Route coding-agent tasks to the cheapest capable model automatically: keep hard work on the primary model, send routine work to cheaper/free models, and track savings.

## Core Idea

An MCP server exposes routing tools:

```text
route_task
route_and_run
offload_source
model_status
router_stats
```

## Routing Levels

```text
primary/deep: architecture, multi-file edits, debugging, security-sensitive work
mid: implementation, tests, refactors, code review
cheap: summaries, translations, commit messages, docstrings, extraction, freeform routine prompts
source: diffs/files/logs read directly by the MCP server to avoid primary input tokens
```

## Config Shape

```yaml
providers:
  cheap:
    - google:gemma-3-27b-it
    - google:gemma-4-31b-it
  mid:
    - anthropic:claude-sonnet
  deep:
    - anthropic:claude-opus

routes:
  commit_message: cheap
  pr_description: cheap
  docstring: cheap
  code_review_single: mid
  architecture: primary
```

## Main Features

- Intent classification: detect task type, complexity, and risk.
- Source loading: read local diffs, files, and logs inside the MCP server.
- Model fallback chains per route.
- Cost, token, latency, and failure tracking.
- Safety rules for secrets, security-sensitive work, and complex tool-dependent tasks.
- Manual override: `route="cheap"`, `route="mid"`, `route="primary"`.

## Important Limitation

MCP cannot force the host agent itself to switch from Opus to Sonnet, Codex to another model, or similar, unless that client exposes model-switching control.

The router can:

- run subtasks through configured provider APIs;
- recommend a route;
- avoid loading local source into the primary model by reading it through MCP.

## MVP

1. Start from `offload-mcp`.
2. Add provider abstraction.
3. Add route config.
4. Add `route_and_run(task, content/source)`.
5. Add stats: model used, tokens processed, primary input avoided, estimated cost saved.

## Positioning

A model router for coding agents: keep hard work on your best model, route routine work to cheaper/free models, and see what you saved.
