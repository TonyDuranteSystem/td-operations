import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  group: { external_group_id: "120363432541591903@g.us", lead_id: null, contact_id: null, group_name: "Team Group" } as Record<string, unknown>,
  messages: [] as Array<Record<string, unknown>>,
  prompts: [] as string[],
  messageQueries: [] as Array<{ col: string; val: unknown }>,
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u" } } }) } }) }))
vi.mock("@/lib/auth", () => ({ isDashboardUser: () => true }))
vi.mock("@/lib/portal/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), getRateLimitKey: () => "k" }))
vi.mock("@/lib/ai-agent/attachment-reader", () => ({
  callWorkerWithAttachments: async (msg: string) => { state.prompts.push(msg); return { reply: "Drafted reply", reachedMaxLoops: false } },
}))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = (col: string, val: unknown) => { if (table === "messages") state.messageQueries.push({ col, val }); return c }
      c.order = () => c
      c.limit = () => c
      c.single = async () => ({ data: table === "messaging_groups" ? state.group : null, error: null })
      c.maybeSingle = async () => ({ data: null, error: null })
      c.then = (resolve: (v: unknown) => void) => resolve({ data: table === "messages" ? state.messages : [], error: null })
      return c
    },
  },
}))

import { POST } from "@/app/api/inbox/whatsapp-new/suggest/route"

const call = async (body: Record<string, unknown>) => {
  process.env.ANTHROPIC_API_KEY = "x"
  const res = await POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }) as never)
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  state.prompts = []
  state.messageQueries = []
  state.messages = [
    { direction: "inbound", content_text: "When is the deadline?", content_type: "text", created_at: "2026-11-19T10:00:00Z", sender_name: "Shamim" },
    { direction: "outbound", content_text: "Next week", content_type: "text", created_at: "2026-11-19T10:05:00Z", sender_name: null },
  ].reverse()
})

describe("AI suggest inside a WhatsApp GROUP", () => {
  it("drafts from the group's own messages (by group id), names each speaker, and never treats the group id as a phone number", async () => {
    const r = await call({ groupId: "grp-1" })
    expect(r.status).toBe(200)
    expect(r.body.suggestion).toBe("Drafted reply")
    expect(state.messageQueries).toContainEqual({ col: "group_id", val: "grp-1" })
    const prompt = state.prompts[0]
    expect(prompt).toContain("GROUP CHAT: Team Group")
    expect(prompt).toContain("Shamim: When is the deadline?")
    expect(prompt).toContain("Antonio: Next week")
    expect(prompt).not.toContain("LEAD/CONTACT")
    expect(prompt).not.toContain("120363432541591903")
  })
})
