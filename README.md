# offload-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/peterhadorn/offload-mcp?display_name=tag&sort=semver)](https://github.com/peterhadorn/offload-mcp/releases)

**Offload routine coding-assistant tasks to lower-cost models through MCP.**

The default config uses the Gemma family because those models are useful, open, and genuinely fun to experiment with. Running them locally can be expensive in RAM, GPU, and setup time; the Google GenAI API makes them easy to use for small routine jobs at almost no cost. You can point the server at any supported model ID.

offload-mcp gives any MCP-aware assistant two tools:

- `offload` sends pasted text to the configured model.
- `offload_source` lets the MCP server read local diffs or files directly, so the assistant can avoid loading that input into its own context first.

![offload-mcp demo](assets/demo.gif)

## Quick Start

```bash
# Get a free API key:
# https://aistudio.google.com/apikey
```

JSON-style MCP config:

```json
{
  "mcpServers": {
    "offload-mcp": {
      "command": "npx",
      "args": ["offload-mcp"],
      "env": { "GOOGLE_AI_API_KEY": "your_key" }
    }
  }
}
```

TOML-style MCP config:

```toml
[mcp_servers.offload-mcp]
command = "npx"
args = ["offload-mcp"]
env = { GOOGLE_AI_API_KEY = "your_key" }
```

## Usage

Ask your assistant to offload routine work:

```text
offload a commit message for the current diff
offload this translation to Mexican Spanish: <text>
use offload to summarize src/index.ts
```

For local repo input, `offload_source` is the useful path:

```text
offload_source(task="commit_message", source="git_diff")
offload_source(task="pr_description", source="git_staged_diff")
offload_source(task="code_summary", source="file", path="src/index.ts")
```

Example footer:

```text
—— Offloaded via gemma-4-31b-it · 307 model tokens · ~1,420 primary input tokens avoided · offload-mcp
```

`model tokens` come from the API response. `primary input tokens avoided` is an estimate based on local source size and only appears for `offload_source`.

## Tasks

Built-in task names:

```text
commit_message
pr_description
code_summary
translate
changelog_entry
naming_suggestion
classify
extract_data
code_review_single
docstring
subject_lines
freeform
```

Use `freeform` with a custom prompt for anything else:

```text
offload(task="freeform", content="ECONNREFUSED 10.0.1.5:5432", prompt="Rewrite as a user-friendly error message. Output only the message.")
```

## Status

`offload_status` shows usage and estimated saved input context:

```text
Today: 47/1500 calls (3.1%), 28,500 model tokens processed
Month: 312 calls over 8 days (avg 39/day), 187,400 model tokens processed
Estimated primary input avoided: today ~12,800 tokens, month ~74,200 tokens
Tasks today:
  commit_message: 18
  docstring: 12
  code_summary: 9
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `GOOGLE_AI_API_KEY` | - | Required. Free key from AI Studio |
| `OFFLOAD_MODEL` | `gemma-4-31b-it` | Preferred model |
| `OFFLOAD_FALLBACK_MODELS` | `gemma-3-27b-it` | Comma-separated fallback models |
| `OFFLOAD_TIMEOUT_MS` | `20000` | Per-model request timeout |
| `OFFLOAD_RETRIES_PER_MODEL` | `1` | Attempts before trying the next model |
| `OFFLOAD_RPD_LIMIT` | `1500` | Max requests per day |
| `OFFLOAD_LOG_PATH` | `~/.offload-mcp/usage.json` | Local usage stats |

By default, requests try `gemma-4-31b-it` first and fall back to `gemma-3-27b-it` on timeouts, rate limits, and transient server errors. This is just the default chain; set `OFFLOAD_MODEL` and `OFFLOAD_FALLBACK_MODELS` to use different model IDs. Set `OFFLOAD_FALLBACK_MODELS=` to disable fallback.

## Data

offload-mcp sends task content to the configured Google GenAI model. Do not offload secrets, private customer data, proprietary code, or regulated data unless your policy allows it. offload-mcp stores local usage stats only; it does not store task content.

## Development

```bash
npm install
npm test
npm run build
```

MIT
