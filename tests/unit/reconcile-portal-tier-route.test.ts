/**
 * P3.4 #2 — /api/crm/admin-actions/reconcile-portal-tier unit tests.
 *
 * Covers: auth (isAdmin), input validation (contact_id required, valid
 * target_tier), contact lookup (404), reconcileTier success/failure
 * paths, response message shape (no-drift vs drift), and action_log
 * logging.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Fixture state ─────────────────────────────────────

interface ContactRow {
  id: string
  full_name: string
  email: string | null
  portal_tier: string | null
}

let authUserFixture: { id: string; email: string | null } | null = null
let isAdminReturn = true
let contactFixture: ContactRow | null = null
let contactError: { message: string } | null = null
let reconcileResult = {
  success: true,
  contact_id: "contact-1",
  resolved_tier: "active" as string | null,
  changed: { contact: false, accounts: [] as string[], auth_user: false },
  error: undefined as string | undefined,
}
let lastActionLogInsert: Record<string, unknown> | null = null

// ─── Mocks ─────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: vi.fn(() => Promise.resolve({ data: { user: authUserFixture }, error: null })),
    },
  }),
}))

vi.mock("@/lib/auth", () => ({
  isAdmin: vi.fn(() => isAdminReturn),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "contacts") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn(() => Promise.resolve({ data: contactFixture, error: contactError })),
        }
      }
      if (table === "action_log") {
        return {
          insert: vi.fn((payload: Record<string, unknown>) => {
            lastActionLogInsert = payload
            return Promise.resolve({ data: null, error: null })
          }),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn(() => Promise.resolve({ data: null, error: null })),
      }
    },
  },
}))

vi.mock("@/lib/operations/portal", () => ({
  reconcileTier: vi.fn(() => Promise.resolve(reconcileResult)),
}))

import { POST } from "@/app/api/crm/admin-actions/reconcile-portal-tier/route"

// ─── Setup ──────────────────────────────────────────────

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/crm/admin-actions/reconcile-portal-tier", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  authUserFixture = { id: "admin-1", email: "admin@tonydurante.us" }
  isAdminReturn = true
  contactFixture = {
    id: "contact-1",
    full_name: "Test Contact",
    email: "contact@example.com",
    portal_tier: "active",
  }
  contactError = null
  reconcileResult = {
    success: true,
    contact_id: "contact-1",
    resolved_tier: "active",
    changed: { contact: false, accounts: [], auth_user: false },
    error: undefined,
  }
  lastActionLogInsert = null
})

// ─── Auth & validation ──────────────────────────────────

describe("reconcile-portal-tier — auth + validation", () => {
  it("returns 403 when not admin", async () => {
    isAdminReturn = false
    const res = await POST(makeRequest({ contact_id: "contact-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/admin access required/i)
  })

  it("returns 400 when contact_id is missing", async () => {
    const res = await POST(makeRequest({}) as Parameters<typeof POST>[0])
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/contact_id required/i)
  })

  it("returns 400 when target_tier is invalid", async () => {
    const res = await POST(
      makeRequest({ contact_id: "contact-1", target_tier: "super-duper" }) as Parameters<typeof POST>[0],
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid target_tier/i)
  })

  it("returns 404 when contact does not exist", async () => {
    contactFixture = null
    const res = await POST(makeRequest({ contact_id: "missing" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(404)
  })
})

// ─── reconcileTier delegation ───────────────────────────

describe("reconcile-portal-tier — reconcileTier success paths", () => {
  it("returns no-drift message when nothing changed", async () => {
    reconcileResult.changed = { contact: false, accounts: [], auth_user: false }
    const res = await POST(makeRequest({ contact_id: "contact-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.message).toMatch(/no drift/i)
    expect(body.resolved_tier).toBe("active")
  })

  it("summarises drift when contact + account + auth_user all changed", async () => {
    reconcileResult.changed = { contact: true, accounts: ["acc-1", "acc-2"], auth_user: true }
    const res = await POST(makeRequest({ contact_id: "contact-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toMatch(/reconciled/i)
    expect(body.message).toMatch(/contact/)
    expect(body.message).toMatch(/2 account\(s\)/)
    expect(body.message).toMatch(/auth user/)
  })

  it("summarises drift when only the contact changed", async () => {
    reconcileResult.changed = { contact: true, accounts: [], auth_user: false }
    const res = await POST(makeRequest({ contact_id: "contact-1" }) as Parameters<typeof POST>[0])
    const body = await res.json()
    expect(body.message).toMatch(/contact/)
    expect(body.message).not.toMatch(/account\(s\)/)
    expect(body.message).not.toMatch(/auth user/)
  })
})

describe("reconcile-portal-tier — reconcileTier failure", () => {
  it("returns 500 when reconcileTier fails", async () => {
    reconcileResult = { ...reconcileResult, success: false, error: "boom" }
    const res = await POST(makeRequest({ contact_id: "contact-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("boom")
  })
})

// ─── action_log ─────────────────────────────────────────

describe("reconcile-portal-tier — action_log", () => {
  it("writes an action_log row with actor + contact + tier details + reason", async () => {
    reconcileResult.changed = { contact: true, accounts: ["acc-1"], auth_user: false }
    await POST(
      makeRequest({
        contact_id: "contact-1",
        reason: "unit test reason",
      }) as Parameters<typeof POST>[0],
    )
    expect(lastActionLogInsert).not.toBeNull()
    expect(lastActionLogInsert).toMatchObject({
      action_type: "update",
      table_name: "contacts",
      record_id: "contact-1",
    })
    expect(lastActionLogInsert?.actor).toMatch(/^dashboard:/)
    const details = lastActionLogInsert?.details as Record<string, unknown>
    expect(details.contact_id).toBe("contact-1")
    expect(details.resolved_tier).toBe("active")
    expect(details.reason).toBe("unit test reason")
    expect(details.changed).toEqual({ contact: true, accounts: ["acc-1"], auth_user: false })
  })
})
