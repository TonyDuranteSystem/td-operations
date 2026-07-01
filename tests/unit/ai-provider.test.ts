import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { callAI } from "@/lib/portal/ai-provider"

// Build a minimal fetch Response stub.
function res(ok: boolean, body: unknown, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as unknown as Response
}
function anthropicOk(text: string) {
  return res(true, { content: [{ type: "text", text }] })
}
function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { body: string }).body)
}

const baseReq = {
  systemPrompt: "sys",
  userPrompt: "user",
  maxTokens: 100,
  temperature: 0.7,
}

describe("callAI (Sonnet/Opus only, no Haiku/GPT)", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("defaults to Sonnet and sends temperature", async () => {
    fetchMock.mockResolvedValueOnce(anthropicOk("hi"))
    const out = await callAI({ ...baseReq })
    expect(out).toEqual({ text: "hi", provider: "anthropic", model: "sonnet" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = bodyOf(fetchMock.mock.calls[0])
    expect(body.model).toBe("claude-sonnet-4-6")
    expect(body.temperature).toBe(0.7)
  })

  it("OMITS temperature for Opus (it 400s otherwise)", async () => {
    fetchMock.mockResolvedValueOnce(anthropicOk("op"))
    const out = await callAI({ ...baseReq, model: "opus" })
    expect(out.model).toBe("opus")
    const body = bodyOf(fetchMock.mock.calls[0])
    expect(body.model).toBe("claude-opus-4-8")
    expect("temperature" in body).toBe(false)
  })

  it("falls over Sonnet → Opus, and the Opus attempt has no temperature", async () => {
    fetchMock
      .mockResolvedValueOnce(res(false, { error: "overloaded" }, 529)) // sonnet fails
      .mockResolvedValueOnce(anthropicOk("recovered")) // opus succeeds
    const out = await callAI({ ...baseReq })
    expect(out).toEqual({ text: "recovered", provider: "anthropic", model: "opus" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(fetchMock.mock.calls[0]).model).toBe("claude-sonnet-4-6")
    const opusBody = bodyOf(fetchMock.mock.calls[1])
    expect(opusBody.model).toBe("claude-opus-4-8")
    expect("temperature" in opusBody).toBe(false)
  })

  it("never calls OpenAI — only the two Anthropic endpoints", async () => {
    fetchMock
      .mockResolvedValueOnce(res(false, {}, 500))
      .mockResolvedValueOnce(res(false, {}, 500))
    await expect(callAI({ ...baseReq })).rejects.toThrow()
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://api.anthropic.com/v1/messages")
    }
  })

  it("throws a detailed error carrying BOTH model failures (no opaque message)", async () => {
    fetchMock
      .mockResolvedValueOnce(res(false, { error: "bad-sonnet" }, 400))
      .mockResolvedValueOnce(res(false, { error: "bad-opus" }, 400))
    await expect(callAI({ ...baseReq })).rejects.toThrow(/All AI models failed/)
    await expect(callAI({ ...baseReq })).rejects.toThrow(/sonnet/)
    await expect(callAI({ ...baseReq })).rejects.toThrow(/opus/)
  })

  it("fails clearly when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY
    await expect(callAI({ ...baseReq })).rejects.toThrow(/ANTHROPIC_API_KEY not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
