/**
 * Tests for lib/messaging/send-dispatcher.ts
 *
 * Verifies the provider routing logic without hitting any external service:
 *   - channel not found → error
 *   - provider = NULL → "not configured" error
 *   - unknown provider → "unknown" error
 *   - known provider (meta/twilio) → handler stub error ("not yet implemented")
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Must be hoisted before any import that touches supabase-admin
vi.mock("@/lib/supabase-admin", () => {
  const single = vi.fn()
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { supabaseAdmin: { from } }
})

import { supabaseAdmin } from "@/lib/supabase-admin"
import { dispatchWhatsAppMessage } from "@/lib/messaging/send-dispatcher"

function mockChannel(provider: string | null, dbError = false) {
  const single = vi.fn().mockResolvedValue(
    dbError
      ? { data: null, error: { message: "Not found" } }
      : { data: { provider }, error: null }
  )
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  ;(supabaseAdmin.from as ReturnType<typeof vi.fn>).mockReturnValue({ select })
  ;(supabaseAdmin.from as ReturnType<typeof vi.fn>)
    .mockReturnValue({ select })
  // wire the chain
  select.mockReturnValue({ eq })
  eq.mockReturnValue({ single })
  return { single, eq, select }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("dispatchWhatsAppMessage", () => {
  it("returns error when channel not found in DB", async () => {
    mockChannel(null, /* dbError */ true)
    const result = await dispatchWhatsAppMessage("123@c.us", "hi", "uuid-1")
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("not found")
  })

  it("returns 'not configured' error when provider is null", async () => {
    mockChannel(null)
    const result = await dispatchWhatsAppMessage("123@c.us", "hi", "uuid-1")
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("not configured")
  })

  it("returns 'unknown provider' error for an unrecognised provider", async () => {
    mockChannel("periskope")
    const result = await dispatchWhatsAppMessage("123@c.us", "hi", "uuid-1")
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("Unknown WhatsApp provider")
    expect((result as { ok: false; error: string }).error).toContain("periskope")
  })

  it("routes to meta stub and surfaces its 'not yet implemented' error", async () => {
    mockChannel("meta")
    const result = await dispatchWhatsAppMessage("123@c.us", "hi", "uuid-1")
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("not yet implemented")
  })

  it("routes to twilio stub and surfaces its 'not yet implemented' error", async () => {
    mockChannel("twilio")
    const result = await dispatchWhatsAppMessage("123@c.us", "hi", "uuid-1")
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("not yet implemented")
  })
})
