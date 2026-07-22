/**
 * lib/oa/public-view.ts — the field whitelist for the PUBLIC operating-agreement
 * pages.
 *
 * The bug these tests lock shut: both public OA pages ran `select('*')` on the
 * agreement and signature tables with the anon key, from the browser, and
 * compared the access code client-side — after the row had arrived. With
 * `USING (true)` policies and a token built from the company name plus the year,
 * one unauthenticated request returned every agreement's access code, tax ID,
 * member emails and addresses, plus each co-signer's personal signing code.
 *
 * A co-signer legitimately passes the access-code gate, so "the caller is
 * authorised" is NOT sufficient — the payload itself must carry no credential.
 * That is what is under test here.
 */

import { describe, it, expect } from "vitest"
import {
  OA_NEVER_EXPOSED,
  assertNoSecrets,
  emailGateFor,
  emailGateMatches,
  resolveSignerIndex,
  toPublicAgreement,
  toPublicSignature,
} from "@/lib/oa/public-view"

const agreementRow = {
  id: "oa-1",
  token: "acme-llc-oa-2026",
  access_code: "s3cr3t99",
  account_id: "acct-1",
  contact_id: "cont-1",
  company_name: "Acme LLC",
  state_of_formation: "Florida",
  formation_date: "2026-01-10",
  ein_number: "83-4299021",
  entity_type: "MMLLC",
  manager_name: "Member One",
  member_name: "Member One",
  member_address: "1 Main St",
  member_email: "one@example.com",
  member_ownership_pct: 50,
  members: [
    { name: "Member One", ownership_pct: 50, email: "one@example.com", address: "1 Main St", initial_contribution: "500" },
    { name: "Member Two", ownership_pct: 50, email: "two@example.com", address: "9 Oak Rd", initial_contribution: "500" },
  ],
  effective_date: "2026-01-10",
  business_purpose: "Consulting",
  initial_contribution: "1000",
  fiscal_year_end: "December 31",
  accounting_method: "Cash",
  duration: "Perpetual",
  registered_agent_name: "RA Inc",
  registered_agent_address: "2 Main St",
  principal_address: "1 Main St",
  status: "sent",
  language: "en",
  view_count: 3,
  viewed_at: "2026-07-01T00:00:00Z",
  signed_at: null,
  pdf_storage_path: null,
  total_signers: 2,
  signed_count: 0,
}

const signatureRows = [
  {
    id: "sig-0",
    oa_id: "oa-1",
    member_index: 0,
    member_name: "Member One",
    member_email: "one@example.com",
    access_code: "code-zero",
    status: "signed",
    signed_at: "2026-07-02T00:00:00Z",
    signature_image_path: "acme/sig-0.png",
    view_count: 2,
  },
  {
    id: "sig-1",
    oa_id: "oa-1",
    member_index: 1,
    member_name: "Member Two",
    member_email: "two@example.com",
    access_code: "code-one",
    status: "sent",
    signed_at: null,
    signature_image_path: null,
    view_count: 0,
  },
]

describe("toPublicAgreement", () => {
  it("carries no credential and no internal identifier", () => {
    const out = toPublicAgreement(agreementRow) as Record<string, unknown>
    for (const forbidden of OA_NEVER_EXPOSED) {
      expect(out).not.toHaveProperty(forbidden)
    }
  })

  it("still carries everything the document needs to render", () => {
    const out = toPublicAgreement(agreementRow)
    // If any of these went missing the agreement would render blank or wrong —
    // a silently incomplete legal document, which is its own harm.
    expect(out.company_name).toBe("Acme LLC")
    expect(out.ein_number).toBe("83-4299021")
    expect(out.members).toEqual([
      { name: "Member One", ownership_pct: 50, initial_contribution: "500" },
      { name: "Member Two", ownership_pct: 50, initial_contribution: "500" },
    ])
    expect(out.principal_address).toBe("1 Main St")
    expect(out.registered_agent_name).toBe("RA Inc")
    expect(out.effective_date).toBe("2026-01-10")
    expect(out.total_signers).toBe(2)
    expect(out.entity_type).toBe("MMLLC")
  })

  it("strips every member's email and address from the members blob", () => {
    // The nested blob is where a secret rides along unnoticed — this was found
    // by inspecting the route's REAL output, not by reading the mapper.
    // A co-signer passes the access-code gate legitimately; that does not
    // entitle them to the other members' contact details.
    const json = JSON.stringify(toPublicAgreement(agreementRow))
    expect(json).not.toContain("one@example.com")
    expect(json).not.toContain("two@example.com")
    expect(json).not.toContain("9 Oak Rd")
    expect(() => assertNoSecrets(toPublicAgreement(agreementRow))).not.toThrow()
  })

  it("survives a members blob that is null or not an array", () => {
    expect(toPublicAgreement({ ...agreementRow, members: null }).members).toBeNull()
    expect(toPublicAgreement({ ...agreementRow, members: undefined }).members).toBeNull()
  })

  it("defaults the counters rather than emitting undefined", () => {
    const out = toPublicAgreement({ ...agreementRow, view_count: null, signed_count: null, total_signers: null })
    expect(out.view_count).toBe(0)
    expect(out.signed_count).toBe(0)
    expect(out.total_signers).toBe(1)
  })
})

describe("toPublicSignature", () => {
  it("strips the per-member signing code — the credential that authorises signing AS that member", () => {
    const out = toPublicSignature(signatureRows[0]) as Record<string, unknown>
    expect(out).not.toHaveProperty("access_code")
    expect(out).not.toHaveProperty("member_email")
  })

  it("keeps what the page renders per member", () => {
    const out = toPublicSignature(signatureRows[0])
    expect(out.member_index).toBe(0)
    expect(out.member_name).toBe("Member One")
    expect(out.status).toBe("signed")
    expect(out.signature_image_path).toBe("acme/sig-0.png")
    expect(out.id).toBe("sig-0")
  })
})

describe("resolveSignerIndex", () => {
  it("resolves a valid per-member code", () => {
    expect(resolveSignerIndex(signatureRows, "code-one")).toBe(1)
    expect(resolveSignerIndex(signatureRows, "code-zero")).toBe(0)
  })

  it("returns null for an unknown code", () => {
    expect(resolveSignerIndex(signatureRows, "nope")).toBeNull()
  })

  it("NEVER resolves a blank code to member 0", () => {
    // The dangerous failure: a missing code silently landing on the first
    // member, letting anyone sign as them.
    expect(resolveSignerIndex(signatureRows, "")).toBeNull()
    expect(resolveSignerIndex(signatureRows, "   ")).toBeNull()
    expect(resolveSignerIndex(signatureRows, null)).toBeNull()
    expect(resolveSignerIndex(signatureRows, undefined)).toBeNull()
  })

  it("does not match a row whose code is null", () => {
    const rows = [{ member_index: 0, access_code: null }]
    expect(resolveSignerIndex(rows, "")).toBeNull()
    expect(resolveSignerIndex(rows, "anything")).toBeNull()
  })
})

describe("emailGateFor", () => {
  it("gates a co-signer on THEIR OWN address, not the primary member's", () => {
    // Getting this wrong would ask member two for member one's email.
    expect(emailGateFor(agreementRow, signatureRows, 1)).toBe("two@example.com")
  })

  it("falls back to the agreement's member when there is no current signer", () => {
    expect(emailGateFor(agreementRow, signatureRows, null)).toBe("one@example.com")
  })

  it("returns null when no address is on file — the gate is skipped, as before", () => {
    expect(emailGateFor({ ...agreementRow, member_email: null }, [], null)).toBeNull()
    expect(emailGateFor(agreementRow, [{ member_index: 1, member_email: null }], 1)).toBeNull()
  })
})

describe("emailGateMatches", () => {
  it("is case- and whitespace-tolerant", () => {
    expect(emailGateMatches("one@example.com", "  ONE@Example.com ")).toBe(true)
  })

  it("rejects a different address", () => {
    expect(emailGateMatches("one@example.com", "two@example.com")).toBe(false)
  })

  it("never passes when no address is on file, whatever was supplied", () => {
    // Fail closed: a null expectation must not become "anything matches".
    expect(emailGateMatches(null, "")).toBe(false)
    expect(emailGateMatches(null, "one@example.com")).toBe(false)
  })

  it("rejects empty or missing input", () => {
    expect(emailGateMatches("one@example.com", "")).toBe(false)
    expect(emailGateMatches("one@example.com", null)).toBe(false)
    expect(emailGateMatches("one@example.com", undefined)).toBe(false)
  })
})

describe("assertNoSecrets", () => {
  it("passes the real route payload", () => {
    expect(() =>
      assertNoSecrets({
        agreement: toPublicAgreement(agreementRow),
        signatures: signatureRows.map(toPublicSignature),
      }),
    ).not.toThrow()
  })

  it("catches a raw row spread anywhere in the payload, however deep", () => {
    // This is the regression it exists for: someone adds a field by spreading
    // the row instead of extending the mapper.
    expect(() => assertNoSecrets({ agreement: agreementRow })).toThrow(/access_code/)
    expect(() => assertNoSecrets({ signatures: signatureRows })).toThrow(/access_code/)
    expect(() => assertNoSecrets({ a: { b: [{ c: { member_email: "x@y.z" } }] } })).toThrow(/member_email/)
  })

  it("names every secret it found, not just the first", () => {
    const err = (() => {
      try {
        assertNoSecrets(agreementRow)
        return ""
      } catch (e) {
        return (e as Error).message
      }
    })()
    expect(err).toContain("access_code")
    expect(err).toContain("member_email")
    expect(err).toContain("account_id")
  })

  it("handles null and primitives without throwing", () => {
    expect(() => assertNoSecrets(null)).not.toThrow()
    expect(() => assertNoSecrets("string")).not.toThrow()
    expect(() => assertNoSecrets(42)).not.toThrow()
  })
})
