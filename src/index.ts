#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// --- Config ---

const API_KEY = process.env.GOOGLE_AI_API_KEY ?? "";
const MODEL = process.env.OFFLOAD_MODEL ?? "gemma-4-31b-it";
const RPD_LIMIT = (() => {
  const raw = parseInt(process.env.OFFLOAD_RPD_LIMIT ?? "1500", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
})();
const LOG_PATH = process.env.OFFLOAD_LOG_PATH ?? join(homedir(), ".offload-mcp", "usage.json");

// --- Task Router ---

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
    "Translate the following text. Preserve formatting, tone, named entities, and special characters. " +
    "If the input includes a target language hint (e.g., 'to Mexican Spanish:', 'into French:', 'auf Deutsch:'), translate to that target. " +
    "Otherwise translate German↔English based on the source language.",
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

const ALL_TASKS = new Set([...Object.keys(PROMPTS), "freeform"]);

function buildPrompt(task: string, content: string, customPrompt?: string): string {
  if (task === "freeform") {
    if (!customPrompt) throw new Error("freeform task requires a prompt parameter");
    return `${customPrompt}\n\n---\n\n${content}`;
  }
  const system = PROMPTS[task];
  if (!system) throw new Error(`Unknown task: ${task}`);
  return `${system}\n\n---\n\n${content}`;
}

// --- Gemma Client ---

const genaiClient = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

interface OffloadResponse {
  text: string;
  totalTokens: number;
}

function isRateLimited(err: any): boolean {
  return err?.status === 429 || err?.code === 429 || err?.httpStatusCode === 429;
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
      if (isRateLimited(err) && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

// --- Quota Tracker ---
// In-memory DayBucket is the single authority for quota enforcement.
// File is best-effort persistence, seeded into memory on startup.
// Format: { "2026-04-26": { "calls": 47, "tokens": 28500, "tasks": { "commit_message": 18 } } }

interface DayBucket {
  calls: number;
  tokens: number;
  tasks: Record<string, number>;
}

type UsageData = Record<string, DayBucket>;

let mem: DayBucket = { calls: 0, tokens: 0, tasks: {} };
let memDay = "";
let warnedThresholds = new Set<number>();
let warnedDay = "";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureMemDay(): void {
  const today = todayKey();
  if (memDay !== today) {
    mem = { calls: 0, tokens: 0, tasks: {} };
    memDay = today;
  }
}

function resetWarningsIfNewDay(): void {
  const today = todayKey();
  if (warnedDay !== today) {
    warnedThresholds = new Set();
    warnedDay = today;
  }
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
  try {
    const dir = dirname(LOG_PATH);
    mkdirSync(dir, { recursive: true });
    const tmp = LOG_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, LOG_PATH);
  } catch {
    // Best-effort persistence
  }
}

function syncToFile(): void {
  try {
    const data = loadUsage();
    data[memDay] = { ...mem, tasks: { ...mem.tasks } };
    saveUsage(data);
  } catch {
    // Best-effort persistence
  }
}

// Reserve a call slot before the API request. Returns false if quota exceeded.
function reserveCall(): boolean {
  ensureMemDay();
  if (mem.calls >= RPD_LIMIT) return false;
  mem.calls++;
  return true;
}

// Release a previously reserved slot when the API call fails before billing.
function releaseCall(): void {
  ensureMemDay();
  if (mem.calls > 0) mem.calls--;
}

// Record tokens and task after a successful API call.
function recordUsage(tokens: number, task: string): void {
  ensureMemDay();
  mem.tokens += tokens;
  mem.tasks[task] = (mem.tasks[task] ?? 0) + 1;
  syncToFile();
}

function todayCalls(): number {
  ensureMemDay();
  return mem.calls;
}

function checkWarnings(): string[] {
  resetWarningsIfNewDay();
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
  try {
    const data = loadUsage();
    if (Object.keys(data).length === 0) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    const pruned: UsageData = {};
    for (const [key, val] of Object.entries(data)) {
      if (key >= cutoffKey) pruned[key] = val;
    }
    saveUsage(pruned);
  } catch {
    // Best-effort
  }
}

// Seed in-memory state from file on startup
function seedFromFile(): void {
  const data = loadUsage();
  const today = todayKey();
  const bucket = data[today];
  if (bucket) {
    mem = { calls: bucket.calls, tokens: bucket.tokens, tasks: { ...bucket.tasks } };
    memDay = today;
  }
}

function getStatus(): string {
  ensureMemDay();
  const pct = RPD_LIMIT > 0 ? ((mem.calls / RPD_LIMIT) * 100).toFixed(1) : "0";

  // Monthly aggregate from file + merge current day from memory
  const data = loadUsage();
  const monthPrefix = memDay.slice(0, 7);
  let mCalls = 0,
    mTokens = 0,
    mDays = 0;
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith(monthPrefix) && k !== memDay) {
      mCalls += v.calls;
      mTokens += v.tokens;
      mDays++;
    }
  }
  // Add current day from memory (authoritative)
  mCalls += mem.calls;
  mTokens += mem.tokens;
  if (mem.calls > 0) mDays++;
  const avgPerDay = mDays > 0 ? Math.round(mCalls / mDays) : 0;

  const lines = [
    `Today: ${mem.calls}/${RPD_LIMIT} calls (${pct}%), ${mem.tokens.toLocaleString()} tokens offloaded`,
    `Month: ${mCalls} calls over ${mDays} days (avg ${avgPerDay}/day), ${mTokens.toLocaleString()} tokens offloaded`,
  ];

  const tasks = Object.entries(mem.tasks).sort((a, b) => b[1] - a[1]);
  if (tasks.length > 0) {
    lines.push("Tasks today:");
    for (const [name, count] of tasks) {
      lines.push(`  ${name}: ${count}`);
    }
  }
  return lines.join("\n");
}

// --- MCP Server ---

const INSTRUCTIONS = `Use the \`offload\` tool to delegate routine text/code tasks to a free LLM (Gemma). Saves your context tokens and is faster than handling them yourself.

MANDATORY — when offload-mcp is connected, do NOT write these yourself; always offload:
- Commit messages → offload(task="commit_message", content=<diff>)
- PR descriptions → offload(task="pr_description", content=<combined diff>)
- Code summaries → offload(task="code_summary", content=<code>)
- Translation (any direction) → offload(task="translate", content=<text>)
- Changelog entries → offload(task="changelog_entry", content=<diff>)
- Naming suggestions → offload(task="naming_suggestion", content=<description>)

Also offload when processing many items in a session: classify, extract_data, code_review_single, docstring, subject_lines.

Freeform (any other routine task):
- offload(task="freeform", content=<text>, prompt=<your instruction>)
- Good for: rewriting error messages, summarizing logs, formatting data, extracting action items, rephrasing, test names, regex.

When relaying an offloaded result to the user, preserve the [offloaded via gemma-...] tag verbatim from the tool's response — it shows the user which tasks were offloaded and how many tokens were saved. Do not strip it, do not paraphrase it.

NEVER offload: multi-file code changes, architecture decisions, complex debugging, security-sensitive reviews, plan writing or execution, anything requiring tool calls or MCP access.

Quota: check \`offload_status\` if you see a quota warning. If quota is exceeded, handle tasks locally without mentioning the offload system.`;

const server = new McpServer(
  {
    name: "offload-mcp",
    version: "0.1.2",
  },
  { instructions: INSTRUCTIONS }
);

server.tool(
  "offload",
  "Offload a routine task to a free LLM API (Gemma). " +
    "Use for: commit messages, PR descriptions, code summaries, German↔English translations, " +
    "changelog entries, naming suggestions, classification, data extraction, " +
    "single-function code review, docstrings, email subject lines. " +
    "For translations to other languages (Spanish, French, Italian, etc.) or specific dialects " +
    "(Mexican Spanish, Brazilian Portuguese, etc.), use task='freeform' with a custom prompt. " +
    "Use task='freeform' with a custom prompt for anything else.",
  {
    task: z
      .enum([...ALL_TASKS] as [string, ...string[]])
      .describe("Task type to offload. Use 'freeform' with a custom prompt for unlisted tasks."),
    content: z.string().describe("Content to process (diff, code, text, etc.)"),
    prompt: z.string().optional().describe("Custom instruction for freeform tasks. Required when task='freeform', ignored otherwise."),
  },
  async ({ task, content, prompt: customPrompt }) => {
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

    if (task === "freeform" && !customPrompt) {
      return {
        content: [{ type: "text" as const, text: "[ERROR] task='freeform' requires a prompt parameter." }],
      };
    }

    if (!reserveCall()) {
      return {
        content: [{ type: "text" as const, text: `[QUOTA] Daily limit reached (${RPD_LIMIT} calls). Handle locally.` }],
      };
    }

    try {
      const prompt = buildPrompt(task, content, customPrompt);
      const response = await callGemma(prompt);

      recordUsage(response.totalTokens, task);

      const warnings = checkWarnings();
      const tag = `[offloaded via ${MODEL} · ${response.totalTokens} tokens]`;
      let text = `${tag}\n\n${response.text}`;
      if (warnings.length > 0) {
        text += "\n\n" + warnings.map((w) => `[WARNING] ${w}`).join("\n");
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      releaseCall();
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

  seedFromFile();
  pruneOldEntries();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

export {
  buildPrompt, ALL_TASKS,
  reserveCall, releaseCall, recordUsage, loadUsage, saveUsage,
  seedFromFile, todayKey, todayCalls,
  checkWarnings, pruneOldEntries, getStatus,
};
