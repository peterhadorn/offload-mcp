# offload-mcp

**MCP server that offloads routine tasks from your AI coding assistant to Google's free Gemma 4 API.**

Commit messages, docstrings, translations, code summaries, data extraction — or anything via freeform prompts. Works with Claude Code, Cursor, Windsurf, Cline, and Codex. Zero cost, zero setup.

## Quick Start

```bash
# 1. Get a free API key (no credit card)
#    → https://aistudio.google.com/apikey

# 2. Add to Claude Code
claude mcp add offload-mcp -e GOOGLE_AI_API_KEY=your_key -- npx offload-mcp
```

That's it. The server ships its routing rules via the MCP `instructions` field — your AI learns when to offload automatically on connect. Next session, routine tasks go to Gemma 4 without any extra config.

## What It Does

Your AI assistant calls `offload(task, content)` → offload-mcp sends it to Google's free Gemma 4 31B API → result comes back with a tag:

```
feat(auth): add JWT token validation

[offloaded via gemma-4-31b-it · 63 tokens]
```

### Built-in Tasks

| Task | Example |
|------|---------|
| `commit_message` | Generate conventional commit from a diff |
| `pr_description` | PR summary with bullets and file list |
| `code_summary` | 2-3 sentence summary of what code does |
| `translate` | Translate text, preserving formatting and tone |
| `changelog_entry` | Changelog line per logical change |
| `naming_suggestion` | 3 name options for a variable, function, or class |
| `classify` | Classify text into categories |
| `extract_data` | Pull structured data from unstructured text |
| `code_review_single` | Review a single function for bugs |
| `docstring` | Docstring with params, returns, throws |
| `subject_lines` | 5 email subject line variants |

### Freeform

For anything not listed above, use `task="freeform"` with a custom prompt:

```
offload(task="freeform", content="ECONNREFUSED 10.0.1.5:5432", prompt="Rewrite as a user-friendly error message")
```

Rewrite error messages, summarize logs, format data, extract action items, generate regex — anything a smaller model handles fine.

## Tools

### `offload`

| Parameter | Type | Description |
|-----------|------|-------------|
| `task` | enum | Built-in task name or `freeform` |
| `content` | string | The text to process |
| `prompt` | string (optional) | Custom instruction — required for `freeform` |

### `offload_status`

No parameters. Returns usage stats:

```
Today: 47/1500 calls (3.1%), 28,500 tokens offloaded
Month: 312 calls over 8 days (avg 39/day), 187,400 tokens offloaded
Tasks today:
  commit_message: 18
  docstring: 12
  code_summary: 9
```

## Client Setup

**Claude Code**
```bash
claude mcp add offload-mcp -e GOOGLE_AI_API_KEY=your_key -- npx offload-mcp
```

**Cursor** — add to `.cursor/mcp.json`:
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

**Windsurf** — same JSON block in `~/.codeium/windsurf/mcp_config.json`.

**Cline** — MCP Servers → Add → command: `npx offload-mcp`, env: `GOOGLE_AI_API_KEY`.

**Codex** — add `npx offload-mcp` to your MCP config.

> **Optional fallback:** clients that don't auto-load MCP `instructions` won't see the routing rules. In that case, copy the matching file from [`rules/`](https://github.com/peterhadorn/offload-mcp/tree/main/rules) into the client's rules location (e.g. `~/.claude/rules/offload.md`, `.cursorrules`, `AGENTS.md`).

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `GOOGLE_AI_API_KEY` | — | **Required.** Free key from [aistudio.google.com](https://aistudio.google.com/apikey) |
| `OFFLOAD_MODEL` | `gemma-4-31b-it` | Model to use |
| `OFFLOAD_RPD_LIMIT` | `1500` | Max requests per day |
| `OFFLOAD_LOG_PATH` | `~/.offload-mcp/usage.json` | Usage data location |

## How It Works

```
You: "commit this"
  → Claude reads the rules → sees "commit messages → offload"
    → offload(task="commit_message", content=<diff>)
      → Gemma 4 API (free, 1500 req/day)
        → "feat(auth): add JWT validation"
          → Claude uses it, you save tokens
```

Quota enforced in-memory (survives I/O failures). File persistence is best-effort for cross-restart continuity. Warnings at 50/75/90%, hard stop at the limit — falls back to your primary AI silently.

No GPU needed. No Docker. No Ollama. Just `npx`.

## Development

```bash
git clone https://github.com/peterhadorn/offload-mcp
cd offload-mcp
npm install
npm test      # 19 tests
npm run build
```

## License

MIT
