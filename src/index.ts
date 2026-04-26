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
const RPD_LIMIT_RAW = parseInt(process.env.OFFLOAD_RPD_LIMIT ?? "1500", 10);
const RPD_LIMIT = Number.isFinite(RPD_LIMIT_RAW) && RPD_LIMIT_RAW > 0 ? RPD_LIMIT_RAW : 1500;
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

let warnedThresholds = new Set<number>();
let warnedDay = "";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
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
    renameSync(tmp, LOG_PATH); // atomic on POSIX
  } catch {
    // Best-effort: tracking failure should not crash the server
  }
}

function recordUsage(tokens: number, task: string): void {
  try {
    const data = loadUsage();
    const key = todayKey();
    if (!data[key]) data[key] = { calls: 0, tokens: 0, tasks: {} };
    data[key].calls++;
    data[key].tokens += tokens;
    data[key].tasks[task] = (data[key].tasks[task] ?? 0) + 1;
    saveUsage(data);
  } catch {
    // Best-effort: tracking failure should not crash the server
  }
}

function todayCalls(): number {
  return loadUsage()[todayKey()]?.calls ?? 0;
}

function isExceeded(): boolean {
  return todayCalls() >= RPD_LIMIT;
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
    if (Object.keys(data).length === 0) return; // nothing to prune, skip write
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    const pruned: UsageData = {};
    for (const [key, val] of Object.entries(data)) {
      if (key >= cutoffKey) pruned[key] = val;
    }
    saveUsage(pruned);
  } catch {
    // Best-effort: pruning failure should not prevent server startup
  }
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
  isExceeded, checkWarnings, resetWarningsIfNewDay, pruneOldEntries, getStatus,
};
