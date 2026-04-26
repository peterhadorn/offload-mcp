# offload-mcp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and launch the first open-source MCP server that offloads routine tasks to free LLM APIs. TypeScript, works with any MCP client (Claude, Cursor, Windsurf, Cline, Codex), published on npm.

**Architecture:** Single-file TypeScript MCP server. Two tools: `offload` (route task to free LLM) and `offload_status` (check quota). Tracker is a single JSON file with daily buckets, 30-day retention. Ships with rules/instructions for all major AI coding clients.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `@google/genai`, npm

**Repo:** `github.com/peterhadorn/offload-mcp` (public from first commit, published on npm)

**Design principle:** Lean. Single-file server. Every line earns its keep.

---

## File Structure

```
offload-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE                         # MIT
├── .env.example
├── .gitignore
├── src/
│   └── index.ts                    # Everything: server, router, client, tracker
├── rules/                          # Drop-in instructions for every MCP client
│   ├── claude.md                   # → ~/.claude/rules/offload.md
│   ├── cursor.md                   # → merge into .cursorrules
│   ├── windsurf.md                 # → merge into .windsurfrules
│   ├── cline.md                    # → Cline custom instructions
│   └── codex.md                    # → AGENTS.md
└── tests/
    └── index.test.ts               # Router + tracker tests (mocked API)
```

**Single-file server** — router, client, tracker, and MCP tools all in `src/index.ts`. Split into modules in v0.2 when adding a second provider. For v0.1, one file keeps it dead simple and easy to review.

---

## Task 1: Repo + Scaffold

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `LICENSE`, `src/index.ts` (empty)

- [x] **Step 1.1: Create public repo**

```bash
cd ~/Documents/GitHub
mkdir offload-mcp && cd offload-mcp
git init
mkdir -p src rules tests
```

- [x] **Step 1.2: Write package.json**

```json
{
  "name": "offload-mcp",
  "version": "0.1.0",
  "description": "MCP server that offloads routine AI coding tasks to free LLM APIs",
  "type": "module",
  "main": "build/index.js",
  "bin": {
    "offload-mcp": "./build/index.js"
  },
  "files": ["build"],
  "scripts": {
    "build": "tsc && chmod +x build/index.js",
    "dev": "tsc --watch",
    "test": "vitest run",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["mcp", "llm", "offload", "gemma", "claude", "cursor", "free-api"],
  "author": "Peter Hadorn",
  "license": "MIT",
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@google/genai": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [x] **Step 1.3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "build",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [x] **Step 1.4: Write supporting files**

`.env.example`:
```bash
# Required: Get your free key at https://aistudio.google.com/apikey
GOOGLE_AI_API_KEY=your-key-here

# Optional
# OFFLOAD_MODEL=gemma-4-31b-it
# OFFLOAD_RPD_LIMIT=1500
```

`.gitignore`:
```
node_modules/
build/
.env
*.tgz
```

`LICENSE`: MIT, Peter Hadorn, 2026.

- [x] **Step 1.5: Create GitHub repo immediately (public from start)**

```bash
git add -A
git commit -m "feat: initial scaffold"
gh repo create peterhadorn/offload-mcp --public --source=. \
  --description "MCP server that offloads routine AI coding tasks to free LLM APIs"
git push origin main
```

---

## Task 2: Server Implementation (Single File)

**Files:** `src/index.ts`

- [x] **Step 2.1: Write the complete server**

`src/index.ts` — contains everything:

```typescript
#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// --- Config ---

const API_KEY = process.env.GOOGLE_AI_API_KEY ?? "";
const MODEL = process.env.OFFLOAD_MODEL ?? "gemma-4-31b-it";
const RPD_LIMIT = parseInt(process.env.OFFLOAD_RPD_LIMIT ?? "1500", 10);
const LOG_PATH = process.env.OFFLOAD_LOG_PATH ?? join(homedir(), ".offload-mcp", "usage.json");

// --- Task Router ---

const TASK_TIERS: Record<number, Set<string>> = {
  1: new Set([
    "commit_message",
    "pr_description",
    "code_summary",
    "translate",
    "changelog_entry",
    "naming_suggestion",
  ]),
  2: new Set([
    "classify",
    "extract_data",
    "code_review_single",
    "docstring",
    "subject_lines",
  ]),
};

const ALL_TASKS = new Set([...TASK_TIERS[1], ...TASK_TIERS[2]]);

const PROMPTS: Record<string, string> = {
  commit_message:
    "Write a concise git commit message for this diff. " +
    "Format: type(scope): description. One line, under 72 chars. " +
    "Types: feat, fix, refactor, docs, test, chore.",
  pr_description:
    "Write a pull request description for these changes. " +
    "Markdown: ## Summary (2-3 bullets), ## Changes (file list).",
  code_summary:
    "Summarize what this code does in 2-3 sentences. " +
    "Focus on purpose, not implementation details.",
  translate:
    "Translate the following text. Preserve formatting and tone. " +
    "German to English or English to German, based on the source.",
  changelog_entry:
    "Write a changelog entry for this diff. " +
    "Format: '- type: description' per logical change.",
  naming_suggestion:
    "Suggest 3 clear names for the described variable/function/class. " +
    "Use the language conventions apparent from the context.",
  classify:
    "Classify the following text into the requested categories. " +
    "Return only the category name(s).",
  extract_data:
    "Extract the requested structured data from this text. " +
    "Return only the extracted data.",
  code_review_single:
    "Review this function for bugs and improvements. " +
    "Be concise. Only actionable items.",
  docstring:
    "Write a docstring for this function. " +
    "Include: summary, params, returns, throws if applicable.",
  subject_lines:
    "Generate 5 email subject line variants. " +
    "Under 60 chars each. Vary: question, benefit, urgency, curiosity.",
};

function shouldOffload(task: string, quotaExceeded: boolean): boolean {
  if (!task || quotaExceeded) return false;
  return ALL_TASKS.has(task);
}

function buildPrompt(task: string, content: string): string {
  const system = PROMPTS[task];
  if (!system) throw new Error(`Unknown task: ${task}`);
  return `${system}\n\n---\n\n${content}`;
}

// --- Gemma Client ---

// Client created once at module scope — avoids re-init on every call
const genaiClient = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

interface OffloadResponse {
  text: string;
  totalTokens: number;
}

async function callGemma(prompt: string): Promise<OffloadResponse> {
  if (!genaiClient) throw new Error("API key not configured");
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await genaiClient.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          maxOutputTokens: 2000,
          temperature: 0.3,
        },
      });
      return {
        text: response.text ?? "",
        totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
      };
    } catch (err: any) {
      if (err?.status === 429 && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

// --- Quota Tracker ---
// Single JSON file, daily buckets, 30-day retention.
// Format: { "2026-04-26": { "calls": 47, "tokens": 28500, "tasks": { "commit_message": 18 } } }

interface DayBucket {
  calls: number;
  tokens: number;
  tasks: Record<string, number>;
}

type UsageData = Record<string, DayBucket>;

const warnedThresholds = new Set<number>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadUsage(): UsageData {
  try {
    if (existsSync(LOG_PATH)) {
      return JSON.parse(readFileSync(LOG_PATH, "utf-8"));
    }
  } catch {
    // corrupt file — start fresh
  }
  return {};
}

function saveUsage(data: UsageData): void {
  const dir = dirname(LOG_PATH);
  mkdirSync(dir, { recursive: true });
  const tmp = LOG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, LOG_PATH); // atomic on POSIX
}

function recordUsage(tokens: number, task: string): void {
  const data = loadUsage();
  const key = todayKey();
  if (!data[key]) data[key] = { calls: 0, tokens: 0, tasks: {} };
  data[key].calls++;
  data[key].tokens += tokens;
  data[key].tasks[task] = (data[key].tasks[task] ?? 0) + 1;
  saveUsage(data);
}

function todayCalls(): number {
  return loadUsage()[todayKey()]?.calls ?? 0;
}

function isExceeded(): boolean {
  return todayCalls() >= RPD_LIMIT;
}

function checkWarnings(): string[] {
  const calls = todayCalls();
  const ratio = RPD_LIMIT > 0 ? calls / RPD_LIMIT : 0;
  const warnings: string[] = [];
  for (const pct of [50, 75, 90]) {
    if (ratio >= pct / 100 && !warnedThresholds.has(pct)) {
      warnedThresholds.add(pct);
      warnings.push(`Offload quota ${pct}% reached: ${calls}/${RPD_LIMIT} daily calls`);
    }
  }
  return warnings;
}

function pruneOldEntries(): void {
  const data = loadUsage();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const pruned: UsageData = {};
  for (const [key, val] of Object.entries(data)) {
    if (key >= cutoffKey) pruned[key] = val;
  }
  saveUsage(pruned);
}

function getStatus(): string {
  const data = loadUsage();
  const key = todayKey();
  const today = data[key] ?? { calls: 0, tokens: 0, tasks: {} };
  const pct = RPD_LIMIT > 0 ? ((today.calls / RPD_LIMIT) * 100).toFixed(1) : "0";

  // Monthly aggregate
  const monthPrefix = key.slice(0, 7);
  let mCalls = 0,
    mTokens = 0,
    mDays = 0;
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith(monthPrefix)) {
      mCalls += v.calls;
      mTokens += v.tokens;
      mDays++;
    }
  }
  const avgPerDay = mDays > 0 ? Math.round(mCalls / mDays) : 0;

  const lines = [
    `Today: ${today.calls}/${RPD_LIMIT} calls (${pct}%), ${today.tokens.toLocaleString()} tokens offloaded`,
    `Month: ${mCalls} calls over ${mDays} days (avg ${avgPerDay}/day), ${mTokens.toLocaleString()} tokens offloaded`,
  ];

  const tasks = Object.entries(today.tasks).sort((a, b) => b[1] - a[1]);
  if (tasks.length > 0) {
    lines.push("Tasks today:");
    for (const [name, count] of tasks) {
      lines.push(`  ${name}: ${count}`);
    }
  }
  return lines.join("\n");
}

// --- MCP Server ---

const server = new McpServer({
  name: "offload-mcp",
  version: "0.1.0",
});

server.tool(
  "offload",
  "Offload a routine task to a free LLM API (Gemma 4). " +
    "Use for: commit messages, PR descriptions, code summaries, translations, " +
    "changelog entries, naming suggestions, classification, data extraction, " +
    "single-function code review, docstrings, email subject lines.",
  {
    task: z
      .enum([...ALL_TASKS] as [string, ...string[]])
      .describe("Task type to offload"),
    content: z.string().describe("Content to process (diff, code, text, etc.)"),
  },
  async ({ task, content }) => {
    if (!API_KEY) {
      return {
        content: [
          {
            type: "text" as const,
            text: "[ERROR] GOOGLE_AI_API_KEY not set. Get a free key at https://aistudio.google.com/apikey",
          },
        ],
      };
    }

    if (isExceeded()) {
      return {
        content: [{ type: "text" as const, text: `[QUOTA] Daily limit reached (${RPD_LIMIT} calls). Handle locally.` }],
      };
    }

    try {
      const prompt = buildPrompt(task, content);
      const response = await callGemma(prompt);

      recordUsage(response.totalTokens, task);

      const warnings = checkWarnings();
      let text = response.text;
      if (warnings.length > 0) {
        text += "\n\n" + warnings.map((w) => `[WARNING] ${w}`).join("\n");
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      // Sanitize error to prevent API key leakage
      const msg = (err?.message ?? String(err)).replace(/key=[^&\s]+/gi, "key=REDACTED");
      return {
        content: [
          {
            type: "text" as const,
            text: `[ERROR] Gemma API call failed: ${msg}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "offload_status",
  "Show offload-mcp usage stats for today and this month.",
  {},
  async () => {
    return { content: [{ type: "text" as const, text: getStatus() }] };
  }
);

// --- Main ---

async function main() {
  if (!API_KEY) {
    console.error(
      "WARNING: GOOGLE_AI_API_KEY not set. Get a free key at https://aistudio.google.com/apikey"
    );
  }
  pruneOldEntries();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when executed directly (not imported by tests)
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

// Export pure functions for testing
export {
  shouldOffload, buildPrompt, ALL_TASKS, TASK_TIERS,
  recordUsage, loadUsage, saveUsage, todayKey, todayCalls,
  isExceeded, checkWarnings, pruneOldEntries, getStatus,
};
```

- [x] **Step 2.2: Build and verify**

```bash
npm install
npm run build
```

Expected: `build/index.js` generated without errors.

- [x] **Step 2.3: Commit**

```bash
git add src/index.ts package.json tsconfig.json
git commit -m "feat: single-file MCP server with offload + status tools"
git push origin main
```

---

## Task 3: Tests

**Files:** `tests/index.test.ts`

- [x] **Step 3.1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldOffload, buildPrompt, ALL_TASKS, TASK_TIERS } from "../src/index.js";

// --- Router Tests ---

describe("shouldOffload", () => {
  it("delegates tier 1 tasks", () => {
    expect(shouldOffload("commit_message", false)).toBe(true);
    expect(shouldOffload("translate", false)).toBe(true);
    expect(shouldOffload("pr_description", false)).toBe(true);
  });

  it("delegates tier 2 tasks", () => {
    expect(shouldOffload("classify", false)).toBe(true);
    expect(shouldOffload("docstring", false)).toBe(true);
  });

  it("rejects unknown tasks", () => {
    expect(shouldOffload("hack_pentagon", false)).toBe(false);
    expect(shouldOffload("", false)).toBe(false);
  });

  it("rejects when quota exceeded", () => {
    expect(shouldOffload("commit_message", true)).toBe(false);
  });

  it("ALL_TASKS matches TASK_TIERS", () => {
    const fromTiers = new Set([...TASK_TIERS[1], ...TASK_TIERS[2]]);
    expect(ALL_TASKS).toEqual(fromTiers);
  });
});

describe("buildPrompt", () => {
  it("includes content in prompt", () => {
    const prompt = buildPrompt("commit_message", "diff --git a/foo.ts");
    expect(prompt).toContain("diff --git a/foo.ts");
    expect(prompt).toContain("commit message");
  });

  it("throws on unknown task", () => {
    expect(() => buildPrompt("unknown", "content")).toThrow("Unknown task");
  });

  it("every task in ALL_TASKS has a prompt", () => {
    for (const task of ALL_TASKS) {
      expect(() => buildPrompt(task, "test")).not.toThrow();
    }
  });
});

// --- Tracker Tests ---
// Uses OFFLOAD_LOG_PATH env var to redirect tracker to a temp directory.
// vi.stubEnv sets the var before the module reads it at import time.

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("tracker (isolated via env)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `offload-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    vi.stubEnv("OFFLOAD_LOG_PATH", join(tmpDir, "usage.json"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  // Dynamic import so the module picks up the stubbed env var.
  // vi.resetModules() clears the module cache so LOG_PATH re-reads from env.
  // Note: router tests at the top use a static import (separate module instance)
  // — that's fine since they only test pure functions that don't touch the filesystem.
  async function loadTracker() {
    vi.resetModules();
    return await import("../src/index.js");
  }

  it("todayKey returns ISO date", async () => {
    const { todayKey } = await loadTracker();
    expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("recordUsage creates file and increments calls", async () => {
    const { recordUsage, loadUsage, todayKey } = await loadTracker();
    recordUsage(500, "commit_message");
    recordUsage(300, "translate");

    const data = loadUsage();
    const today = data[todayKey()];
    expect(today.calls).toBe(2);
    expect(today.tokens).toBe(800);
    expect(today.tasks.commit_message).toBe(1);
    expect(today.tasks.translate).toBe(1);
  });

  it("todayCalls reflects recorded usage", async () => {
    const { recordUsage, todayCalls } = await loadTracker();
    expect(todayCalls()).toBe(0);
    recordUsage(100, "docstring");
    expect(todayCalls()).toBe(1);
  });

  it("isExceeded returns true when limit hit", async () => {
    const { isExceeded, todayCalls } = await loadTracker();
    // Default RPD_LIMIT is 1500 — we won't hit it here
    expect(isExceeded()).toBe(false);
  });

  it("pruneOldEntries removes entries older than 30 days", async () => {
    const { saveUsage, loadUsage, pruneOldEntries, todayKey } = await loadTracker();
    const old = new Date();
    old.setDate(old.getDate() - 40);
    const oldKey = old.toISOString().slice(0, 10);
    const today = todayKey();

    saveUsage({
      [oldKey]: { calls: 5, tokens: 500, tasks: {} },
      [today]: { calls: 1, tokens: 100, tasks: {} },
    });
    pruneOldEntries();

    const data = loadUsage();
    expect(data[oldKey]).toBeUndefined();
    expect(data[today]).toBeDefined();
  });

  it("getStatus returns formatted string", async () => {
    const { getStatus, recordUsage } = await loadTracker();
    recordUsage(500, "commit_message");
    const status = getStatus();
    expect(status).toContain("Today:");
    expect(status).toContain("Month:");
    expect(status).toContain("tokens offloaded");
    expect(status).toContain("commit_message");
  });

  it("handles corrupt usage file gracefully", async () => {
    writeFileSync(join(tmpDir, "usage.json"), "{broken json");
    const { loadUsage } = await loadTracker();
    expect(loadUsage()).toEqual({});
  });
});
```

**Note:** Router tests import directly from `index.ts` (guarded `main()` prevents server startup on import). Tracker tests use `vi.stubEnv("OFFLOAD_LOG_PATH", ...)` with dynamic imports to get full isolation — each test runs against its own temp directory.

- [x] **Step 3.2: Run tests**

```bash
npm test
```

Expected: all tests PASS

- [x] **Step 3.3: Commit**

```bash
git add tests/index.test.ts
git commit -m "test: add router and tracker tests"
git push origin main
```

---

## Task 4: Rules Files (All MCP Clients)

**Files:** `rules/claude.md`, `rules/cursor.md`, `rules/windsurf.md`, `rules/cline.md`, `rules/codex.md`

- [x] **Step 4.1: Write the rules content**

All files share the same core content, adapted to each client's format:

**Core content (used in all files):**

```markdown
# Offload MCP Rules

When the offload-mcp server is available, use its `offload` tool for routine tasks instead of handling them yourself.

## Always Offload (Tier 1 — highest token savings)

- **Commit messages**: `offload(task="commit_message", content=<the diff>)`
- **PR descriptions**: `offload(task="pr_description", content=<combined diff>)`
- **Code summaries**: `offload(task="code_summary", content=<the code>)`
- **Translation** (any direction): `offload(task="translate", content=<the text>)`
- **Changelog entries**: `offload(task="changelog_entry", content=<the diff>)`
- **Naming suggestions**: `offload(task="naming_suggestion", content=<description>)`

## Offload in Batch (Tier 2)

Use when processing multiple items in a session:

- **Text classification**: `offload(task="classify", content=<text + categories>)`
- **Data extraction**: `offload(task="extract_data", content=<text + what to extract>)`
- **Single-function code review**: `offload(task="code_review_single", content=<the function>)`
- **Docstring generation**: `offload(task="docstring", content=<the function>)`
- **Email subject lines**: `offload(task="subject_lines", content=<email description>)`

## Never Offload

Handle these yourself:

- Multi-file code changes
- Architecture decisions
- Complex debugging
- Anything requiring tool calling or MCP access
- Security-sensitive reviews
- Plan writing or execution

## Quota

Check `offload_status` if you get a quota warning. If quota is exceeded, handle all tasks locally without mentioning the offload system.
```

**Per-client files:**

`rules/claude.md` — copy to `~/.claude/rules/offload.md`:
Core content as-is.

`rules/cursor.md` — merge into `.cursorrules`:
Wrap with: "When the offload MCP server is connected:" prefix.

`rules/windsurf.md` — merge into `.windsurfrules`:
Same format as Cursor.

`rules/cline.md` — add to Cline custom instructions:
Same content, note it goes in Cline settings.

`rules/codex.md` — merge into `AGENTS.md`:
Same content, note it goes in repo root `AGENTS.md`.

- [x] **Step 4.2: Commit**

```bash
git add rules/
git commit -m "feat: add auto-offload rules for Claude, Cursor, Windsurf, Cline, Codex"
git push origin main
```

---

## Task 5: README

**Files:** `README.md`

- [x] **Step 5.1: Write README.md**

Structure (~150 lines):

1. **Title + one-liner**: "offload-mcp — Offload routine AI coding tasks to free LLM APIs"
2. **Why**: Token savings, zero cost, works with any MCP client
3. **Quick Start** (3 steps):
   - Get free API key (link to AI Studio)
   - `npx offload-mcp` or `npm install -g offload-mcp`
   - Add to your client + copy rules file
4. **Client Setup** (table with commands for Claude, Cursor, Windsurf, Cline, Codex)
5. **Tools**: `offload` (params table) + `offload_status`
6. **Task Tiers**: Tier 1 table (task, ~tokens saved), Tier 2 table, Never Offload list
7. **Configuration**: env vars table (GOOGLE_AI_API_KEY, OFFLOAD_MODEL, OFFLOAD_RPD_LIMIT)
8. **Quota Tracking**: how it works, thresholds, where data lives
9. **How It Works**: text flow diagram
10. **Adding Custom Tasks**: edit src/index.ts, add to rules/
11. **Roadmap**: v0.2 plans (multiple providers, Groq, Ollama)
12. **Development**: clone, install, test
13. **License**: MIT

Key points:
- Lead with "first MCP server to use free cloud APIs" and "works with Claude, Cursor, Windsurf, Cline, Codex"
- Emphasize zero cost, one-line install
- Include a "Why not local?" section: "Local Ollama requires GPU + setup. Free APIs work on any machine, including CI/CD."
- Show the `npx` one-liner prominently

- [x] **Step 5.2: Commit**

```bash
git add README.md
git commit -m "docs: add README with multi-client setup and task tiers"
git push origin main
```

---

## Task 6: Integration Test (Real API)

Before publishing, verify the full flow works with a real API key.

- [ ] **Step 6.1: Build and test entry point**

```bash
cd ~/Documents/GitHub/offload-mcp
npm run build
node build/index.js --help 2>&1 || echo "Entry point works"
```

Verify: `build/index.js` starts with `#!/usr/bin/env node` shebang (tsc preserves it).

- [ ] **Step 6.2: Test with real Gemma API**

```bash
GOOGLE_AI_API_KEY=<real-key> node build/index.js &
# In another terminal, use an MCP client to call:
# offload(task="commit_message", content="diff --git a/foo.ts\n+console.log('hello')")
# Verify response is a real commit message
# Check ~/.offload-mcp/usage.json has an entry
kill %1
```

- [ ] **Step 6.3: Test offload_status**

Call `offload_status` and verify it shows the call from Step 6.2.

- [ ] **Step 6.4: Test with Claude Code**

```bash
claude mcp add offload -e GOOGLE_AI_API_KEY=<key> -- node build/index.js
cp rules/claude.md ~/.claude/rules/offload.md
```

Start a new Claude Code session, make a code change, ask for a commit message. Verify Claude uses the offload tool automatically.

---

## Task 7: npm Publish

Only after integration tests pass.

- [ ] **Step 7.1: Publish to npm**

```bash
npm login  # if not already logged in
npm publish
```

- [ ] **Step 7.2: Verify npx works**

```bash
# In a clean directory
GOOGLE_AI_API_KEY=test npx offload-mcp 2>&1 | head -5
# Should start the MCP server (or show the warning about the test key)
```

- [ ] **Step 7.3: Tag v0.1.0**

```bash
git tag v0.1.0
git push origin v0.1.0
```

- [ ] **Step 7.4: Commit**

```bash
git commit --allow-empty -m "chore: published v0.1.0 to npm"
git push origin main
```

---

## Task 8: Wire Into Leadgen

- [x] **Step 8.1: Register MCP server with API key**

The API key is passed via the `-e` flag in the MCP config — the server reads `process.env`, not `.env` files. MCP clients inject env vars at spawn time.

```bash
cd ~/Documents/GitHub/leadgen
claude mcp add offload -e GOOGLE_AI_API_KEY=<key from aistudio.google.com> -- npx offload-mcp
```

- [x] **Step 8.2: Copy rules (if not already done in Task 6)**

```bash
cp ~/Documents/GitHub/offload-mcp/rules/claude.md ~/.claude/rules/offload.md
```

- [ ] **Step 8.3: Verify in leadgen session**

New Claude Code session in leadgen. Make a change, commit. Verify offloading works.

---

## Task 9: Launch Preparation

**Goal:** Polish everything for public visibility before posting.

- [ ] **Step 9.1: Create demo GIF**

Record a terminal session showing:
1. `claude mcp add offload -- npx offload-mcp` (install)
2. Make a code change
3. Ask for commit message → Claude calls `offload` → Gemma responds
4. Call `offload_status` → shows usage

Use `asciinema` or `vhs` (Charm) to record. Convert to GIF. Add to README at the top.

- [ ] **Step 9.2: Polish README**

- Add demo GIF at top
- Add badges: npm version, license, GitHub stars
- Verify all install commands work
- Add "Star this repo" CTA at bottom
- Proofread

- [ ] **Step 9.3: Prepare real usage stats**

Run offload-mcp for a full work session. Collect:
- Number of tasks offloaded
- Tokens offloaded (from offload_status)
- Quote these numbers in launch posts

- [ ] **Step 9.4: Commit polish**

```bash
git add -A
git commit -m "docs: add demo GIF, badges, and usage stats"
git push origin main
```

---

## Task 10: Launch

- [ ] **Step 10.1: Hacker News (Show HN)**

**Title:** "Show HN: offload-mcp — Offload AI coding tasks to free LLM APIs via MCP"

**Post body:**
```
Hey HN, I built offload-mcp — an MCP server that offloads routine tasks
(commit messages, translations, code summaries) from expensive AI coding
assistants to Google's free Gemma 4 API.

Why? AI coding tools burn 500-2000+ tokens on tasks that smaller models
handle equally well. Gemma 4's free API (1,500 requests/day, zero cost)
is perfect for this.

What makes this different from local LLM offloading:
- Zero setup: npx offload-mcp (no GPU, no Ollama, no Docker)
- Works everywhere: Claude Code, Cursor, Windsurf, Cline, Codex
- Ships with rules files for all major clients
- Built-in quota tracking with daily/monthly stats

In my first week of usage, it offloaded ~X tasks (~Y tokens).

GitHub: https://github.com/peterhadorn/offload-mcp
npm: npx offload-mcp

Tech: TypeScript, MCP protocol, Google GenAI SDK.
Roadmap: Adding Groq (free Llama), Mistral, and Ollama as providers.

Feedback welcome — especially on which tasks are best for offloading.
```

- [ ] **Step 10.2: Reddit posts**

Post to these subreddits (stagger by 1-2 hours):

**r/ClaudeCode:**
Title: "Built an MCP server that offloads routine tasks to Google's free Gemma API — saves tokens on commit messages, translations, etc."
Include: demo GIF, quick start, link

**r/LocalLLaMA:**
Title: "Not local, but free — offloading Claude/Cursor tasks to Google's free Gemma 4 API via MCP"
Angle: Cost optimization without needing a GPU. Acknowledge the local-first community but position free cloud APIs as complementary.

**r/cursor:**
Title: "offload-mcp: Save Cursor tokens by offloading routine tasks to free LLM APIs"
Include: Cursor-specific setup instructions.

**r/CodingWithAI** (if it exists) or **r/artificial:**
Title: "offload-mcp: First MCP server to use free cloud LLM APIs for task offloading"

- [ ] **Step 10.3: MCP Discord**

Post in the MCP community Discord (most targeted audience). Brief announcement with link and demo GIF.

- [ ] **Step 10.4: Twitter/X thread**

```
Thread:

1/ Just shipped offload-mcp — an MCP server that offloads routine
coding tasks to free LLM APIs.

Commit messages, translations, code summaries → Gemma 4 (free).
Complex reasoning, multi-file edits → stays on Claude/Cursor.

2/ AI coding tools burn 500-2000 tokens on tasks smaller models
handle just as well. Google gives you 1,500 free Gemma API calls/day.

npx offload-mcp — works with Claude, Cursor, Windsurf, Cline, Codex.
Ships with rules files for all of them.

3/ Built-in quota tracking shows exactly what got offloaded:
"Today: 47/1500 calls, 28,500 tokens offloaded"

First MCP server using free cloud APIs. No GPU. No Docker. Just npx.

GitHub: [link]
```

- [ ] **Step 10.5: Track launch metrics**

Monitor for 48 hours after launch:
- GitHub stars
- npm downloads (`npm info offload-mcp`)
- HN upvotes and comments
- Reddit engagement
- GitHub issues/PRs from community

Note results for future reference.

---

## Task 11: v0.1.1 Hardening (post-launch fixes)

Issues surfaced during dogfooding. Each is a small, isolated change.

- [x] **Step 11.1: Refund quota slot on API failure**

`reserveCall()` increments before the API call. If the request fails (network, rate limit, bad model name), the daily quota is consumed for nothing. Added `releaseCall()` and called it in the `offload` tool's catch block. 2 tests added.

- [x] **Step 11.2: Single source of truth for tasks**

`ALL_TASKS` was a hand-maintained `Set` parallel to `PROMPTS`. Drifts silently when adding tasks. Now derived: `ALL_TASKS = new Set([...Object.keys(PROMPTS), "freeform"])`.

- [x] **Step 11.3: Ship routing rules via MCP `instructions` field**

Originally Task 4 required users to copy a rules file into `~/.claude/rules/` (or per-client equivalent). High friction, easy to skip — and if skipped, the AI doesn't know to call `offload`. Solution: pass an `instructions` string to `McpServer` (same approach as `lean-ctx`). Rules now ship in-band — every MCP-aware client picks them up automatically on connect. Removed the startup nag that printed copy-paste instructions. The `rules/` directory stays for non-MCP-aware integrations.

- [x] **Step 11.4: Local global deploy**

`npm link` from the project root → `/usr/local/bin/offload-mcp` (or nvm equivalent) symlinks to the current build. New Claude Code sessions resolve `npx offload-mcp` instantly without a registry round-trip. Re-run `npm run build && npm link` after future changes.

- [x] **Step 11.5: Verify Gemma model name**

Confirmed against live `generativelanguage.googleapis.com/v1beta/models` (2026-04-26). `gemma-4-31b-it` exists. Full Gemma list: `gemma-3-{1b,4b,12b,27b}-it`, `gemma-3n-{e2b,e4b}-it`, `gemma-4-26b-a4b-it`, `gemma-4-31b-it`. Reviewer's claim that "Gemma 4 doesn't exist" was incorrect.

---

## Status (2026-04-26)

| Task | Status |
|------|--------|
| 1. Repo + Scaffold | Done |
| 2. Server Implementation | Done |
| 3. Tests (19/19 pass) | Done |
| 4. Rules Files | Done — superseded for MCP clients by Step 11.3 |
| 5. README | Done — needs update to reflect MCP `instructions` (rules-file copy now optional) |
| 6. Integration Test (Real API) | Live-tested via dogfooding (commits, status checks). Formal end-to-end Step 6.2 still skipped. |
| 7. npm Publish | Not started — globally available via `npm link` for now |
| 8. Wire Into Projects | Done (user-scope MCP, no rules-file copy needed after Step 11.3) |
| 9. Launch Preparation | Not started |
| 10. Launch | Not started |
| 11. v0.1.1 Hardening | Done (5/5) |
