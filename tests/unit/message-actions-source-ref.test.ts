import { describe, it, expect, vi, beforeEach } from "vitest"

// Focused coverage for the source_ref identity path added for WhatsApp messages (which have no
// portal_messages row to point message_id at) — NOT a full re-test of this pre-existing route.
const st = vi.hoisted(() => ({
  isStaff: true,
  columns: [{ slug: "action_needed", metadata: {} }, { slug: "done", metadata: { terminal: true } }],
  existing: null as null | { id: string },
  inserted: [] as Array<Record<string, unknown>>,
  updated: [] as Array<{ id: string; payload: Record<string, unknown> }>,
  selectFilters: [] as Array<{ column: string; value: unknown }>,
}))

vi.mock("@/lib/auth", () => ({ isDashboardUser: () => st.isStaff }))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }) }))
vi.mock("@/lib/ui-events", () => ({ emitUiEvent: async () => {} }))
vi.mock("@/lib/todo-board/entity-scope", () => ({ resolveEntityScope: () => ({ scope: null, error: "unused in these tests" }) }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "catalog_entries") {
        return { select: () => ({ eq: () => ({ eq: async () => ({ data: st.columns, error: null }) }) }) }
      }
      // message_actions
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = (column: string, value: unknown) => {
        st.selectFilters.push({ column, value })
        return c
      }
      c.limit = () => c
      c.maybeSingle = async () => ({ data: st.existing, error: null })
      c.insert = (payload: Record<string, unknown>) => {
        st.inserted.push(payload)
        return { select: () => ({ single: async () => ({ data: { id: "new-id", ...payload }, error: null }) }) }
      }
      c.update = (payload: Record<string, unknown>) => {
        return {
          eq: (_col: string, id: string) => {
            st.updated.push({ id, payload })
            return { select: () => ({ single: async () => ({ data: { id, ...payload }, error: null }) }) }
          },
        }
      }
      return c
    },
  },
}))

import { POST } from "@/app/api/crm/admin-actions/message-actions/route"

const call = (body: Record<string, unknown>) => POST({ json: async () => body } as never)

beforeEach(() => {
  st.isStaff = true
  st.existing = null
  st.inserted = []
  st.updated = []
  st.selectFilters = []
})

describe("POST /api/crm/admin-actions/message-actions — source_ref identity (WhatsApp messages)", () => {
  it("creates a card keyed by source_ref, with message_id left null, when no message_id is given", async () => {
    const res = await call({ source_ref: "wa_message:m1", account_id: "a1", action_type: "action_needed", label: "reply about invoice" })
    expect(res.status).toBe(200)
    expect(st.selectFilters[0]).toEqual({ column: "source_ref", value: "wa_message:m1" })
    expect(st.inserted[0]).toMatchObject({ message_id: null, source_ref: "wa_message:m1", account_id: "a1", action_type: "action_needed", label: "reply about invoice" })
  })
  it("a second call with the SAME source_ref updates the existing card instead of creating a duplicate", async () => {
    st.existing = { id: "existing-1" }
    const res = await call({ source_ref: "wa_message:m1", account_id: "a1", action_type: "done" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.updated).toBe(true)
    expect(st.updated[0]).toMatchObject({ id: "existing-1", payload: { action_type: "done" } })
    expect(st.inserted).toHaveLength(0)
  })
  it("message_id still works exactly as before, unaffected by source_ref support", async () => {
    const res = await call({ message_id: "portal-msg-1", account_id: "a1", action_type: "action_needed" })
    expect(res.status).toBe(200)
    expect(st.selectFilters[0]).toEqual({ column: "message_id", value: "portal-msg-1" })
    expect(st.inserted[0]).toMatchObject({ message_id: "portal-msg-1", source_ref: null })
  })
  it("refuses when NEITHER message_id nor source_ref is given", async () => {
    const res = await call({ account_id: "a1", action_type: "action_needed" })
    expect(res.status).toBe(400)
    expect(st.inserted).toHaveLength(0)
  })
})
