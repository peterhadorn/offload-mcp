#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const PKG_VERSION: string = (() => {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// --- Config ---

const API_KEY = process.env.GOOGLE_AI_API_KEY ?? "";
const MODEL = process.env.OFFLOAD_MODEL ?? "gemma-4-31b-it";
const FALLBACK_MODELS = (process.env.OFFLOAD_FALLBACK_MODELS ?? "gemma-4-26b-a4b-it")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MODEL_CHAIN = [MODEL, ...FALLBACK_MODELS].filter((model, index, models) => models.indexOf(model) === index);
const RPD_LIMIT = (() => {
  const raw = parseInt(process.env.OFFLOAD_RPD_LIMIT ?? "14400", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 14400;
})();
const REQUEST_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.OFFLOAD_TIMEOUT_MS ?? "20000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();
const RETRIES_PER_MODEL = (() => {
  const raw = parseInt(process.env.OFFLOAD_RETRIES_PER_MODEL ?? "1", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
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
    "Translate the following text. Output ONLY the translation — no options, no commentary, no explanations, no introductions. " +
    "Preserve formatting, tone, named entities, and special characters. " +
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

const SOURCE_TYPES = new Set(["git_diff", "git_staged_diff", "file"]);

function loadSourceContent(source: string, path?: string, cwd?: string): string {
  const root = cwd ? resolve(cwd) : process.cwd();
  if (source === "git_diff") {
    return execFileSync("git", ["-C", root, "diff", "--no-ext-diff", "HEAD"], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }
  if (source === "git_staged_diff") {
    return execFileSync("git", ["-C", root, "diff", "--cached", "--no-ext-diff"], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }
  if (source === "file") {
    if (!path) throw new Error("source='file' requires a path parameter");
    return readFileSync(resolve(root, path), "utf-8");
  }
  throw new Error(`Unknown source: ${source}`);
}

// --- Model Client ---

const genaiClient = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

interface OffloadResponse {
  text: string;
  totalTokens: number;
  model: string;
}

function isRateLimited(err: any): boolean {
  return err?.status === 429 || err?.code === 429 || err?.httpStatusCode === 429;
}

function isTimeout(err: any): boolean {
  return (
    err?.name === "AbortError" ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "OFFLOAD_TIMEOUT" ||
    /timeout|timed out|aborted/i.test(err?.message ?? "")
  );
}

function isFallbackEligible(err: any): boolean {
  const status = err?.status ?? err?.code ?? err?.httpStatusCode;
  return isTimeout(err) || status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}

function redactSecrets(text: string): string {
  return text
    .replace(/key=[^&\s]+/gi, "key=REDACTED")
    .replace(/x-goog-api-key:\s*[^\s,]+/gi, "x-goog-api-key: REDACTED")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer REDACTED");
}

function formatModelError(model: string, err: any): string {
  return `${model}: ${redactSecrets(err?.message ?? String(err))}`;
}

async function generateWithModel(model: string, prompt: string): Promise<OffloadResponse> {
  if (!genaiClient) throw new Error("API key not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await genaiClient.models.generateContent({
      model,
      contents: prompt,
      config: {
        maxOutputTokens: 2000,
        temperature: 0.3,
        httpOptions: { timeout: REQUEST_TIMEOUT_MS },
        abortSignal: controller.signal,
      },
    });
    return {
      text: response.text ?? "",
      totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
      model,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callOffloadModel(prompt: string): Promise<OffloadResponse> {
  if (!genaiClient) throw new Error("API key not configured");
  const errors: string[] = [];

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < RETRIES_PER_MODEL; attempt++) {
      try {
        return await generateWithModel(model, prompt);
      } catch (err: any) {
        errors.push(formatModelError(model, err));
        const canRetrySameModel = attempt < RETRIES_PER_MODEL - 1;
        if (!isFallbackEligible(err)) {
          throw err;
        }
        if (canRetrySameModel) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    }
  }

  throw new Error(`All configured offload models failed. ${errors.join(" | ")}`);
}

// --- Quota Tracker ---
// In-memory DayBucket is the single authority for quota enforcement.
// File is best-effort persistence, seeded into memory on startup.
// Format: { "2026-04-26": { "calls": 47, "tokens": 28500, "savedTokens": 12000, "tasks": { "commit_message": 18 } } }

interface DayBucket {
  calls: number;
  tokens: number;
  savedTokens: number;
  tasks: Record<string, number>;
}

type UsageData = Record<string, DayBucket>;

let mem: DayBucket = { calls: 0, tokens: 0, savedTokens: 0, tasks: {} };
let memDay = "";
let warnedThresholds = new Set<number>();
let warnedDay = "";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureMemDay(): void {
  const today = todayKey();
  if (memDay !== today) {
    mem = { calls: 0, tokens: 0, savedTokens: 0, tasks: {} };
    memDay = today;
  }
}

function normalizeBucket(bucket: Partial<DayBucket>): DayBucket {
  return {
    calls: bucket.calls ?? 0,
    tokens: bucket.tokens ?? 0,
    savedTokens: bucket.savedTokens ?? 0,
    tasks: bucket.tasks ?? {},
  };
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

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Record tokens and task after a successful API call.
function recordUsage(tokens: number, task: string, savedTokens = 0): void {
  ensureMemDay();
  mem.tokens += tokens;
  mem.savedTokens += savedTokens;
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
      if (key >= cutoffKey) pruned[key] = normalizeBucket(val);
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
    const normalized = normalizeBucket(bucket);
    mem = { ...normalized, tasks: { ...normalized.tasks } };
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
    mSavedTokens = 0,
    mDays = 0;
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith(monthPrefix) && k !== memDay) {
      const bucket = normalizeBucket(v);
      mCalls += bucket.calls;
      mTokens += bucket.tokens;
      mSavedTokens += bucket.savedTokens;
      mDays++;
    }
  }
  // Add current day from memory (authoritative)
  mCalls += mem.calls;
  mTokens += mem.tokens;
  mSavedTokens += mem.savedTokens;
  if (mem.calls > 0) mDays++;
  const avgPerDay = mDays > 0 ? Math.round(mCalls / mDays) : 0;

  const lines = [
    `Today: ${mem.calls}/${RPD_LIMIT} calls (${pct}%), ${mem.tokens.toLocaleString()} model tokens processed`,
    `Month: ${mCalls} calls over ${mDays} days (avg ${avgPerDay}/day), ${mTokens.toLocaleString()} model tokens processed`,
    `Estimated primary input avoided: today ~${mem.savedTokens.toLocaleString()} tokens, month ~${mSavedTokens.toLocaleString()} tokens`,
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

const INSTRUCTIONS = `Use the \`offload\` tool to delegate routine text/code tasks to a configured lower-cost model. Use \`offload_source\` when the input already exists locally, such as git diffs or files, so the MCP server can fetch it without filling your own context.

MANDATORY — when offload-mcp is connected, do NOT write these yourself; always offload:
- Commit messages → prefer offload_source(task="commit_message", source="git_diff"); otherwise offload(task="commit_message", content=<diff>)
- PR descriptions → prefer offload_source(task="pr_description", source="git_diff"); otherwise offload(task="pr_description", content=<combined diff>)
- Code summaries → prefer offload_source(task="code_summary", source="file", path=<path>); otherwise offload(task="code_summary", content=<code>)
- Translation (any direction) → offload(task="translate", content=<text>)
- Changelog entries → prefer offload_source(task="changelog_entry", source="git_diff"); otherwise offload(task="changelog_entry", content=<diff>)
- Naming suggestions → offload(task="naming_suggestion", content=<description>)

Also offload when processing many items in a session: classify, extract_data, code_review_single, docstring, subject_lines.

Freeform (any other routine task):
- offload(task="freeform", content=<text>, prompt=<your instruction>)
- offload_source(task="freeform", source="file", path=<path>, prompt=<your instruction>)
- Good for: rewriting error messages, summarizing logs, formatting data, extracting action items, rephrasing, test names, regex.

CRITICAL — relaying offloaded results:
The offload/offload_source tool output IS your final answer. Relay it VERBATIM. Do NOT summarize, paraphrase, reformat, or wrap with commentary like "Here's the translation:" or "Done!". Pass the tool output through as-is. This includes preserving the "—— Offloaded via ..." footer at the bottom — that footer is the user's proof of offloading and processed-token counter. Stripping it defeats the entire purpose of this tool.

NEVER offload: multi-file code changes, architecture decisions, complex debugging, security-sensitive reviews, plan writing or execution, secrets, private customer data, proprietary code, regulated data, or anything requiring the offload model to call tools or inspect live project state beyond the provided source.

Quota: check \`offload_status\` if you see a quota warning. If quota is exceeded, handle tasks locally without mentioning the offload system.`;

const server = new McpServer(
  {
    name: "offload-mcp",
    version: PKG_VERSION,
  },
  { instructions: INSTRUCTIONS }
);

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

async function executeOffload(opts: {
  task: string;
  content: string;
  customPrompt?: string;
  savedTokens: number;
}): Promise<ToolResult> {
  const { task, content, customPrompt, savedTokens } = opts;

  if (!API_KEY) {
    return textResult("[ERROR] GOOGLE_AI_API_KEY not set. Get a free key at https://aistudio.google.com/apikey");
  }

  if (task === "freeform" && !customPrompt) {
    return textResult("[ERROR] task='freeform' requires a prompt parameter.");
  }

  if (!reserveCall()) {
    return textResult(`[QUOTA] Daily limit reached (${RPD_LIMIT} calls). Handle locally.`);
  }

  try {
    const prompt = buildPrompt(task, content, customPrompt);
    const response = await callOffloadModel(prompt);

    recordUsage(response.totalTokens, task, savedTokens);

    const warnings = checkWarnings();
    const avoidedClause =
      savedTokens > 0 ? ` · ~${savedTokens.toLocaleString()} primary input tokens avoided` : "";
    const footer = `—— Offloaded via ${response.model} · ${response.totalTokens} model tokens${avoidedClause} · [offload-mcp](https://github.com/peterhadorn/offload-mcp)`;
    let text = `${response.text}\n\n${footer}`;
    if (warnings.length > 0) {
      text += "\n\n" + warnings.map((w) => `[WARNING] ${w}`).join("\n");
    }

    return textResult(text);
  } catch (err: any) {
    releaseCall();
    const msg = redactSecrets(err?.message ?? String(err));
    return textResult(`[ERROR] Offload API call failed: ${msg}`);
  }
}

server.tool(
  "offload",
  "Offload a routine task to the configured Gemini API model. " +
    "Use for: commit messages, PR descriptions, code summaries, changelog entries, naming suggestions, " +
    "classification, data extraction, single-function code review, docstrings, email subject lines. " +
    "task='translate' handles explicit target-language hints in the content, including dialects. " +
    "For unusual translation constraints, use task='freeform' with a strict custom prompt. " +
    "Always add 'output only X, no commentary' constraints in freeform prompts to prevent verbose responses.",
  {
    task: z
      .enum([...ALL_TASKS] as [string, ...string[]])
      .describe("Task type to offload. Use 'freeform' with a custom prompt for unlisted tasks."),
    content: z.string().describe("Content to process (diff, code, text, etc.)"),
    prompt: z.string().optional().describe("Custom instruction for freeform tasks. Required when task='freeform', ignored otherwise."),
  },
  async ({ task, content, prompt: customPrompt }) => {
    return executeOffload({ task, content, customPrompt, savedTokens: 0 });
  }
);

server.tool(
  "offload_source",
  "Offload a routine task using local source content fetched by the MCP server. " +
    "This saves primary-agent input context for local diffs and files because the assistant passes a small source reference instead of the full text. " +
    "Sources: git_diff (working tree changes vs HEAD), git_staged_diff (staged changes), file (requires path). " +
    "Use only for non-sensitive content you are allowed to send to the configured Gemini API model.",
  {
    task: z
      .enum([...ALL_TASKS] as [string, ...string[]])
      .describe("Task type to offload. Use 'freeform' with a custom prompt for unlisted tasks."),
    source: z
      .enum([...SOURCE_TYPES] as [string, ...string[]])
      .describe("Local source to fetch: git_diff, git_staged_diff, or file."),
    path: z.string().optional().describe("File path, required when source='file'. Resolved relative to cwd or the MCP server process cwd."),
    cwd: z.string().optional().describe("Working directory for git commands and relative file paths. Defaults to the MCP server process cwd."),
    prompt: z.string().optional().describe("Custom instruction for freeform tasks. Required when task='freeform', ignored otherwise."),
  },
  async ({ task, source, path, cwd, prompt: customPrompt }) => {
    if (!API_KEY) {
      return textResult("[ERROR] GOOGLE_AI_API_KEY not set. Get a free key at https://aistudio.google.com/apikey");
    }

    let content: string;
    try {
      content = loadSourceContent(source, path, cwd);
    } catch (err: any) {
      return textResult(`[ERROR] Failed to load source: ${err?.message ?? String(err)}`);
    }

    if (content.trim().length === 0) {
      return textResult(`[ERROR] Source '${source}' is empty.`);
    }

    return executeOffload({ task, content, customPrompt, savedTokens: estimateTokens(content) });
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
  loadSourceContent, SOURCE_TYPES, estimateTokens, MODEL_CHAIN,
  reserveCall, releaseCall, recordUsage, loadUsage, saveUsage,
  seedFromFile, todayKey, todayCalls,
  checkWarnings, pruneOldEntries, getStatus,
};
