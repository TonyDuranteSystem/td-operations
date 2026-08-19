/**
 * lib/members/resolve-signer.ts unit tests.
 *
 * Pins the fix for dev job 9ad76300-6181-4250-a1de-c77f37933f82: Prowave LLC's signed lease named Marco
 * Pasetto (representative of the 99% company member, Indaco LTD) instead of
 * Matteo Mangili (1% individual, flagged is_primary + is_signer, also the
 * EIN responsible party) — because the old code picked an unordered
 * account_contacts row and never looked at the members table at all.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let accountRow: { id: string; company_name: string; entity_type: string | null; member_structure?: string | null } | null = null
let membersRows: Array<{
  member_type: string
  full_name: string | null
  company_name: string | null
  contact_id: string | null
  representative_name: string | null
  representative_email: string | null
  email?: string | null
  is_primary: boolean | null
  is_signer: boolean | null
}> = []
let accountContactLinks: Array<{ contact_id: string; role?: string | null }> = []
let contactsById: Record<string, { id: string; full_name: string; email: string | null }> = {}
// Emails that resolve to MORE THAN ONE contact — simulates a real duplicate
// contact record, which PostgREST's .maybeSingle() surfaces as an error, not
// an empty result.
let ambiguousEmails: Set<string> = new Set()
// Records every contacts-table email lookup (scoped vs unscoped) so a test
// can prove the SCOPED branch alone decided the outcome, rather than just
// asserting a final result the unscoped fallback could equally have produced.
let contactsEmailQueryLog: Array<{ scoped: boolean }> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const filters: Record<string, string | number> = {}
      let inCol: string | undefined
      let inVals: string[] = []
      let emailIlikeTarget: string | undefined

      Object.assign(chain, {
        select: vi.fn(() => chain),
        eq: vi.fn((col: string, value: string | number) => {
          filters[col] = value
          return chain
        }),
        // Mirrors resolve-signer.ts's real query: a %-wrapped, backslash-escaped
        // pattern. Unwrap it back to the plain (already trimmed+lowercased)
        // target the production code searched for.
        ilike: vi.fn((col: string, pattern: string) => {
          if (col === "email") emailIlikeTarget = pattern.slice(1, -1).replace(/\\(.)/g, "$1")
          return chain
        }),
        in: vi.fn((col: string, vals: string[]) => {
          inCol = col
          inVals = vals
          return chain
        }),
        order: vi.fn(() => chain),
        maybeSingle: vi.fn(() => Promise.resolve(resolveValue())),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      })

      function resolveValue() {
        if (table === "accounts") {
          return { data: accountRow, error: null }
        }
        if (table === "members") {
          return { data: membersRows, error: null }
        }
        if (table === "account_contacts") {
          return { data: accountContactLinks, error: null }
        }
        if (table === "contacts") {
          if (emailIlikeTarget !== undefined) {
            contactsEmailQueryLog.push({ scoped: inCol === "id" })
            // A real duplicate-contact shape: the DB genuinely returns 2+
            // rows for this email, regardless of scope.
            if (ambiguousEmails.has(emailIlikeTarget)) {
              return { data: [{ id: "dup-1", email: emailIlikeTarget }, { id: "dup-2", email: emailIlikeTarget }], error: null }
            }
            const pool = inCol === "id"
              ? inVals.map((id) => contactsById[id]).filter((c): c is { id: string; full_name: string; email: string | null } => !!c)
              : Object.values(contactsById)
            // ILIKE is a broad %contains% match; the real equality check
            // (trim + lowercase on both sides) happens in resolve-signer.ts
            // itself after this returns — the mock only needs to return the
            // candidate superset a real ILIKE query would surface.
            const matches = pool.filter((c) => (c.email ?? "").trim().toLowerCase().includes(emailIlikeTarget as string))
            return { data: matches, error: null }
          }
          if (filters.id) {
            const c = contactsById[filters.id as string]
            return { data: c ?? null, error: null }
          }
        }
        return { data: null, error: null }
      }

      return chain
    },
  },
}))

beforeEach(() => {
  accountRow = { id: "acct-prowave", company_name: "Prowave LLC", entity_type: "Multi Member LLC" }
  membersRows = []
  accountContactLinks = []
  contactsById = {}
  ambiguousEmails = new Set()
  contactsEmailQueryLog = []
})

// ─── THE PROWAVE CASE ────────────────────────────────────

describe("resolveAccountSigner — Prowave LLC (the reported incident)", () => {
  beforeEach(() => {
    // Matteo Mangili: 1% individual, flagged primary + signer.
    // Indaco LTD: 99% company member, repped by Marco Pasetto — NOT flagged.
    membersRows = [
      { member_type: "individual", full_name: "Matteo Mangili", company_name: null, contact_id: "matteo-id", representative_name: null, representative_email: null, is_primary: true, is_signer: true },
      { member_type: "company", full_name: null, company_name: "Indaco LTD", contact_id: "marco-id", representative_name: "Marco Pasetto", representative_email: "info@sheltax.com", is_primary: false, is_signer: false },
    ]
    // account_contacts row order is Marco FIRST — reproducing exactly what the
    // old unordered .limit(1) pick would have returned.
    accountContactLinks = [
      { contact_id: "marco-id", role: "Member" },
      { contact_id: "matteo-id", role: "Member" },
    ]
    contactsById = {
      "matteo-id": { id: "matteo-id", full_name: "Matteo Mangili", email: "info@matteomangili.com" },
      "marco-id": { id: "marco-id", full_name: "Marco Pasetto", email: "info@sheltax.com" },
    }
  })

  it("resolves to Matteo, not Marco — the exact fix", async () => {
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") {
      expect(result.contact.id).toBe("matteo-id")
      expect(result.contact.full_name).toBe("Matteo Mangili")
    }
  })

  it("order of member rows in the query result does not change the answer", async () => {
    membersRows = [...membersRows].reverse()
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.contact.id).toBe("matteo-id")
  })
})

// ─── Company member with contact_id vs representative-email fallback ──

describe("resolveAccountSigner — company member as the flagged signer", () => {
  it("resolves via the member row's own contact_id first", async () => {
    membersRows = [
      { member_type: "company", full_name: null, company_name: "Holdings LLC", contact_id: "rep-id", representative_name: "Rep Name", representative_email: "rep@holdings.com", is_primary: true, is_signer: true },
      { member_type: "individual", full_name: "Minority Owner", company_name: null, contact_id: "minor-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
    ]
    contactsById = { "rep-id": { id: "rep-id", full_name: "Rep Name", email: "rep@holdings.com" } }
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.contact.id).toBe("rep-id")
  })

  it("falls back to representative_email, SCOPED to this account's linked contacts first", async () => {
    membersRows = [
      { member_type: "company", full_name: null, company_name: "Holdings LLC", contact_id: null, representative_name: "Rep Name", representative_email: "rep@holdings.com", is_primary: true, is_signer: true },
      { member_type: "individual", full_name: "Minority Owner", company_name: null, contact_id: "minor-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
    ]
    // Two contacts share the same email — one is linked to THIS account, one
    // belongs to a different client relationship entirely. Must pick the one
    // actually linked to this account.
    accountContactLinks = [{ contact_id: "rep-linked-id", role: "Member" }]
    contactsById = {
      "rep-linked-id": { id: "rep-linked-id", full_name: "Rep Name (this account)", email: "rep@holdings.com" },
      "rep-other-client-id": { id: "rep-other-client-id", full_name: "Rep Name (a different client)", email: "rep@holdings.com" },
    }
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.contact.id).toBe("rep-linked-id")
  })

  it("a company member with neither contact_id nor a resolvable representative blocks, never silently guesses", async () => {
    membersRows = [
      { member_type: "company", full_name: null, company_name: "Ghost Holdings LLC", contact_id: null, representative_name: null, representative_email: null, is_primary: true, is_signer: true },
      { member_type: "individual", full_name: "Minority Owner", company_name: null, contact_id: "minor-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
    ]
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("blocked")
    if (result.outcome === "blocked") expect(result.message).toContain("Ghost Holdings LLC")
  })
})

// ─── Individual member with no contact_id but a real email (2026-08-19 fix) ──
// formation-materialize.ts writes members.email unconditionally, and it is
// NOT the same thing as having a linked contact_id. 6 real, active accounts
// had this shape and would have blocked outright before this fix.

describe("resolveAccountSigner — individual flagged signer with no contact_id but a real email", () => {
  it("resolves via the member's own email, scoped to the account", async () => {
    membersRows = [
      { member_type: "individual", full_name: "No-Contact Signer", company_name: null, contact_id: null, representative_name: null, representative_email: null, email: "signer@example.com", is_primary: true, is_signer: true },
      { member_type: "individual", full_name: "Other Owner", company_name: null, contact_id: "other-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
    ]
    accountContactLinks = [{ contact_id: "signer-linked-id" }]
    contactsById = { "signer-linked-id": { id: "signer-linked-id", full_name: "No-Contact Signer", email: "signer@example.com" } }
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.contact.id).toBe("signer-linked-id")
  })

  it("still blocks (never guesses) when the individual has neither contact_id nor email", async () => {
    membersRows = [
      { member_type: "individual", full_name: "Ghost Signer", company_name: null, contact_id: null, representative_name: null, representative_email: null, email: null, is_primary: true, is_signer: true },
      { member_type: "individual", full_name: "Other Owner", company_name: null, contact_id: "other-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
    ]
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("blocked")
    if (result.outcome === "blocked") expect(result.message).toContain("Ghost Signer")
  })
})

// ─── Ambiguous email lookup — never silently treat as "no match" ──────────

describe("resolveAccountSigner — an email shared by two contacts blocks instead of guessing which one", () => {
  it("company representative email matching 2+ contacts blocks with a clear message", async () => {
    membersRows = [
      { member_type: "company", full_name: null, company_name: "Shared Rep Holdings LLC", contact_id: null, representative_name: "Shared Rep", representative_email: "shared@example.com", is_primary: true, is_signer: true },
    ]
    ambiguousEmails = new Set(["shared@example.com"])
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("blocked")
    if (result.outcome === "blocked") expect(result.message).toContain("more than one contact")
  })

  it("individual member email matching 2+ contacts blocks with a clear message", async () => {
    membersRows = [
      { member_type: "individual", full_name: "Duplicate Email Owner", company_name: null, contact_id: null, representative_name: null, representative_email: null, email: "dup@example.com", is_primary: true, is_signer: true },
    ]
    ambiguousEmails = new Set(["dup@example.com"])
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("blocked")
    // Pre-fix, an individual member had no email fallback at all and blocked
    // anyway ("no linked contact or representative on file") — so the
    // outcome alone doesn't prove the ambiguity path fired. The message must
    // name the real reason.
    if (result.outcome === "blocked") expect(result.message).toContain("more than one contact")
  })

  it("blocks on the SCOPED lookup too, not just the unscoped fallback", async () => {
    // Both tests above leave accountContactLinks empty, so linkedIds.length
    // is 0 and only the unscoped branch ever runs. A real account with a
    // linked contact sharing the flagged member's email must be caught by
    // the scoped query itself (dev job 9ad76300-6181-4250-a1de-c77f37933f82, second-pass gap).
    //
    // The mock's ambiguousEmails simulation answers a duplicate regardless
    // of scope (by design — see its comment above), so the final outcome
    // alone does NOT prove the SCOPED branch specifically caught this: if
    // the scoped check were deleted, execution would fall through to the
    // unscoped query, which the mock would ALSO answer with a duplicate,
    // producing the identical "blocked" result (Bug-Hunter, third pass —
    // this test previously could not fail even with the scoped check
    // removed). contactsEmailQueryLog proves the scoped query ran ALONE —
    // the function returned before the unscoped fallback was ever reached.
    membersRows = [
      { member_type: "individual", full_name: "Scoped Duplicate Owner", company_name: null, contact_id: null, representative_name: null, representative_email: null, email: "scoped-dup@example.com", is_primary: true, is_signer: true },
    ]
    accountContactLinks = [{ contact_id: "linked-1" }]
    ambiguousEmails = new Set(["scoped-dup@example.com"])
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(contactsEmailQueryLog).toEqual([{ scoped: true }])
    expect(result.outcome).toBe("blocked")
    if (result.outcome === "blocked") expect(result.message).toContain("more than one contact")
  })
})

// ─── Whitespace/case drift on a stored email (2026-08-19 fix, second pass) ──
// A real active account (Diendei LLC) has a leading space on its
// members.email row; the contact's own email is clean. A plain .eq() match
// silently read this as "no contact on file" instead of resolving.

describe("resolveAccountSigner — a member email with stray whitespace/case still resolves", () => {
  it("matches a linked contact whose email differs only by whitespace and case", async () => {
    membersRows = [
      { member_type: "individual", full_name: "Art", company_name: null, contact_id: null, representative_name: null, representative_email: null, email: " Art@Diendei.com", is_primary: true, is_signer: true },
    ]
    accountContactLinks = [{ contact_id: "art-contact-id" }]
    contactsById = { "art-contact-id": { id: "art-contact-id", full_name: "Art", email: "art@diendei.com" } }
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.contact.id).toBe("art-contact-id")
  })
})

// ─── Entity classification via member_structure (2026-08-19 fix) ──────────
// A multi-owner company whose entity_type text isn't "Multi Member LLC"
// (e.g. a multi-member C-Corp election) must still get the MMLLC blocking
// rule — matching the portal OA screen's own isMMLC test. 5 real accounts
// have this shape.

describe("resolveAccountSigner — member_structure classifies multi-owner non-LLC shapes as MMLLC", () => {
  beforeEach(() => {
    accountRow = { id: "acct-prowave", company_name: "Multi-Owner Corp", entity_type: "C-Corp Elected", member_structure: "multi_member" }
  })

  it("blocks on zero flagged signers even though entity_type text says C-Corp Elected", async () => {
    membersRows = [
      { member_type: "individual", full_name: "A", company_name: null, contact_id: "a-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
      { member_type: "individual", full_name: "B", company_name: null, contact_id: "b-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
    ]
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("blocked")
    // Pre-fix, entity_type text "C-Corp Elected" normalizes to itself (not
    // "MMLLC"), so decideSs4Signer never reaches its MMLLC branch — it takes
    // members[0] as a lone use_member pick, whose unmocked contact_id then
    // fails to resolve. That ALSO blocks, but with a "contact ... was not
    // found" message, not this one — the message is what actually proves
    // member_structure triggered the real MMLLC blocking rule.
    if (result.outcome === "blocked") expect(result.message).toContain("Flag exactly one member")
  })

  it("resolves the flagged signer normally when exactly one is flagged", async () => {
    membersRows = [
      { member_type: "individual", full_name: "Flagged Owner", company_name: null, contact_id: "flagged-id", representative_name: null, representative_email: null, is_primary: true, is_signer: true },
      { member_type: "individual", full_name: "Other Owner", company_name: null, contact_id: "other-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
    ]
    contactsById = { "flagged-id": { id: "flagged-id", full_name: "Flagged Owner", email: "flagged@example.com" } }
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.contact.id).toBe("flagged-id")
  })
})

// ─── Ambiguous MMLLC — never guess ────────────────────────

describe("resolveAccountSigner — ambiguous Multi-Member LLC blocks instead of guessing", () => {
  it("zero flagged signers → blocked", async () => {
    membersRows = [
      { member_type: "individual", full_name: "A", company_name: null, contact_id: "a-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
      { member_type: "individual", full_name: "B", company_name: null, contact_id: "b-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
    ]
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("blocked")
    if (result.outcome === "blocked") expect(result.message).toContain("Flag exactly one member")
  })

  it("two flagged signers → blocked", async () => {
    membersRows = [
      { member_type: "individual", full_name: "A", company_name: null, contact_id: "a-id", representative_name: null, representative_email: null, is_primary: true, is_signer: true },
      { member_type: "individual", full_name: "B", company_name: null, contact_id: "b-id", representative_name: null, representative_email: null, is_primary: true, is_signer: true },
    ]
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-prowave")
    expect(result.outcome).toBe("blocked")
  })
})

// ─── SMLLC / no members rows — role-aware default, never blocks ──

describe("resolveAccountSigner — no members rows (SMLLC / legacy)", () => {
  beforeEach(() => {
    accountRow = { id: "acct-smllc", company_name: "Solo LLC", entity_type: "Single Member LLC" }
    membersRows = []
  })

  it("uses the role-aware default over account_contacts, never blocks", async () => {
    accountContactLinks = [
      { contact_id: "rep-id", role: "authorized_representative" },
      { contact_id: "owner-id", role: "owner" },
    ]
    contactsById = {
      "rep-id": { id: "rep-id", full_name: "Rep", email: "rep@x.com" },
      "owner-id": { id: "owner-id", full_name: "Owner", email: "owner@x.com" },
    }
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-smllc")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.contact.id).toBe("owner-id")
  })

  it("no linked contacts at all → not_found (never blocked)", async () => {
    accountContactLinks = []
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("acct-smllc")
    expect(result.outcome).toBe("not_found")
  })
})

describe("resolveAccountSigner — account not found", () => {
  it("returns not_found", async () => {
    accountRow = null
    const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
    const result = await resolveAccountSigner("missing-acct")
    expect(result.outcome).toBe("not_found")
  })
})
