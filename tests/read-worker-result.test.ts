import { describe, it, expect } from "vitest";

// Test event parsing separately — same logic as src/index.ts parseWorkerEvents

type WorkerEventSummary = {
  stop_reason: string | null;
  final_message: string | null;
  tool_calls: string[];
  error_event: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
};

function parseWorkerEvents(eventsText: string | null): WorkerEventSummary {
  const summary: WorkerEventSummary = {
    stop_reason: null,
    final_message: null,
    tool_calls: [],
    error_event: null,
    duration_ms: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
  };

  if (!eventsText) return summary;

  const lines = eventsText.split(/\r?\n/).filter(Boolean);
  const messageChunks: string[] = [];
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  const seenToolCalls = new Set<string>();

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event.method === "session/update" && event.params?.update) {
        const update = event.params.update;
        const su = update.sessionUpdate;

        if (su === "agent_message_chunk" && update.content?.type === "text") {
          messageChunks.push(update.content.text ?? "");
        }

        if (su === "tool_call" || su === "tool_use") {
          const toolName = update.title ?? update.name ?? update.tool ?? "unknown";
          if (!seenToolCalls.has(toolName)) {
            summary.tool_calls.push(toolName);
            seenToolCalls.add(toolName);
          }
        }

        if (su === "usage_update") {
          if (update.used != null && summary.input_tokens === null) {
            summary.input_tokens = update.used;
          }
          if (update.cost) {
            summary.cost_usd = update.cost.amount ?? null;
          }
        }
      }

      if (event.type === "result" || event.type === "done") {
        summary.stop_reason = event.stop_reason ?? event.subtype ?? event.stopReason ?? null;
        if (event.final_message || event.message || event.text) {
          summary.final_message = event.final_message ?? event.message ?? event.text ?? null;
        }
      }
      if (event.type === "tool_call" || event.type === "tool_use") {
        const toolName = event.title ?? event.name ?? event.tool ?? "unknown";
        if (!seenToolCalls.has(toolName)) {
          summary.tool_calls.push(toolName);
          seenToolCalls.add(toolName);
        }
      }
      if (event.type === "error") {
        summary.error_event = event.message ?? event.error ?? JSON.stringify(event);
      }

      if (event.id != null && event.result?.stopReason) {
        summary.stop_reason = event.result.stopReason;
        if (event.result.usage) {
          summary.input_tokens = event.result.usage.inputTokens ?? summary.input_tokens;
          summary.output_tokens = event.result.usage.outputTokens ?? null;
        }
      }

      if (event.timestamp) {
        const ts = new Date(event.timestamp).getTime();
        if (Number.isFinite(ts)) {
          if (firstTimestamp === null) firstTimestamp = ts;
          lastTimestamp = ts;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  if (messageChunks.length > 0) {
    summary.final_message = messageChunks.join("");
  }

  if (firstTimestamp !== null && lastTimestamp !== null && lastTimestamp > firstTimestamp) {
    summary.duration_ms = lastTimestamp - firstTimestamp;
  }

  return summary;
}

describe("parseWorkerEvents", () => {
  it("returns empty summary for null input", () => {
    const s = parseWorkerEvents(null);
    expect(s.stop_reason).toBeNull();
    expect(s.final_message).toBeNull();
    expect(s.tool_calls).toEqual([]);
    expect(s.error_event).toBeNull();
    expect(s.duration_ms).toBeNull();
  });

  it("parses result event with stop_reason and final_message", () => {
    const events = [
      JSON.stringify({ type: "start", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        final_message: "All done.",
        stop_reason: "end_turn",
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    ].join("\n");

    const s = parseWorkerEvents(events);
    expect(s.stop_reason).toBe("end_turn");
    expect(s.final_message).toBe("All done.");
    expect(s.duration_ms).toBe(60000);
  });

  it("collects tool calls", () => {
    const events = [
      JSON.stringify({ type: "start", timestamp: new Date().toISOString() }),
      JSON.stringify({ type: "tool_use", name: "write" }),
      JSON.stringify({ type: "tool_use", name: "bash" }),
      JSON.stringify({ type: "result", subtype: "success", timestamp: new Date().toISOString() }),
    ].join("\n");

    const s = parseWorkerEvents(events);
    expect(s.tool_calls).toEqual(["write", "bash"]);
  });

  it("captures error events", () => {
    const events = [
      JSON.stringify({ type: "start", timestamp: new Date().toISOString() }),
      JSON.stringify({ type: "error", message: "Something went wrong" }),
      JSON.stringify({ type: "result", timestamp: new Date().toISOString() }),
    ].join("\n");

    const s = parseWorkerEvents(events);
    expect(s.error_event).toBe("Something went wrong");
  });

  it("skips malformed lines", () => {
    const events = [
      "not valid json",
      JSON.stringify({ type: "start", timestamp: "2026-01-01T00:00:00.000Z" }),
      "",
      JSON.stringify({ type: "result", subtype: "success", final_message: "ok", timestamp: "2026-01-01T00:01:00.000Z" }),
    ].join("\n");

    const s = parseWorkerEvents(events);
    expect(s.final_message).toBe("ok");
    expect(s.duration_ms).toBe(60000);
  });

  it("handles done event type", () => {
    const events = [
      JSON.stringify({ type: "start", timestamp: new Date().toISOString() }),
      JSON.stringify({ type: "done", stop_reason: "max_turns", message: "Hit limit", timestamp: new Date().toISOString() }),
    ].join("\n");

    const s = parseWorkerEvents(events);
    expect(s.stop_reason).toBe("max_turns");
    expect(s.final_message).toBe("Hit limit");
  });

  it("parses acpx JSON-RPC session/update format (Claude)", () => {
    const events = [
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "abc", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "abc", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "!" } } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "abc", update: { sessionUpdate: "usage_update", cost: { amount: 0.065, currency: "USD" } } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 } } }),
    ].join("\n");

    const s = parseWorkerEvents(events);
    expect(s.final_message).toBe("Hello!");
    expect(s.stop_reason).toBe("end_turn");
    expect(s.input_tokens).toBe(100);
    expect(s.output_tokens).toBe(50);
    expect(s.cost_usd).toBe(0.065);
  });

  it("parses Codex tool_call with title field", () => {
    const events = [
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "abc", update: { sessionUpdate: "tool_call", title: "pwd", kind: "execute", status: "in_progress" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "abc", update: { sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "abc", update: { sessionUpdate: "usage_update", used: 20308, size: 258400 } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }),
    ].join("\n");

    const s = parseWorkerEvents(events);
    expect(s.tool_calls).toEqual(["pwd"]);
    expect(s.stop_reason).toBe("end_turn");
    expect(s.input_tokens).toBe(20308);
    expect(s.output_tokens).toBeNull(); // Codex doesn't report output tokens
  });

  it("deduplicates tool calls", () => {
    const events = [
      JSON.stringify({ type: "tool_call", name: "bash" }),
      JSON.stringify({ type: "tool_call", name: "bash" }),
      JSON.stringify({ type: "done", stop_reason: "end_turn" }),
    ].join("\n");

    const s = parseWorkerEvents(events);
    expect(s.tool_calls).toEqual(["bash"]);
  });
});

describe("TaskIdSchema validation", () => {
  // Replicate the regex validation
  const taskIdRegex = /^[A-Za-z0-9_.-]+$/;

  it("accepts valid task IDs", () => {
    expect(taskIdRegex.test("task-001")).toBe(true);
    expect(taskIdRegex.test("task_001.final")).toBe(true);
    expect(taskIdRegex.test("fix.auth-bug_v2")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(taskIdRegex.test("")).toBe(false);
  });

  it("rejects path traversal in task ID", () => {
    expect(taskIdRegex.test("../escape")).toBe(false);
    expect(taskIdRegex.test("task/child")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(taskIdRegex.test("task 001")).toBe(false);
  });

  it("accepts 120-char max length", () => {
    const long = "a".repeat(120);
    expect(long.length).toBe(120);
    expect(taskIdRegex.test(long)).toBe(true);
  });
});
