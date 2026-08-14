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

import { runWorkerLoop } from "@/lib/ai-agent/worker-tools"

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
