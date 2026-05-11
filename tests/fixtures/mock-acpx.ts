#!/usr/bin/env node
/**
 * mock-acpx — Simulates acpx stdout/stderr for testing agent-worker-mcp.
 *
 * Usage:
 *   node mock-acpx.js [--exit-code <n>] [--sleep-ms <n>] [--stderr <msg>] [--write-file <path>]
 *
 * Environment variables:
 *   MOCK_ACPX_EXIT_CODE  — exit code (default 0)
 *   MOCK_ACPX_SLEEP_MS   — simulate work time (default 100)
 *   MOCK_ACPX_STDERR     — stderr output (default: none)
 *   MOCK_ACPX_WRITE_FILE — path to create as a simulated worker output file
 */

const exitCode = Number(process.env.MOCK_ACPX_EXIT_CODE ?? 0);
const sleepMs = Number(process.env.MOCK_ACPX_SLEEP_MS ?? 100);
const stderrMsg = process.env.MOCK_ACPX_STDERR ?? "";
const writeFile = process.env.MOCK_ACPX_WRITE_FILE ?? "";

function ndjson(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  ndjson({ type: "start", timestamp: new Date().toISOString(), agent: "claude" });
  ndjson({ type: "thinking", text: "Analyzing task..." });
  ndjson({
    type: "tool_use",
    name: "write",
    input: { path: "src/foo.ts", content: "// fixed" },
  });
  ndjson({ type: "tool_result", name: "write", output: "File written." });

  if (writeFile) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(writeFile), { recursive: true });
    await fs.writeFile(writeFile, "// mock worker output\n");
    ndjson({ type: "tool_use", name: "write", input: { path: writeFile } });
  }

  if (sleepMs > 0) {
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  ndjson({
    type: "result",
    subtype: "success",
    final_message: "Task completed successfully. Modified src/foo.ts. All tests pass.",
    stop_reason: "end_turn",
    timestamp: new Date().toISOString(),
  });

  if (stderrMsg) {
    process.stderr.write(stderrMsg);
  }

  process.exit(exitCode);
}

main();
