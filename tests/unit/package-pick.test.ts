/**
 * Unit tests for multi-option offers (dev job 3c1bb5fa) —
 * lib/offers/package-pick.ts.
 *
 * validatePackages: pure function, tested directly against every required
 * field (Antonio's rule: both renewal installments are mandatory, not just
 * price/state/entity-type).
 *
 * lockPackagePick / resetPackagePick: supabaseAdmin is mocked per-table,
 * following the chain-mock convention already used in
 * tests/unit/onboarding-account-upgrade.test.ts. Covers the race-losing
 * branch twice — once where the SAME key already won (idempotent retry) and
 * once where a DIFFERENT key won (genuine conflict) — because those two
 * outcomes must be told apart, unlike the admin-only claim pattern this
 * borrows its atomicity from.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: vi.fn() }))

/** Controllable stand-ins for the credit re-resolution lockPackagePick does at
 *  lock time (bug-hunter blocker: a held credit must be re-checked in the
 *  PICKED package's own currency, never the offer's stale placeholder one). */
let mockResolveCreditSubjectResult: unknown = { kind: "no_email" }
let mockAvailableCredit: { amount: number; creditId: string | null; kind: string | null } = {
  amount: 0,
  creditId: null,
  kind: null,
}
let mockAvailableCreditThrows = false
let resolveCreditSubjectCalls = 0
let availableCreditForDisplayCalls: Array<{ scope: unknown; currency: string }> = []

vi.mock("@/lib/operations/credit-subject", () => ({
  resolveCreditSubject: vi.fn(async () => {
    resolveCreditSubjectCalls += 1
    return mockResolveCreditSubjectResult
  }),
  subjectForDisplay: (subject: { kind: string; contactId?: string }) =>
    subject && subject.kind === "resolved" ? subject.contactId ?? null : null,
}))

vi.mock("@/lib/operations/credit-netting", () => ({
  availableCreditForDisplay: vi.fn(async (scope: unknown, currency: string) => {
    availableCreditForDisplayCalls.push({ scope, currency })
    if (mockAvailableCreditThrows) throw new Error("credit lookup boom")
    return mockAvailableCredit
  }),
}))

let offerFixture: Record<string, unknown> | null = null
let offerFetchError: { message: string } | null = null
let lastUpdatePatch: Record<string, unknown> | null = null
let lastEqArgs: [string, unknown] | null = null
let lastIsArgs: [string, unknown] | null = null
let lastNotArgs: [string, string, unknown] | null = null
let claimedRows: Array<{ token: string }> | null = null
let claimError: { message: string } | null = null
/** The row returned by the re-fetch after a lost race. */
let refetchFixture: Record<string, unknown> | null = null
/** Distinguishes the FIRST select (fetch packages) from the SECOND (re-fetch after a lost race). */
let selectCallCount = 0

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "offers") {
        const stub: Record<string, unknown> = {}
        stub.select = () => stub
        stub.eq = () => stub
        stub.maybeSingle = () => Promise.resolve({ data: null, error: null })
        return stub
      }
      return {
        select: () => {
          selectCallCount += 1
          const chain: Record<string, unknown> = {}
          chain.eq = () => chain
          chain.maybeSingle = () =>
            Promise.resolve(
              selectCallCount === 1
                ? { data: offerFixture, error: offerFetchError }
                : { data: refetchFixture, error: null },
            )
          return chain
        },
        update: (patch: Record<string, unknown>) => {
          lastUpdatePatch = patch
          const chain: Record<string, unknown> = {}
          chain.eq = (col: string, val: unknown) => {
            lastEqArgs = [col, val]
            return chain
          }
          chain.is = (col: string, val: unknown) => {
            lastIsArgs = [col, val]
            return chain
          }
          chain.not = (col: string, op: string, val: unknown) => {
            lastNotArgs = [col, op, val]
            return chain
          }
          chain.select = () => Promise.resolve({ data: claimedRows, error: claimError })
          // resetPackagePick awaits the chain directly (no trailing .select()) —
          // make the chain itself thenable so that call shape resolves too.
          chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            Promise.resolve({ data: null, error: claimError }).then(resolve, reject)
          return chain
        },
      }
    },
  },
}))

import { validatePackages, lockPackagePick, resetPackagePick } from "@/lib/offers/package-pick"

const VALID_PACKAGE_1 = {
  key: "wy-smllc",
  label: "Wyoming — Single-Member LLC",
  currency: "EUR",
  entity_type: "SMLLC",
  formation_state: "WY",
  services: [{ name: "Company Formation", price: "€2500" }],
  cost_summary: [{ label: "Setup Fee", total: "€2500", items: [{ name: "Company Formation", price: "€2500" }] }],
  recurring_costs: [
    { label: "1st Installment (January)", price: "$1000", currency: "USD" },
    { label: "2nd Installment (June)", price: "$1000", currency: "USD" },
  ],
  installment_currency: "USD",
}

const VALID_PACKAGE_2 = {
  ...VALID_PACKAGE_1,
  key: "fl-mmllc",
  label: "Florida — Multi-Member LLC",
  currency: "USD",
  entity_type: "MMLLC",
  formation_state: "FL",
  services: [{ name: "Company Formation", price: "$3500" }],
  cost_summary: [{ label: "Setup Fee", total: "$3500", items: [{ name: "Company Formation", price: "$3500" }] }],
}

describe("validatePackages", () => {
  it("accepts null/undefined — the ordinary single-option offer", () => {
    expect(validatePackages(null)).toBeNull()
    expect(validatePackages(undefined)).toBeNull()
  })

  it("accepts an empty array", () => {
    expect(validatePackages([])).toBeNull()
  })

  it("refuses a single package — one option is a config mistake, not a feature", () => {
    expect(validatePackages([VALID_PACKAGE_1])).toMatch(/at least 2/)
  })

  it("accepts two complete packages", () => {
    expect(validatePackages([VALID_PACKAGE_1, VALID_PACKAGE_2])).toBeNull()
  })

  it("refuses duplicate keys", () => {
    const err = validatePackages([VALID_PACKAGE_1, { ...VALID_PACKAGE_2, key: VALID_PACKAGE_1.key }])
    expect(err).toMatch(/duplicate key/)
  })

  it("refuses a missing label", () => {
    const err = validatePackages([VALID_PACKAGE_1, { ...VALID_PACKAGE_2, label: "" }])
    expect(err).toMatch(/label/)
  })

  it("refuses a missing/unrecognized entity type", () => {
    const err = validatePackages([VALID_PACKAGE_1, { ...VALID_PACKAGE_2, entity_type: "Nonsense" }])
    expect(err).toMatch(/company type/)
  })

  it("refuses a missing/unrecognized US state", () => {
    const err = validatePackages([VALID_PACKAGE_1, { ...VALID_PACKAGE_2, formation_state: "Nowhere" }])
    expect(err).toMatch(/US state/)
  })

  it("refuses a missing currency", () => {
    const err = validatePackages([VALID_PACKAGE_1, { ...VALID_PACKAGE_2, currency: "" }])
    expect(err).toMatch(/currency/)
  })

  it("refuses a package with no price anywhere", () => {
    const err = validatePackages([
      VALID_PACKAGE_1,
      { ...VALID_PACKAGE_2, services: [], cost_summary: [{ label: "Setup Fee" }] },
    ])
    expect(err).toMatch(/price/)
  })

  it("refuses a package missing the 1st (January) renewal installment", () => {
    const err = validatePackages([
      VALID_PACKAGE_1,
      { ...VALID_PACKAGE_2, recurring_costs: [{ label: "2nd Installment (June)", price: "$1250" }] },
    ])
    expect(err).toMatch(/1st \(January\)/)
  })

  it("refuses a package missing the 2nd (June) renewal installment — Antonio's explicit rule", () => {
    const err = validatePackages([
      VALID_PACKAGE_1,
      { ...VALID_PACKAGE_2, recurring_costs: [{ label: "1st Installment (January)", price: "$1250" }] },
    ])
    expect(err).toMatch(/2nd \(June\)/)
  })
})

describe("lockPackagePick", () => {
  beforeEach(() => {
    offerFixture = null
    offerFetchError = null
    lastUpdatePatch = null
    lastEqArgs = null
    lastIsArgs = null
    claimedRows = null
    claimError = null
    refetchFixture = null
    selectCallCount = 0
    mockResolveCreditSubjectResult = { kind: "no_email" }
    mockAvailableCredit = { amount: 0, creditId: null, kind: null }
    mockAvailableCreditThrows = false
    resolveCreditSubjectCalls = 0
    availableCreditForDisplayCalls = []
  })

  it("refuses when the offer doesn't exist", async () => {
    offerFetchError = { message: "not found" }
    const res = await lockPackagePick({ token: "ghost", packageKey: "wy-smllc" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("not_found")
  })

  it("refuses when the offer has no packages", async () => {
    offerFixture = { token: "t1", packages: null }
    const res = await lockPackagePick({ token: "t1", packageKey: "wy-smllc" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("no_packages")
  })

  it("refuses an unknown package key", async () => {
    offerFixture = { token: "t1", packages: [VALID_PACKAGE_1, VALID_PACKAGE_2] }
    const res = await lockPackagePick({ token: "t1", packageKey: "does-not-exist" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("unknown_package")
  })

  it("locks the pick and writes the picked package onto the offer's real columns", async () => {
    offerFixture = { token: "t1", packages: [VALID_PACKAGE_1, VALID_PACKAGE_2] }
    claimedRows = [{ token: "t1" }]

    const res = await lockPackagePick({ token: "t1", packageKey: "fl-mmllc" })

    expect(res.success).toBe(true)
    expect(res.outcome).toBe("locked")
    expect(res.selected_package_key).toBe("fl-mmllc")

    // The guard is a compare-and-swap on package_locked_at IS NULL — not merely
    // "no database error" (the mistake this codebase's own blessed example
    // makes elsewhere).
    expect(lastIsArgs).toEqual(["package_locked_at", null])
    expect(lastEqArgs).toEqual(["token", "t1"])

    expect(lastUpdatePatch).toMatchObject({
      selected_package_key: "fl-mmllc",
      entity_type: "Multi Member LLC",
      formation_state: "FL",
      currency: "USD",
      services: VALID_PACKAGE_2.services,
      cost_summary: VALID_PACKAGE_2.cost_summary,
    })
    // Bank details resolved fresh, "auto", from the PICKED package's own
    // currency — never a stale/placeholder value.
    expect((lastUpdatePatch as { bank_details: { bank_name: string } }).bank_details.bank_name).toMatch(/Relay/)
  })

  it("on a lost race where THIS SAME pick already won, reports success (idempotent retry)", async () => {
    offerFixture = { token: "t1", packages: [VALID_PACKAGE_1, VALID_PACKAGE_2] }
    claimedRows = [] // lost the race
    refetchFixture = { selected_package_key: "wy-smllc" }

    const res = await lockPackagePick({ token: "t1", packageKey: "wy-smllc" })

    expect(res.success).toBe(true)
    expect(res.outcome).toBe("already_locked_same")
  })

  it("on a lost race where a DIFFERENT pick already won, refuses with a real conflict", async () => {
    offerFixture = { token: "t1", packages: [VALID_PACKAGE_1, VALID_PACKAGE_2] }
    claimedRows = [] // lost the race
    refetchFixture = { selected_package_key: "fl-mmllc" }

    const res = await lockPackagePick({ token: "t1", packageKey: "wy-smllc" })

    expect(res.success).toBe(false)
    expect(res.outcome).toBe("already_locked_different")
    expect(res.selected_package_key).toBe("fl-mmllc")
  })

  it("surfaces a database error from the claim attempt", async () => {
    offerFixture = { token: "t1", packages: [VALID_PACKAGE_1, VALID_PACKAGE_2] }
    claimError = { message: "connection reset" }
    const res = await lockPackagePick({ token: "t1", packageKey: "wy-smllc" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("error")
  })

  it("re-resolves held credit fresh, in the PICKED package's own currency — not the offer's stale one", async () => {
    // VALID_PACKAGE_1 is EUR, VALID_PACKAGE_2 is USD (see fixtures above). The
    // bug this guards: a credit snapshotted in EUR at offer creation must not
    // silently net against a USD charge just because the client picked the
    // other option.
    offerFixture = { token: "t1", packages: [VALID_PACKAGE_1, VALID_PACKAGE_2], contact_id: "contact-1" }
    claimedRows = [{ token: "t1" }]
    mockAvailableCredit = { amount: 500, creditId: "pay-1", kind: "paid_call" }

    const res = await lockPackagePick({ token: "t1", packageKey: "fl-mmllc" })

    expect(res.success).toBe(true)
    // contact_id present on the offer row ⇒ resolveCreditSubject is skipped
    // entirely (package-pick.ts builds the subject directly).
    expect(resolveCreditSubjectCalls).toBe(0)
    expect(availableCreditForDisplayCalls).toEqual([{ scope: { contactId: "contact-1" }, currency: "USD" }])
    expect(lastUpdatePatch).toMatchObject({
      credit_amount: 500,
      credit_payment_id: "pay-1",
      credit_kind: "paid_call",
    })
  })

  it("falls back to resolving credit by email when the offer has no contact_id", async () => {
    offerFixture = {
      token: "t1",
      packages: [VALID_PACKAGE_1, VALID_PACKAGE_2],
      contact_id: null,
      client_email: "client@example.com",
    }
    claimedRows = [{ token: "t1" }]
    mockResolveCreditSubjectResult = { kind: "resolved", contactId: "contact-2", email: "client@example.com" }
    mockAvailableCredit = { amount: 250, creditId: "pay-2", kind: "mixed" }

    const res = await lockPackagePick({ token: "t1", packageKey: "wy-smllc" })

    expect(res.success).toBe(true)
    expect(resolveCreditSubjectCalls).toBe(1)
    expect(availableCreditForDisplayCalls).toEqual([{ scope: { contactId: "contact-2" }, currency: "EUR" }])
    expect(lastUpdatePatch).toMatchObject({ credit_amount: 250, credit_payment_id: "pay-2", credit_kind: "mixed" })
  })

  it("clears credit to null when there is no held credit in the picked currency", async () => {
    offerFixture = { token: "t1", packages: [VALID_PACKAGE_1, VALID_PACKAGE_2], contact_id: "contact-1" }
    claimedRows = [{ token: "t1" }]
    mockAvailableCredit = { amount: 0, creditId: null, kind: null }

    const res = await lockPackagePick({ token: "t1", packageKey: "wy-smllc" })

    expect(res.success).toBe(true)
    expect(lastUpdatePatch).toMatchObject({ credit_amount: null, credit_payment_id: null, credit_kind: null })
  })

  it("never blocks the lock when the credit re-check itself throws — clears credit rather than keeping a stale value", async () => {
    offerFixture = { token: "t1", packages: [VALID_PACKAGE_1, VALID_PACKAGE_2], contact_id: "contact-1" }
    claimedRows = [{ token: "t1" }]
    mockAvailableCreditThrows = true

    const res = await lockPackagePick({ token: "t1", packageKey: "wy-smllc" })

    expect(res.success).toBe(true)
    expect(lastUpdatePatch).toMatchObject({ credit_amount: null, credit_payment_id: null, credit_kind: null })
  })
})

describe("resetPackagePick", () => {
  beforeEach(() => {
    // Default: the atomic claim succeeds (an open, unsigned offer — the case
    // every pre-existing test below assumes). Tests exercising the status
    // guard, the race, or a missing offer override claimedRows/offerFixture.
    claimedRows = [{ token: "t1" }]
    claimError = null
    offerFixture = null
    offerFetchError = null
    refetchFixture = null
    selectCallCount = 0
    lastUpdatePatch = null
    lastNotArgs = null
  })

  it("clears the lock and the selected key in one atomic write — no separate read-then-check", async () => {
    const res = await resetPackagePick({ token: "t1", actor: "luca@tonydurante.us", reason: "client changed mind" })
    expect(res.success).toBe(true)
    // Clears the client-chosen split payment too (bug-hunter, second council pass,
    // 2026-08-27): re-picking a package changes the price, so a stale split sized
    // for the OLD price must not survive a reset — see payment-choice-made-at.
    expect(lastUpdatePatch).toEqual({
      package_locked_at: null,
      selected_package_key: null,
      payment_plan: null,
      payment_choice_made_at: null,
    })
    // The guard is expressed in the WHERE clause itself (signed/completed/superseded
    // excluded), not decided beforehand from a separate read — that's the
    // whole point of the fix (a stale read can no longer race a client's sign).
    expect(lastNotArgs).toEqual(["status", "in", '("signed","completed","superseded")'])
  })

  it("reports failure on a database error", async () => {
    claimedRows = null
    claimError = { message: "db down" }
    const res = await resetPackagePick({ token: "t1", actor: "luca@tonydurante.us" })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/db down/)
  })

  it("refuses when the offer doesn't exist", async () => {
    claimedRows = [] // WHERE token=$1 matched nothing at all
    offerFixture = null // the fallback re-fetch also finds nothing
    const res = await resetPackagePick({ token: "ghost", actor: "luca@tonydurante.us" })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it("refuses to reset a pick on a SIGNED offer — a closed deal, not something to undo", async () => {
    claimedRows = [] // excluded by the atomic WHERE ... NOT status IN (...)
    offerFixture = { status: "signed" } // fallback re-fetch, to explain why
    const res = await resetPackagePick({ token: "t1", actor: "luca@tonydurante.us" })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/signed/)
  })

  it("refuses to reset a pick on a COMPLETED offer", async () => {
    claimedRows = []
    offerFixture = { status: "completed" }
    const res = await resetPackagePick({ token: "t1", actor: "luca@tonydurante.us" })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/completed/)
  })

  it("refuses to reset a pick on a SUPERSEDED offer — its replacement already exists as a separate token, revise-offer's own contract says the original is preserved (bug-hunter, full E2E QA, 2026-08-27)", async () => {
    claimedRows = []
    offerFixture = { status: "superseded" }
    const res = await resetPackagePick({ token: "t1", actor: "luca@tonydurante.us" })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/superseded/)
  })

  it("still resets a pick on a VIEWED-but-not-signed offer", async () => {
    claimedRows = [{ token: "t1" }]
    const res = await resetPackagePick({ token: "t1", actor: "luca@tonydurante.us" })
    expect(res.success).toBe(true)
    expect(lastUpdatePatch).toEqual({
      package_locked_at: null,
      selected_package_key: null,
      payment_plan: null,
      payment_choice_made_at: null,
    })
  })
})
