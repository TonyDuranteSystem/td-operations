import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * dev job fbbf4abe — post-build council review (senior-engineer, ai-architect,
 * bug-hunter, project-director) found the closure wizard resolved WHICH
 * company a client was closing from the ambient "current account" default,
 * not from anything specific to the closure itself. resolveClosureSubject()
 * is the fix: resolve from the client's own pending Company Closure record.
 */

let accountContactsRows: Array<{ account_id: string }> = []
let accountContactsLinkRows: Array<{ account_id: string; contact_id: string }> = []
let sdRows: Array<{ id: string; account_id: string | null; contact_id: string | null; created_at: string }> = []
let sdById: Record<string, { id: string; account_id: string | null; contact_id: string | null; service_type: string; status: string }> = {}
let accountRows: Record<string, { company_name: string; ein_number: string | null }> = {}
let lastSdOrFilter: string | null = null
let lastAccountContactsEq: string | null = null

// A minimal chainable, THENABLE query-builder stub. Real supabase-js query
// builders are awaitable directly (no explicit terminal call needed) — some
// call sites here rely on exactly that (resolveClosureSubject's single-eq
// account_contacts lookup), while others chain further and call
// .maybeSingle()/.order() explicitly. `resolve` is invoked lazily so it
// always sees the FULL set of accumulated .eq() calls, regardless of which
// path (bare await vs explicit terminal call) triggers it.
function chainable(resolve: () => { data: unknown }, onEq?: (col: string, val: string) => void) {
  const obj = {
    eq: (col: string, val: string) => { onEq?.(col, val); return obj },
    or: (filter: string) => { lastSdOrFilter = filter; return obj },
    order: () => Promise.resolve(resolve()),
    maybeSingle: () => Promise.resolve(resolve()),
    then: (onFulfilled: (v: { data: unknown }) => unknown) => Promise.resolve(resolve()).then(onFulfilled),
  }
  return obj
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "account_contacts") {
        return {
          select: (cols: string) => {
            if (cols !== "account_id") throw new Error(`unexpected account_contacts select: ${cols}`)
            // Both call shapes select "account_id" — distinguished by HOW MANY
            // .eq() filters accumulate before resolution: resolveClosureSubject
            // filters by contact_id alone and awaits directly (list result);
            // verifyClosureServiceDelivery filters by BOTH account_id and
            // contact_id and calls .maybeSingle() (single-row result).
            const eqCalls: Array<[string, string]> = []
            return chainable(
              () => {
                if (eqCalls.length >= 2) {
                  const acctVal = eqCalls.find(([c]) => c === "account_id")?.[1]
                  const ctcVal = eqCalls.find(([c]) => c === "contact_id")?.[1]
                  return {
                    data:
                      accountContactsLinkRows.find(
                        (r) => r.account_id === acctVal && r.contact_id === ctcVal,
                      ) ?? null,
                  }
                }
                return { data: accountContactsRows }
              },
              (col, val) => {
                eqCalls.push([col, val])
                if (col === "contact_id") lastAccountContactsEq = val
              },
            )
          },
        }
      }
      if (table === "service_deliveries") {
        return {
          select: () => {
            let matchedId: string | null = null
            return chainable(
              () => (matchedId ? { data: sdById[matchedId] ?? null } : { data: sdRows }),
              (col, val) => { if (col === "id") matchedId = val },
            )
          },
        }
      }
      if (table === "accounts") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: () => Promise.resolve({ data: accountRows[id] ?? null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  },
}))

import { resolveClosureSubject, verifyClosureServiceDelivery } from "@/lib/portal/closure-subject"

describe("resolveClosureSubject", () => {
  beforeEach(() => {
    accountContactsRows = []
    accountContactsLinkRows = []
    sdRows = []
    sdById = {}
    accountRows = {}
    lastSdOrFilter = null
    lastAccountContactsEq = null
  })

  it("returns 'none' when the contact has no pending closure at all", async () => {
    const result = await resolveClosureSubject("contact-1")
    expect(result.kind).toBe("none")
  })

  it("resolves the single pending closure, pulling the company name/EIN from the linked account", async () => {
    accountContactsRows = [{ account_id: "acct-a" }]
    sdRows = [{ id: "sd-1", account_id: "acct-a", contact_id: null, created_at: "2026-06-01" }]
    accountRows = { "acct-a": { company_name: "Acme LLC", ein_number: "11-1111111" } }

    const result = await resolveClosureSubject("contact-1")
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.serviceDeliveryId).toBe("sd-1")
      expect(result.accountId).toBe("acct-a")
      expect(result.companyName).toBe("Acme LLC")
      expect(result.ein).toBe("11-1111111")
    }
  })

  it("does NOT prefill a company name/EIN for a contact-only (untracked LLC) closure", async () => {
    sdRows = [{ id: "sd-2", account_id: null, contact_id: "contact-1", created_at: "2026-06-01" }]

    const result = await resolveClosureSubject("contact-1")
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.accountId).toBeNull()
      expect(result.companyName).toBeNull()
      expect(result.ein).toBeNull()
    }
  })

  it("flags ambiguity (never silently picks) when 2+ pending closures exist, but still returns a usable choice", async () => {
    accountContactsRows = [{ account_id: "acct-a" }, { account_id: "acct-b" }]
    sdRows = [
      { id: "sd-newer", account_id: "acct-b", contact_id: null, created_at: "2026-08-01" },
      { id: "sd-older", account_id: "acct-a", contact_id: null, created_at: "2026-06-01" },
    ]
    accountRows = {
      "acct-a": { company_name: "Old Co LLC", ein_number: null },
      "acct-b": { company_name: "New Co LLC", ein_number: null },
    }

    const result = await resolveClosureSubject("contact-1")
    expect(result.kind).toBe("ambiguous")
    if (result.kind === "ambiguous") {
      expect(result.otherCount).toBe(1)
      expect(result.chosen.serviceDeliveryId).toBe("sd-newer")
    }
  })

  it("checks membership via the raw account_contacts link, not a status-filtered account list", async () => {
    accountContactsRows = [{ account_id: "acct-delinquent" }]
    sdRows = [{ id: "sd-3", account_id: "acct-delinquent", contact_id: null, created_at: "2026-06-01" }]
    accountRows = { "acct-delinquent": { company_name: "Delinquent LLC", ein_number: null } }

    const result = await resolveClosureSubject("contact-1")
    expect(result.kind).toBe("resolved")
    expect(lastAccountContactsEq).toBe("contact-1")
    // The account lookup itself never filters by status — proven by the mock
    // returning a row for an account that would be excluded from
    // getPortalAccounts()'s Active/Suspended filter.
    if (result.kind === "resolved") {
      expect(result.companyName).toBe("Delinquent LLC")
    }
  })

  it("includes the contact-only branch in the service_deliveries filter even with no linked accounts", async () => {
    sdRows = []
    await resolveClosureSubject("contact-1")
    expect(lastSdOrFilter).toContain("contact_id.eq.contact-1")
  })
})

describe("verifyClosureServiceDelivery — submit-time re-check (Senior Engineer finding)", () => {
  beforeEach(() => {
    accountContactsLinkRows = []
    sdById = {}
  })

  it("accepts a genuinely active, account-linked closure the contact is actually a member of", async () => {
    sdById["sd-1"] = { id: "sd-1", account_id: "acct-a", contact_id: null, service_type: "Company Closure", status: "active" }
    accountContactsLinkRows = [{ account_id: "acct-a", contact_id: "contact-1" }]

    const result = await verifyClosureServiceDelivery("sd-1", "contact-1")
    expect(result).toEqual({ accountId: "acct-a" })
  })

  it("refuses a record that does not exist at all (tampered/guessed id)", async () => {
    const result = await verifyClosureServiceDelivery("sd-nonexistent", "contact-1")
    expect(result).toBeNull()
  })

  it("refuses a CANCELLED closure — a stale link must never resurrect a matter staff already closed out", async () => {
    sdById["sd-1"] = { id: "sd-1", account_id: "acct-a", contact_id: null, service_type: "Company Closure", status: "cancelled" }
    accountContactsLinkRows = [{ account_id: "acct-a", contact_id: "contact-1" }]

    const result = await verifyClosureServiceDelivery("sd-1", "contact-1")
    expect(result).toBeNull()
  })

  it("refuses a COMPLETED closure the same way", async () => {
    sdById["sd-1"] = { id: "sd-1", account_id: "acct-a", contact_id: null, service_type: "Company Closure", status: "completed" }
    accountContactsLinkRows = [{ account_id: "acct-a", contact_id: "contact-1" }]

    expect(await verifyClosureServiceDelivery("sd-1", "contact-1")).toBeNull()
  })

  it("refuses an account-linked closure the contact is NOT actually a member of (cross-company tamper)", async () => {
    sdById["sd-1"] = { id: "sd-1", account_id: "acct-a", contact_id: null, service_type: "Company Closure", status: "active" }
    accountContactsLinkRows = [] // contact-1 is linked to nothing

    expect(await verifyClosureServiceDelivery("sd-1", "contact-1")).toBeNull()
  })

  it("accepts a genuinely active, contact-only closure that belongs to this exact contact", async () => {
    sdById["sd-2"] = { id: "sd-2", account_id: null, contact_id: "contact-1", service_type: "Company Closure", status: "active" }

    const result = await verifyClosureServiceDelivery("sd-2", "contact-1")
    expect(result).toEqual({ accountId: null })
  })

  it("refuses a contact-only closure that belongs to a DIFFERENT contact", async () => {
    sdById["sd-2"] = { id: "sd-2", account_id: null, contact_id: "someone-else", service_type: "Company Closure", status: "active" }

    expect(await verifyClosureServiceDelivery("sd-2", "contact-1")).toBeNull()
  })

  it("refuses a record whose service_type is not Company Closure (wrong-type id supplied)", async () => {
    sdById["sd-3"] = { id: "sd-3", account_id: "acct-a", contact_id: null, service_type: "Company Formation", status: "active" }
    accountContactsLinkRows = [{ account_id: "acct-a", contact_id: "contact-1" }]

    expect(await verifyClosureServiceDelivery("sd-3", "contact-1")).toBeNull()
  })
})
