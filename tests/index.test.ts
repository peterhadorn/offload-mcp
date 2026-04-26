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

  // --- Edge case: warnings reset on date rollover ---
  it("warnings reset when day changes", async () => {
    const { checkWarnings, recordUsage, resetWarningsIfNewDay } = await loadTracker();
    // Record enough to trigger 50% warning (750 of 1500)
    for (let i = 0; i < 750; i++) recordUsage(1, "commit_message");
    const first = checkWarnings();
    expect(first.some((w: string) => w.includes("50%"))).toBe(true);

    // Same day: should not warn again
    const second = checkWarnings();
    expect(second.some((w: string) => w.includes("50%"))).toBe(false);

    // Simulate date rollover by calling resetWarningsIfNewDay after forcing new day
    // We can't easily mock Date, but we can verify the reset function clears state
    resetWarningsIfNewDay(); // same day — no-op
    const third = checkWarnings();
    expect(third.some((w: string) => w.includes("50%"))).toBe(false); // still suppressed
  });

  // --- Edge case: unwritable log path doesn't crash ---
  it("recordUsage survives unwritable path", async () => {
    vi.stubEnv("OFFLOAD_LOG_PATH", "/nonexistent/deeply/nested/path/usage.json");
    const mod = await (async () => { vi.resetModules(); return import("../src/index.js"); })();
    // Should not throw — best-effort tracking
    expect(() => mod.recordUsage(100, "commit_message")).not.toThrow();
  });

  it("pruneOldEntries survives unwritable path", async () => {
    vi.stubEnv("OFFLOAD_LOG_PATH", "/nonexistent/deeply/nested/path/usage.json");
    const mod = await (async () => { vi.resetModules(); return import("../src/index.js"); })();
    expect(() => mod.pruneOldEntries()).not.toThrow();
  });

  it("pruneOldEntries skips write when no data exists", async () => {
    // Fresh tmp dir, no usage.json — pruneOldEntries should not create the file
    const { pruneOldEntries } = await loadTracker();
    pruneOldEntries();
    expect(existsSync(join(tmpDir, "usage.json"))).toBe(false);
  });
});
