/**
 * Team Management — renaming a dashboard user (PATCH full_name).
 * Antonio, 2026-10-02: "in team management I can't change the name of the user."
 * The name lives only in auth user_metadata.full_name; the write must keep every other key
 * in that object (e.g. must_change_password) and must not weaken the self-protection on role/disabled.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const state = {
  caller: { id: "admin-1", app_metadata: { role: "admin" } } as unknown,
  target: { id: "u-2", user_metadata: { full_name: "Luca Degsper", must_change_password: true } } as unknown,
  updateCalls: [] as Array<{ id: string; attrs: Record<string, unknown> }>,
  updateError: null as null | { message: string },
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: state.caller } }) } }),
}))
vi.mock("@/lib/auth", () => ({
  isAdmin: (u: { app_metadata?: { role?: string } } | null) => u?.app_metadata?.role === "admin",
}))
vi.mock("@/lib/auth-admin-helpers", () => ({ findAuthUserByEmail: vi.fn(), listAllAuthUsers: vi.fn() }))
vi.mock("@/lib/config", () => ({ CRM_BASE_URL: "https://crm.example" }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        getUserById: async () => (state.target ? { data: { user: state.target }, error: null } : { data: { user: null }, error: { message: "nf" } }),
        updateUserById: async (id: string, attrs: Record<string, unknown>) => {
          state.updateCalls.push({ id, attrs })
          return { error: state.updateError }
        },
      },
    },
  },
}))

import { PATCH } from "@/app/api/team-management/route"

const patch = (body: Record<string, unknown>) =>
  PATCH(new NextRequest("http://localhost/api/team-management", { method: "PATCH", body: JSON.stringify(body) }))

beforeEach(() => {
  state.caller = { id: "admin-1", app_metadata: { role: "admin" } }
  state.target = { id: "u-2", user_metadata: { full_name: "Luca Degsper", must_change_password: true } }
  state.updateCalls = []
  state.updateError = null
})

describe("PATCH /api/team-management — full_name", () => {
  it("renames and keeps every other metadata key", async () => {
    const res = await patch({ user_id: "u-2", full_name: "  Luca Degasper  " })
    expect(res.status).toBe(200)
    expect(state.updateCalls).toHaveLength(1)
    expect(state.updateCalls[0]).toEqual({
      id: "u-2",
      attrs: { user_metadata: { full_name: "Luca Degasper", must_change_password: true } },
    })
  })

  it("rejects an empty or over-long name and writes nothing", async () => {
    expect((await patch({ user_id: "u-2", full_name: "   " })).status).toBe(400)
    expect((await patch({ user_id: "u-2", full_name: "x".repeat(101) })).status).toBe(400)
    expect((await patch({ user_id: "u-2", full_name: 42 })).status).toBe(400)
    expect(state.updateCalls).toHaveLength(0)
  })

  it("404s for an unknown user and writes nothing", async () => {
    state.target = null
    expect((await patch({ user_id: "ghost", full_name: "Support" })).status).toBe(404)
    expect(state.updateCalls).toHaveLength(0)
  })

  it("surfaces an auth-server failure as 500", async () => {
    state.updateError = { message: "boom" }
    expect((await patch({ user_id: "u-2", full_name: "Support" })).status).toBe(500)
  })

  it("refuses non-admins", async () => {
    state.caller = { id: "t-1", app_metadata: { role: "team" } }
    expect((await patch({ user_id: "u-2", full_name: "Support" })).status).toBe(403)
    expect(state.updateCalls).toHaveLength(0)
  })

  it("lets an admin rename themselves, but still blocks changing their own role or access", async () => {
    expect((await patch({ user_id: "admin-1", full_name: "Antonio Durante" })).status).toBe(200)
    expect((await patch({ user_id: "admin-1", role: "team" })).status).toBe(400)
    expect((await patch({ user_id: "admin-1", disabled: true })).status).toBe(400)
  })
})
