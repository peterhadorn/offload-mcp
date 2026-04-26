import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildPrompt, ALL_TASKS } from "../src/index.js";

// --- Router Tests ---

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

  it("ALL_TASKS has 11 task types", () => {
    expect(ALL_TASKS.size).toBe(11);
  });
});

// --- Tracker Tests ---

import { mkdirSync, existsSync, writeFileSync, rmSync } from "fs";
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

  async function loadTracker() {
    vi.resetModules();
    return await import("../src/index.js");
  }

  it("todayKey returns ISO date", async () => {
    const { todayKey } = await loadTracker();
    expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reserveCall + recordUsage tracks calls, tokens, and tasks", async () => {
    const { reserveCall, recordUsage, todayCalls, getStatus } = await loadTracker();
    expect(reserveCall()).toBe(true);
    recordUsage(500, "commit_message");
    expect(reserveCall()).toBe(true);
    recordUsage(300, "translate");

    expect(todayCalls()).toBe(2);
    const status = getStatus();
    expect(status).toContain("2/1500");
    expect(status).toContain("800 tokens offloaded");
    expect(status).toContain("commit_message: 1");
    expect(status).toContain("translate: 1");
  });

  it("reserveCall enforces quota and prevents concurrent bypass", async () => {
    vi.stubEnv("OFFLOAD_RPD_LIMIT", "3");
    const { reserveCall } = await loadTracker();
    expect(reserveCall()).toBe(true);
    expect(reserveCall()).toBe(true);
    expect(reserveCall()).toBe(true);
    expect(reserveCall()).toBe(false); // 4th call rejected
  });

  it("seedFromFile restores state across restarts", async () => {
    const mod1 = await loadTracker();
    mod1.reserveCall();
    mod1.recordUsage(500, "commit_message");
    mod1.reserveCall();
    mod1.recordUsage(300, "translate");

    // Simulate restart — fresh module load, same file
    const mod2 = await loadTracker();
    mod2.seedFromFile();
    expect(mod2.todayCalls()).toBe(2);
    const status = mod2.getStatus();
    expect(status).toContain("800 tokens offloaded");
    expect(status).toContain("commit_message: 1");
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

  it("handles corrupt usage file gracefully", async () => {
    writeFileSync(join(tmpDir, "usage.json"), "{broken json");
    const { loadUsage } = await loadTracker();
    expect(loadUsage()).toEqual({});
  });

  it("warnings fire at threshold", async () => {
    vi.stubEnv("OFFLOAD_RPD_LIMIT", "10");
    const { checkWarnings, reserveCall, recordUsage } = await loadTracker();
    for (let i = 0; i < 5; i++) { reserveCall(); recordUsage(1, "commit_message"); }
    const first = checkWarnings();
    expect(first.some((w: string) => w.includes("50%"))).toBe(true);
    expect(checkWarnings().some((w: string) => w.includes("50%"))).toBe(false);
  });

  it("quota enforced even when file I/O fails", async () => {
    vi.stubEnv("OFFLOAD_LOG_PATH", "/nonexistent/deeply/nested/path/usage.json");
    vi.stubEnv("OFFLOAD_RPD_LIMIT", "3");
    const mod = await loadTracker();
    expect(mod.reserveCall()).toBe(true);
    mod.recordUsage(100, "commit_message");
    expect(mod.reserveCall()).toBe(true);
    mod.recordUsage(100, "commit_message");
    expect(mod.reserveCall()).toBe(true);
    mod.recordUsage(100, "commit_message");
    expect(mod.reserveCall()).toBe(false); // enforced from memory
  });

  it("getStatus consistent when file I/O fails", async () => {
    vi.stubEnv("OFFLOAD_LOG_PATH", "/nonexistent/deeply/nested/path/usage.json");
    const mod = await loadTracker();
    mod.reserveCall();
    mod.recordUsage(500, "commit_message");
    const status = mod.getStatus();
    expect(status).toContain("1/1500");
    expect(status).toContain("500 tokens offloaded");
    expect(status).toContain("commit_message: 1");
  });

  it("recordUsage survives unwritable path", async () => {
    vi.stubEnv("OFFLOAD_LOG_PATH", "/nonexistent/deeply/nested/path/usage.json");
    const mod = await loadTracker();
    expect(() => mod.recordUsage(100, "commit_message")).not.toThrow();
  });

  it("pruneOldEntries skips write when no data exists", async () => {
    const { pruneOldEntries } = await loadTracker();
    pruneOldEntries();
    expect(existsSync(join(tmpDir, "usage.json"))).toBe(false);
  });
});
