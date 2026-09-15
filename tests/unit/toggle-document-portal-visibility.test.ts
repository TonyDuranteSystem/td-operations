/**
 * app/(dashboard)/accounts/actions.ts — toggleDocumentPortalVisibility()
 * and listAccountContactsForDocumentResolution()
 *
 * Regression pin for dev job f1dc4048 / ece21c44 (2026-09-14): this is the
 * THIRD path that can flip a document's portal_visible to true — alongside
 * both branches of app/api/accounts/[id]/files/process-and-share — and it was
 * the one left unguarded when the fix first shipped. Live E2E testing caught
 * it: clicking this exact toggle on an already-indexed personal document with
 * no resolved owner silently shared it, bypassing the guard added to the
 * other two paths. Turning visibility OFF must never be blocked — hiding is
 * always safe.
 *
 * The `resolution` param (dev job dfc00bcf, following ece21c44) is the
 * guided-share picker's write path: it must write a resolved owner and flip
 * visibility in the SAME call — never as two separate saves, since an
 * interrupted two-step version was reviewed and rejected (see
 * components/documents/resolve-personal-document.tsx's module comment).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { email: "luca@tonydurante.us" } } }) },
  }),
}))

let documentRow: { category: number | null; contact_id: string | null } | null = null
let accountContactsRows: { contact_id: string | null }[] = []
let contactsRows: { id: string; full_name: string }[] = []
const contactsInFilters: string[][] = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "documents") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: documentRow, error: null }),
            }),
          }),
        }
      }
      if (table === "account_contacts") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: accountContactsRows, error: null }),
          }),
        }
      }
      if (table === "contacts") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) => {
              contactsInFilters.push(ids)
              return Promise.resolve({ data: contactsRows, error: null })
            },
          }),
        }
      }
      throw new Error(`unexpected table in test mock: ${table}`)
    },
  },
}))

const updateDocumentMock = vi.fn()
vi.mock("@/lib/operations/document", () => ({
  updateDocument: (params: Record<string, unknown>) => updateDocumentMock(params),
}))

beforeEach(() => {
  updateDocumentMock.mockReset()
  updateDocumentMock.mockResolvedValue({ success: true, outcome: "updated" })
  documentRow = null
  accountContactsRows = []
  contactsRows = []
  contactsInFilters.length = 0
})

describe("toggleDocumentPortalVisibility", () => {
  it("blocks turning ON visibility for a personal document with no resolved owner", async () => {
    documentRow = { category: 2, contact_id: null }
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-1", true)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/personal document/i)
    expect(updateDocumentMock).not.toHaveBeenCalled()
  })

  it("allows turning ON visibility for a personal document once it has a resolved owner", async () => {
    documentRow = { category: 2, contact_id: "contact-123" }
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-2", true)

    expect(result.success).toBe(true)
    expect(updateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "doc-2", patch: { portal_visible: true } })
    )
  })

  it("allows turning ON visibility for an ordinary, non-personal document", async () => {
    documentRow = { category: 1, contact_id: null }
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-3", true)

    expect(result.success).toBe(true)
    expect(updateDocumentMock).toHaveBeenCalledTimes(1)
  })

  it("never blocks turning OFF visibility, even for an unresolved personal document", async () => {
    documentRow = { category: 2, contact_id: null }
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-4", false)

    expect(result.success).toBe(true)
    expect(updateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "doc-4", patch: { portal_visible: false } })
    )
  })

  it("does not block when no document row is found (defers to updateDocument's own not-found handling)", async () => {
    documentRow = null
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-missing", true)

    expect(result.success).toBe(true)
    expect(updateDocumentMock).toHaveBeenCalledTimes(1)
  })
})

describe("toggleDocumentPortalVisibility — guided-share resolution param", () => {
  it("resolves an unresolved personal document by writing the chosen contact_id and sharing in the same write", async () => {
    documentRow = { category: 2, contact_id: null }
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-5", true, { contactId: "contact-9" })

    expect(result.success).toBe(true)
    expect(updateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "doc-5", patch: { portal_visible: true, contact_id: "contact-9" } })
    )
  })

  it("re-assigns the owner even when the document already had a different resolved contact_id", async () => {
    documentRow = { category: 2, contact_id: "old-contact" }
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-6", true, { contactId: "new-contact" })

    expect(result.success).toBe(true)
    expect(updateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { portal_visible: true, contact_id: "new-contact" } })
    )
  })

  it("lets staff explicitly override without picking a contact, and does not write a contact_id", async () => {
    documentRow = { category: 2, contact_id: null }
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-7", true, { overridePersonalCheck: true })

    expect(result.success).toBe(true)
    expect(updateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { portal_visible: true } })
    )
  })

  it("still blocks when overridePersonalCheck is false-ish and no contactId is supplied", async () => {
    documentRow = { category: 2, contact_id: null }
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-8", true, {})

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/personal document/i)
    expect(updateDocumentMock).not.toHaveBeenCalled()
  })

  it("passes the caller's expectedUpdatedAt through as the optimistic-lock guard", async () => {
    documentRow = { category: 2, contact_id: null }
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    await toggleDocumentPortalVisibility("doc-9", true, { contactId: "contact-1", expectedUpdatedAt: "2026-09-10T00:00:00Z" })

    expect(updateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ expected_updated_at: "2026-09-10T00:00:00Z" })
    )
  })

  it("turns a stale-write conflict into a friendly, actionable message instead of a raw outcome code", async () => {
    documentRow = { category: 2, contact_id: null }
    updateDocumentMock.mockResolvedValue({ success: false, outcome: "stale", error: "updated_at mismatch" })
    const { toggleDocumentPortalVisibility } = await import("@/app/(dashboard)/accounts/actions")

    const result = await toggleDocumentPortalVisibility("doc-10", true, { contactId: "contact-1" })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already updated|refresh/i)
  })
})

describe("listAccountContactsForDocumentResolution", () => {
  it("returns an empty list without querying contacts when the account has no linked contacts", async () => {
    accountContactsRows = []
    const { listAccountContactsForDocumentResolution } = await import("@/app/(dashboard)/accounts/actions")

    const result = await listAccountContactsForDocumentResolution("acct-1")

    expect(result).toEqual([])
    expect(contactsInFilters).toHaveLength(0)
  })

  it("returns every contact linked to the account", async () => {
    accountContactsRows = [{ contact_id: "contact-1" }, { contact_id: "contact-2" }]
    contactsRows = [
      { id: "contact-1", full_name: "Jane Smith" },
      { id: "contact-2", full_name: "John Doe" },
    ]
    const { listAccountContactsForDocumentResolution } = await import("@/app/(dashboard)/accounts/actions")

    const result = await listAccountContactsForDocumentResolution("acct-2")

    expect(result).toEqual(contactsRows)
    expect(contactsInFilters[0]).toEqual(["contact-1", "contact-2"])
  })

  it("filters out links with no contact_id before querying contacts", async () => {
    accountContactsRows = [{ contact_id: "contact-1" }, { contact_id: null }]
    contactsRows = [{ id: "contact-1", full_name: "Jane Smith" }]
    const { listAccountContactsForDocumentResolution } = await import("@/app/(dashboard)/accounts/actions")

    await listAccountContactsForDocumentResolution("acct-3")

    expect(contactsInFilters[0]).toEqual(["contact-1"])
  })
})
