import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { runCommand } from "../src/index.js";

async function fileText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function killPid(pid: string | null) {
  if (!pid) return;
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn("taskkill", ["/pid", pid, "/t", "/f"], { stdio: "ignore", windowsHide: true })
        : spawn("kill", ["-TERM", pid], { stdio: "ignore" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

async function waitForFileText(file: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await fileText(file);
    if (text.trim()) return text;
    await delay(25);
  }
  return fileText(file);
}

async function rmTempDir(dir: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err?.code !== "EBUSY" && err?.code !== "ENOTEMPTY") throw err;
      await delay(100);
    }
  }
  await rm(dir, { recursive: true, force: true });
}

describe("runCommand process cleanup", () => {
  async function writeProcessTreeFixture(tempDir: string, options: { detachedChild?: boolean } = {}) {
    const childPath = path.join(tempDir, "child.cjs");
    const parentPath = path.join(tempDir, "parent.cjs");
    const markerPath = path.join(tempDir, "ticks.txt");
    const pidPath = path.join(tempDir, "child.pid");

    await writeFile(
      childPath,
      `
const fs = require("node:fs");
const markerPath = process.argv[2];
const pidPath = process.argv[3];
fs.writeFileSync(pidPath, String(process.pid));
setInterval(() => {
  fs.appendFileSync(markerPath, "tick\\n");
}, 50);
`,
    );
    await writeFile(
      parentPath,
      `
const { spawn } = require("node:child_process");
const childPath = process.argv[2];
const markerPath = process.argv[3];
const pidPath = process.argv[4];
spawn(process.execPath, [childPath, markerPath, pidPath], {
  detached: ${options.detachedChild ? "true" : "false"},
  stdio: "ignore",
});
setInterval(() => {}, 1000);
`,
    );

    return { childPath, parentPath, markerPath, pidPath };
  }

  it("leaves child processes alone by default when a command is cancelled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-worker-mcp-"));
    const { childPath, parentPath, markerPath, pidPath } = await writeProcessTreeFixture(tempDir, {
      detachedChild: true,
    });

    let childPid: string | null = null;
    try {
      const controller = new AbortController();
      const resultPromise = runCommand({
        command: process.execPath,
        args: [parentPath, childPath, markerPath, pidPath],
        cwd: tempDir,
        abort_signal: controller.signal,
      });

      childPid = (await waitForFileText(pidPath)).trim() || null;
      controller.abort("test cancel");
      const result = await resultPromise;

      expect(result.cancelled).toBe(true);
      expect(result.cancel_reason).toBe("test cancel");
      expect(childPid).toBeTruthy();

      const before = (await fileText(markerPath)).length;
      await delay(350);
      const after = (await fileText(markerPath)).length;

      expect(after).toBeGreaterThan(before);
    } finally {
      childPid = childPid ?? ((await fileText(pidPath)).trim() || null);
      await killPid(childPid);
      await rmTempDir(tempDir);
    }
  });

  it("terminates child processes spawned by the command when kill_tree is true", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-worker-mcp-"));
    const { childPath, parentPath, markerPath, pidPath } = await writeProcessTreeFixture(tempDir);

    let childPid: string | null = null;
    try {
      const controller = new AbortController();
      const resultPromise = runCommand({
        command: process.execPath,
        args: [parentPath, childPath, markerPath, pidPath],
        cwd: tempDir,
        abort_signal: controller.signal,
        kill_tree: true,
      });

      childPid = (await waitForFileText(pidPath)).trim() || null;
      controller.abort("test cancel");
      const result = await resultPromise;

      expect(result.cancelled).toBe(true);
      expect(result.cancel_reason).toBe("test cancel");
      expect(childPid).toBeTruthy();

      const before = (await fileText(markerPath)).length;
      await delay(350);
      const after = (await fileText(markerPath)).length;

      expect(after).toBe(before);
    } finally {
      childPid = childPid ?? ((await fileText(pidPath)).trim() || null);
      await killPid(childPid);
      await rmTempDir(tempDir);
    }
  });

  it("terminates child processes spawned by the command when kill_tree times out", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-worker-mcp-"));
    const { childPath, parentPath, markerPath, pidPath } = await writeProcessTreeFixture(tempDir);

    let childPid: string | null = null;
    try {
      const result = await runCommand({
        command: process.execPath,
        args: [parentPath, childPath, markerPath, pidPath],
        cwd: tempDir,
        timeout_ms: 500,
        kill_tree: true,
      });

      childPid = (await fileText(pidPath)).trim() || null;
      expect(result.timed_out).toBe(true);
      expect(result.cancelled).toBe(true);
      expect(result.cancel_reason).toBe("timeout");
      expect(childPid).toBeTruthy();

      const before = (await fileText(markerPath)).length;
      await delay(350);
      const after = (await fileText(markerPath)).length;

      expect(after).toBe(before);
    } finally {
      childPid = childPid ?? ((await fileText(pidPath)).trim() || null);
      await killPid(childPid);
      await rmTempDir(tempDir);
    }
  });
});
