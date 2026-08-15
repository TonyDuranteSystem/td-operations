/**
 * Unit tests for the runWorkerLoop step-limit convergence fix.
 *
 * When the tool loop is exhausted (hit maxLoops or the wall-clock budget) WITHOUT
 * the model ever producing a final text answer, the worker used to return a
 * generic "I reached my working limit" message — so an investigative question
 * (which legitimately chains many read tools) got NO answer. The fix makes ONE
 * final NO-TOOLS call forcing the model to synthesize what it found into a real
 * answer, falling back to the generic message only on failure/empty.
 *
 * All network is mocked — no real Anthropic call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

import {
  runWorkerLoop,
  WORKER_THINKING_BUDGET_TOKENS,
  WORKER_MAX_TOKENS_WITH_THINKING,
} from "@/lib/ai-agent/worker-tools"

const toolUseResponse = {
  ok: true,
  json: () =>
    Promise.resolve({
      // An unknown tool name → executeWorkerTool returns a "not permitted" string
      // with NO network call, keeping the test hermetic while still exercising the
      // tool-result append path.
      content: [{ type: "tool_use", id: "t1", name: "nonexistent_tool", input: {} }],
      stop_reason: "tool_use",
      usage: {},
    }),
}

describe("runWorkerLoop — step-limit convergence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  it("forces a final no-tools answer when the loop is exhausted", async () => {
    mockFetch
      .mockResolvedValueOnce(toolUseResponse) // iteration 0 → tool_use (no final text)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "Final synthesized answer." }],
            stop_reason: "end_turn",
            usage: {},
          }),
      })

    const result = await runWorkerLoop("investigate something", [], "sys prompt", 1)

    expect(result.reply).toBe("Final synthesized answer.")
    expect(result.reachedMaxLoops).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // The synthesis (2nd) call must omit `tools` so the model is forced to answer
    // in text; the loop (1st) call always includes a tools array.
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(firstBody.tools).toBeDefined()
    expect(secondBody.tools).toBeUndefined()
  })

  it("falls back to the generic working-limit message if the synthesis call fails", async () => {
    mockFetch
      .mockResolvedValueOnce(toolUseResponse) // iteration 0 → tool_use
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: "boom" }) }) // synthesis fails

    const result = await runWorkerLoop("investigate something", [], "sys prompt", 1)

    expect(result.reply).toContain("working limit")
    expect(result.reply).toContain("1 steps") // maxLoops interpolated
    expect(result.reachedMaxLoops).toBe(true)
  })

  it("returns the model's answer normally without a synthesis call when it ends the turn", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: "Direct answer." }],
          stop_reason: "end_turn",
          usage: {},
        }),
    })

    const result = await runWorkerLoop("simple question", [], "sys prompt", 5)

    expect(result.reply).toBe("Direct answer.")
    expect(result.reachedMaxLoops).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(1) // no synthesis call needed
  })
})

// ── Quick-gear ceiling wiring (dev job 5e87b099, 2026-08-14) ────────────────
// Exercises the ACTUAL loop, not just the pure gate function — bug-hunter review
// found the pure-function tests alone wouldn't catch an off-by-one or an
// inverted condition in the real wiring.
describe("runWorkerLoop — quick-gear ceiling wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  const finalAnswer = {
    ok: true,
    json: () =>
      Promise.resolve({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: {} }),
  }
  const NUDGE_FRAGMENT = "If you have what you need, stop here and answer"

  it("nudges to wrap up once a PLAIN ask crosses the tool-call ceiling", async () => {
    for (let i = 0; i < 9; i++) mockFetch.mockResolvedValueOnce(toolUseResponse)
    mockFetch.mockResolvedValueOnce(finalAnswer)

    await runWorkerLoop("Draft a reply and attach the file.", [], "sys prompt", 15)

    const sawNudge = mockFetch.mock.calls.some((c) =>
      JSON.stringify(JSON.parse(c[1].body).messages).includes(NUDGE_FRAGMENT),
    )
    expect(sawNudge).toBe(true)
  })

  it("does NOT nudge a plain ask that stays under the ceiling", async () => {
    for (let i = 0; i < 3; i++) mockFetch.mockResolvedValueOnce(toolUseResponse)
    mockFetch.mockResolvedValueOnce(finalAnswer)

    await runWorkerLoop("Draft a reply and attach the file.", [], "sys prompt", 15)

    const sawNudge = mockFetch.mock.calls.some((c) =>
      JSON.stringify(JSON.parse(c[1].body).messages).includes(NUDGE_FRAGMENT),
    )
    expect(sawNudge).toBe(false)
  })

  it("does NOT nudge when the staff member's own message reads as an explicit dig-in ask", async () => {
    for (let i = 0; i < 9; i++) mockFetch.mockResolvedValueOnce(toolUseResponse)
    mockFetch.mockResolvedValueOnce(finalAnswer)

    await runWorkerLoop("Please investigate this account's history and figure out what happened.", [], "sys prompt", 15)

    const sawNudge = mockFetch.mock.calls.some((c) =>
      JSON.stringify(JSON.parse(c[1].body).messages).includes(NUDGE_FRAGMENT),
    )
    expect(sawNudge).toBe(false)
  })
})

// ── Extended thinking (dev job 5e87b099 follow-on, 2026-08-15) ─────────────
// Antonio: the worker should understand what was actually meant, not just react
// to the words used (the Lorenzo Zarone "attach the screenshot" mix-up). Gives
// the model a real reasoning pass before it commits to a reply or a tool call.
describe("runWorkerLoop — extended thinking", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  it("enables thinking with the configured budget on every call the main loop makes", async () => {
    mockFetch.mockResolvedValueOnce(toolUseResponse).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: {} }),
    })

    await runWorkerLoop("simple question", [], "sys prompt", 5)

    for (const call of mockFetch.mock.calls) {
      const body = JSON.parse(call[1].body)
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: WORKER_THINKING_BUDGET_TOKENS })
    }
  })

  it("enables thinking on the exhaustion-synthesis (no-tools) call too", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "tool_use", id: "t1", name: "nonexistent_tool", input: {} }],
            stop_reason: "tool_use",
            usage: {},
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ content: [{ type: "text", text: "Synthesized." }], stop_reason: "end_turn", usage: {} }),
      })

    await runWorkerLoop("investigate something", [], "sys prompt", 1)

    const synthesisCall = mockFetch.mock.calls[1]
    const body = JSON.parse(synthesisCall[1].body)
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: WORKER_THINKING_BUDGET_TOKENS })
    // No tools on this call — must stay true with thinking added.
    expect(body.tools).toBeUndefined()
  })

  it("max_tokens stays strictly greater than the thinking budget — the API rejects the request otherwise", () => {
    expect(WORKER_MAX_TOKENS_WITH_THINKING).toBeGreaterThan(WORKER_THINKING_BUDGET_TOKENS)
  })

  it("does not shrink the pre-thinking output ceiling — adds budget on top instead of eating into it", () => {
    // Pinned so nobody "fixes" a max_tokens overrun later by quietly cutting the
    // thinking budget out of the existing 16384 output ceiling instead of adding to it.
    expect(WORKER_MAX_TOKENS_WITH_THINKING - WORKER_THINKING_BUDGET_TOKENS).toBe(16384)
  })

  it("bug-hunter finding (2026-08-15): a model that rejects the thinking field degrades gracefully instead of failing the whole surface", async () => {
    // Antonio can switch the worker's model from a shared gear — not every
    // selectable model is confirmed extended-thinking-capable. A model that
    // rejects it responds with a 400 naming "thinking" in the error body.
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        clone: function () { return this },
        json: () => Promise.resolve({ type: "error", error: { type: "invalid_request_error", message: "thinking.budget_tokens: not supported for this model" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: [{ type: "text", text: "Answered anyway." }], stop_reason: "end_turn", usage: {} }),
      })

    const result = await runWorkerLoop("simple question", [], "sys prompt", 5)

    expect(result.reply).toBe("Answered anyway.")
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(firstBody.thinking).toBeDefined()
    expect(secondBody.thinking).toBeUndefined()
    expect(secondBody.max_tokens).toBe(16384) // falls back to the pre-thinking ceiling too
  })

  it("a 400 unrelated to thinking still surfaces as a real error, not silently swallowed", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      clone: function () { return this },
      json: () => Promise.resolve({ type: "error", error: { type: "invalid_request_error", message: "messages: at least one message is required" } }),
    })

    await expect(runWorkerLoop("simple question", [], "sys prompt", 5)).rejects.toThrow(/Claude API error 400/)
    expect(mockFetch).toHaveBeenCalledTimes(1) // no thinking-fallback retry — the error isn't about thinking
  })

  it("thinking blocks in the response don't break tool-call or text extraction", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            { type: "thinking", thinking: "reasoning about who 'attach' refers to...", signature: "sig" },
            { type: "text", text: "Here is the answer." },
          ],
          stop_reason: "end_turn",
          usage: {},
        }),
    })

    const result = await runWorkerLoop("simple question", [], "sys prompt", 5)
    expect(result.reply).toBe("Here is the answer.")
  })
})
