/**
 * POST /api/inbox/whatsapp/polish — the WhatsApp sparkle when the box already has text.
 * Antonio, 2026-10-07: the old sparkle ignored what he typed and replaced it with its own draft.
 * ONLY his text may reach the model, and a result that changes numbers/links/language is never applied.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({ isStaff: true, rateAllowed: true, aiConfigured: true }))
const callAIMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: state.isStaff ? { id: "u1" } : null } }) } }),
}))
vi.mock("@/lib/auth", () => ({ isDashboardUser: (u: unknown) => !!u && state.isStaff }))
vi.mock("@/lib/portal/rate-limit", () => ({
  checkRateLimit: () => (state.rateAllowed ? { allowed: true } : { allowed: false, retryAfter: 7 }),
}))
vi.mock("@/lib/portal/ai-provider", () => ({ callAI: (...a: unknown[]) => callAIMock(...a) }))

import { POST } from "@/app/api/inbox/whatsapp/polish/route"
import { WHATSAPP_POLISH_SYSTEM_PROMPT, POLISH_MAX_DRAFT_CHARS } from "@/lib/inbox/ai-email"

const post = (body: unknown) => POST({ json: async () => body } as never)
const TYPED = "Ciao Stefano, il tuo ITIN costa 400 dollari e lo facciamo in 3 settimane. fammi sapere"

beforeEach(() => {
  state.isStaff = true
  state.rateAllowed = true
  process.env.ANTHROPIC_API_KEY = "test"
  callAIMock.mockReset()
})

describe("access and validation", () => {
  it("refuses anyone who is not staff, before any AI call", async () => {
    state.isStaff = false
    expect((await post({ text: TYPED })).status).toBe(403)
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it("rate limits per staff member with a plain message", async () => {
    state.rateAllowed = false
    const res = await post({ text: TYPED })
    expect(res.status).toBe(429)
    expect((await res.json()).error).toContain("wait 7 seconds")
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it("503 when no AI key is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    expect((await post({ text: TYPED })).status).toBe(503)
  })

  it.each([[{}], [{ text: "   " }], [{ text: 42 }]])("400 when there is nothing to polish %#", async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it("400 for text over the limit", async () => {
    const res = await post({ text: "a".repeat(POLISH_MAX_DRAFT_CHARS + 1) })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("too_long")
  })
})

describe("only his text goes to the model, and the result is checked", () => {
  it("sends the WhatsApp copy-editor prompt and ONLY the typed text (no chat, no CRM)", async () => {
    callAIMock.mockResolvedValue({ text: `<draft>\nCiao Stefano, il tuo ITIN costa 400 dollari e lo facciamo in 3 settimane. Fammi sapere!\n</draft>`, provider: "anthropic" })
    const res = await post({ text: TYPED })
    expect(res.status).toBe(200)
    const arg = callAIMock.mock.calls[0][0] as { systemPrompt: string; userPrompt: string; temperature: number }
    expect(arg.systemPrompt).toBe(WHATSAPP_POLISH_SYSTEM_PROMPT)
    expect(arg.userPrompt).toBe(`<draft>\n${TYPED}\n</draft>`)
    expect(arg.temperature).toBe(0.2)
    const json = await res.json()
    expect(json.result).toContain("Fammi sapere!")
    expect(json.changed).toBe(true)
  })

  it("reports no change when the text already reads well", async () => {
    callAIMock.mockResolvedValue({ text: `<draft>\n${TYPED}\n</draft>`, provider: "anthropic" })
    const json = await (await post({ text: TYPED })).json()
    expect(json.changed).toBe(false)
  })

  it("422 and nothing applied when the AI changes a number", async () => {
    callAIMock.mockResolvedValue({ text: `<draft>\nCiao Stefano, il tuo ITIN costa 500 dollari e lo facciamo in 3 settimane. Fammi sapere!\n</draft>`, provider: "anthropic" })
    const res = await post({ text: TYPED })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe("rejected_numbers")
    expect(json.result).toBeUndefined()
  })

  it("422 when the AI translates the message", async () => {
    callAIMock.mockResolvedValue({ text: `<draft>\nHello Stefano, your ITIN costs 400 dollars and we do it in 3 weeks. Let me know\n</draft>`, provider: "anthropic" })
    expect((await post({ text: TYPED })).status).toBe(422)
  })

  it("keeps emoji and WhatsApp *bold* exactly when they were typed", async () => {
    const typed = "Ciao! *Importante*: l'appuntamento e' domani alle 10 😊"
    callAIMock.mockResolvedValue({ text: `<draft>\nCiao! *Importante*: l'appuntamento è domani alle 10 😊\n</draft>`, provider: "anthropic" })
    const json = await (await post({ text: typed })).json()
    expect(json.result).toBe("Ciao! *Importante*: l'appuntamento è domani alle 10 😊")
  })

  it("a provider failure is a plain 502 that says the text was left alone", async () => {
    callAIMock.mockRejectedValue(new Error("upstream 500 secret detail"))
    const res = await post({ text: TYPED })
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.error).toContain("left as it is")
    expect(json.error).not.toContain("secret detail")
  })
})

describe("the WhatsApp polish prompt", () => {
  it("is a copy editor that never translates, invents, or touches facts, emoji or formatting", () => {
    const p = WHATSAPP_POLISH_SYSTEM_PROMPT
    expect(p).toContain("WhatsApp message")
    expect(p).toContain("never translate")
    expect(p).toContain("NEVER add a fact, price, promise")
    expect(p).toContain("Keep every emoji")
    expect(p).toContain("*bold*")
    expect(p).not.toMatch(/\bemail reply\b/i)
  })
})
