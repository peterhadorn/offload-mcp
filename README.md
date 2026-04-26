# offload-mcp

**Offload routine AI coding tasks to free LLM APIs**

Works with Claude Code, Cursor, Windsurf, Cline, and Codex. Adds two MCP tools that route low-value tasks (commit messages, docstrings, translations) to Gemma 4 via Google AI Studio's free tier — keeping your primary AI's context clean.

---

## Why

- **Zero cost** — Google AI Studio free tier, no credit card
- **Any MCP client** — one config block, any editor
- **11 task types** — commit messages, PR descriptions, docstrings, and more
- **Daily quota tracking** — warnings at 50/75/90%, hard stop at limit

---

## Quick Start

**1. Get a free API key**

[https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)

**2. Add to your MCP client**

```bash
GOOGLE_AI_API_KEY=your_key claude mcp add offload-mcp -- npx offload-mcp
```

Or set the env var globally and run:

```bash
claude mcp add offload-mcp -- npx offload-mcp
```

**3. Copy the rules file**

Copy `rules/offload.md` into your project's `.claude/` directory (or equivalent). This tells your AI assistant when to use the offload tools automatically.

---

## Client Setup

| Client | Install command |
|--------|----------------|
| **Claude Code** | `GOOGLE_AI_API_KEY=your_key claude mcp add offload-mcp -- npx offload-mcp` |
| **Cursor** | Add to `.cursor/mcp.json`: `{"mcpServers": {"offload-mcp": {"command": "npx", "args": ["offload-mcp"], "env": {"GOOGLE_AI_API_KEY": "your_key"}}}}` |
| **Windsurf** | Add to `~/.codeium/windsurf/mcp_config.json` with same JSON block |
| **Cline** | MCP Servers → Add → command: `npx offload-mcp`, env: `GOOGLE_AI_API_KEY` |
| **Codex** | Add to `codex.yaml` under `mcpServers` with same structure |

---

## Tools

### `offload`

Routes a task to Gemma 4 and returns the result.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task` | enum (see below) | Task type to offload |
| `content` | string | Content to process (diff, code, text, etc.) |

### `offload_status`

No parameters. Returns daily and monthly usage stats.

---

## Task Tiers

### Tier 1 — Always safe to offload

| Task | What it does |
|------|-------------|
| `commit_message` | Writes a conventional commit message from a diff |
| `pr_description` | Generates PR summary with bullets and file list |
| `code_summary` | Summarizes what a file or function does in 2-3 sentences |
| `translate` | Translates text (German ↔ English), preserving formatting |
| `changelog_entry` | Writes a changelog line per logical change in a diff |
| `naming_suggestion` | Suggests 3 names for a variable, function, or class |

### Tier 2 — Offload when content fits context

| Task | What it does |
|------|-------------|
| `classify` | Classifies text into requested categories |
| `extract_data` | Extracts structured data from unstructured text |
| `code_review_single` | Reviews a single function for bugs and improvements |
| `docstring` | Writes a docstring (summary, params, returns, throws) |
| `subject_lines` | Generates 5 email subject line variants under 60 chars |

### Never Offload

- Multi-file architecture decisions
- Security-sensitive code
- Tasks requiring your full project context
- Anything needing reasoning about the whole codebase

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `GOOGLE_AI_API_KEY` | — | **Required.** Free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `OFFLOAD_MODEL` | `gemma-4-31b-it` | Model to use via Google GenAI API |
| `OFFLOAD_RPD_LIMIT` | `1500` | Daily request limit (requests per day) |
| `OFFLOAD_LOG_PATH` | `~/.offload-mcp/usage.json` | Path for usage tracking data |

---

## Usage Tracking

The `offload_status` tool reports:

```
Today: 47/1500 calls (3.1%), 28,500 tokens offloaded
Month: 312 calls over 8 days (avg 39/day), 187,400 tokens offloaded
Tasks today:
  commit_message: 18
  docstring: 12
  code_summary: 9
```

- Warnings appended to responses at **50%, 75%, 90%** of daily limit
- Hard stop when daily limit is reached — falls back to primary AI
- Data stored in `~/.offload-mcp/usage.json`, 30-day retention, atomic writes

---

## How It Works

```
Your AI assistant
  → calls offload(task, content)
    → Gemma 4 API (Google AI Studio free tier)
      → result returned to your AI assistant
```

The MCP server runs locally via `npx offload-mcp`. Your AI decides when to offload based on the rules file. Results come back as plain text — no special handling needed.

---

## Why Not Local?

Local Ollama requires a GPU, significant RAM, and setup time. Free APIs work on any machine — including CI/CD environments, low-end laptops, and remote dev boxes — with no hardware requirements.

---

## Roadmap

**v0.2**
- Multiple providers: Groq, Mistral, Ollama (optional local fallback)
- Per-task provider routing
- Token cost estimation display

---

## Development

```bash
git clone https://github.com/peterhadorn/offload-mcp
cd offload-mcp
npm install
npm test
npm run build
```

Tests cover: task routing, prompt building, quota logic, usage tracking, and status output.

---

## License

MIT
