/**
 * Unit tests for the Slack worker's web-research rail (Anthropic server tools):
 *  - buildWebServerTools shape (web_search w/ cap + web_fetch, correct versions)
 *  - runWorkerLoop attaches server tools to the request when passed
 *  - runWorkerLoop RESUMES a server-tool pause_turn (instead of stopping early)
 *
 * All network is mocked — no real Anthropic call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

import {
  runWorkerLoop,
  buildWebServerTools,
  WORKER_WEB_SEARCH_MAX_USES,
} from "@/lib/ai-agent/worker-tools"

describe("buildWebServerTools", () => {
  it("returns the dynamic-filtering web_search (capped) + web_fetch server tools", () => {
    const tools = buildWebServerTools()
    const search = tools.find((t) => t.name === "web_search")
    const fetchTool = tools.find((t) => t.name === "web_fetch")
    expect(search).toMatchObject({ type: "web_search_20260209", name: "web_search", max_uses: WORKER_WEB_SEARCH_MAX_USES })
    expect(fetchTool).toMatchObject({ type: "web_fetch_20260209", name: "web_fetch" })
    expect(WORKER_WEB_SEARCH_MAX_USES).toBeGreaterThan(0)
  })
})

describe("runWorkerLoop — web server tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  it("attaches the server tools to the request body when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: {} }),
    })

    await runWorkerLoop("q", [], "sys", 1, null, null, buildWebServerTools())

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const toolTypes = body.tools.map((t: Record<string, unknown>) => t.type)
    expect(toolTypes).toContain("web_search_20260209")
    expect(toolTypes).toContain("web_fetch_20260209")
  })

  it("does NOT attach web tools when none are passed (default off)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: {} }),
    })

    await runWorkerLoop("q", [], "sys", 1)

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const toolTypes = (body.tools || []).map((t: Record<string, unknown>) => t.type)
    expect(toolTypes).not.toContain("web_search_20260209")
  })

  it("resumes a server-tool pause_turn (no client tool_use) instead of stopping early", async () => {
    mockFetch
      // iteration 0: server tool ran, loop paused — only a server_tool_use block, NO client tool_use
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } }],
            stop_reason: "pause_turn",
            usage: {},
          }),
      })
      // iteration 1: server resumed and produced the final answer
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "Per example.com, the answer is 42." }],
            stop_reason: "end_turn",
            usage: {},
          }),
      })

    const result = await runWorkerLoop("look it up", [], "sys", 3, null, null, buildWebServerTools())

    expect(result.reply).toBe("Per example.com, the answer is 42.")
    expect(result.reachedMaxLoops).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(2) // it re-sent, did not stop on the pause

    // The resume request carried the paused assistant turn forward.
    const resumeBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(resumeBody.messages.length).toBeGreaterThan(1)
    expect(resumeBody.messages.some((m: { role: string }) => m.role === "assistant")).toBe(true)
  })
})
