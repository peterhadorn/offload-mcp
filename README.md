# offload-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/offload-mcp)](https://www.npmjs.com/package/offload-mcp)

**MCP server for offloading routine coding-assistant work to a cheaper model.**

The default model chain uses Gemma because the models are useful, open, and fun to experiment with. Running them locally can be heavy on RAM, GPU, and setup; the Gemini API (Google AI Studio) makes them easy to use for small routine tasks at almost no cost. You can use any supported model ID.

## Install

Get a free API key from <https://aistudio.google.com/apikey>.

Choose one install method.

### Option 1: npx (recommended)

`npx` downloads and runs `offload-mcp@latest` on demand. You do not need to install the package globally. Your MCP client runs this command whenever it starts the server.

JSON-style MCP config:

```json
{
  "mcpServers": {
    "offload-mcp": {
      "command": "npx",
      "args": ["offload-mcp@latest"],
      "env": { "GOOGLE_AI_API_KEY": "your_key" }
    }
  }
}
```

TOML-style MCP config:

```toml
[mcp_servers.offload-mcp]
command = "npx"
args = ["offload-mcp@latest"]
env = { GOOGLE_AI_API_KEY = "your_key" }
```

To test that npm can resolve the package:

```bash
npx offload-mcp@latest
```

That starts an MCP stdio server, so it will wait for an MCP client instead of printing a normal CLI screen.

### Option 2: global npm install

Install once:

```bash
npm install -g offload-mcp
```

Then use the binary directly in your MCP config.

JSON-style MCP config:

```json
{
  "mcpServers": {
    "offload-mcp": {
      "command": "offload-mcp",
      "env": { "GOOGLE_AI_API_KEY": "your_key" }
    }
  }
}
```

TOML-style MCP config:

```toml
[mcp_servers.offload-mcp]
command = "offload-mcp"
env = { GOOGLE_AI_API_KEY = "your_key" }
```

To update a global install later:

```bash
npm update -g offload-mcp
```

## Use

Ask your assistant to offload routine work:

```text
offload a commit message for the current diff
offload this translation to Mexican Spanish: <text>
use offload to summarize src/index.ts
```

For local diffs and files, `offload_source` is the important path because the MCP server reads the input directly:

```text
offload_source(task="commit_message", source="git_diff")
offload_source(task="pr_description", source="git_staged_diff")
offload_source(task="code_summary", source="file", path="src/index.ts")
```

Footer example:

```text
—— Offloaded via gemma-4-31b-it · 307 model tokens · ~1,420 primary input tokens avoided · offload-mcp
```

`model tokens` come from the API response. `primary input tokens avoided` is an estimate and only appears when using `offload_source`.

## Tasks

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

Use `freeform` for anything else:

```text
offload(task="freeform", content="ECONNREFUSED 10.0.1.5:5432", prompt="Rewrite as a user-friendly error message. Output only the message.")
```

## Status

`offload_status` shows local usage counters:

```text
Today: 47/14400 calls (0.3%), 28,500 model tokens processed
Month: 312 calls over 8 days (avg 39/day), 187,400 model tokens processed
Estimated primary input avoided: today ~12,800 tokens, month ~74,200 tokens
Tasks today:
  commit_message: 18
  docstring: 12
  code_summary: 9
```

Stats are stored locally at `~/.offload-mcp/usage.json` by default. Only counters are stored, not task content.

## Config

| Env var | Default | Description |
|---------|---------|-------------|
| `GOOGLE_AI_API_KEY` | - | Required |
| `OFFLOAD_MODEL` | `gemma-4-31b-it` | Preferred model |
| `OFFLOAD_FALLBACK_MODELS` | `gemma-3-27b-it` | Comma-separated fallback models |
| `OFFLOAD_TIMEOUT_MS` | `20000` | Per-model request timeout |
| `OFFLOAD_RETRIES_PER_MODEL` | `1` | Attempts per model before falling back (1 = no retry) |
| `OFFLOAD_RPD_LIMIT` | `14400` | Local daily call limit. Lower it if your Gemini API account has a stricter quota. |
| `OFFLOAD_LOG_PATH` | `~/.offload-mcp/usage.json` | Local usage stats |

By default, requests try `gemma-4-31b-it` first and fall back to `gemma-3-27b-it` on timeouts, rate limits, and transient server errors. Set `OFFLOAD_FALLBACK_MODELS=` to disable fallback.

## Data

offload-mcp sends task content to the configured Gemini API model. Do not offload secrets, private customer data, proprietary code, or regulated data unless your policy allows it.

`offload_source` with `source="file"` reads any file path the MCP server process can access. Treat the `path` and `cwd` parameters as trusted local input from your MCP client.

MIT
