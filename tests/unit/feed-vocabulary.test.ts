import { describe, it, expect } from "vitest"
import {
  FEED_STATUSES,
  MATCH_CONFIDENCES,
  FEED_SOURCES,
  auditLinkMetadata,
} from "@/lib/finance/feed-vocabulary"

/**
 * These lists are a CONTRACT with the database. A value here that is not in the database's
 * CHECK constraint is silently rejected at write time — which is exactly how the review
 * queue stayed empty for months while the UI showed a tab for it.
 *
 * `scripts/check-db-constraints.ts` asserts the live database agrees with these lists.
 * These tests guard the properties that a database check cannot: that the load-bearing
 * values are present, and that the dangerous ones stay out.
 */
describe("feed vocabulary — the code↔database contract", () => {
  it("includes the two statuses whose absence silently killed the review queue", () => {
    // Production's CHECK constraint did not permit these, so every attempt to park a
    // transaction for a human was rejected — and the error was discarded. Zero rows, ever.
    expect(FEED_STATUSES).toContain("needs_review")
    expect(FEED_STATUSES).toContain("activation_crashed")
  })

  it("keeps the original five statuses", () => {
    for (const s of ["unmatched", "matched", "ignored", "duplicate", "outgoing"]) {
      expect(FEED_STATUSES).toContain(s)
    }
  })

  it("does NOT invent new match-confidence values", () => {
    // `retroactive` is load-bearing: the retroactive pass builds its "this invoice is
    // already claimed by a transaction" set from it, and that set is what stops two
    // payments being attributed to one invoice. A NEW confidence value would be invisible
    // to that guard — so audit-link KINDS live in review_metadata, never here.
    expect(MATCH_CONFIDENCES).not.toContain("certain_retroactive")
    expect(MATCH_CONFIDENCES).not.toContain("manual_audit_link")
    expect(MATCH_CONFIDENCES).toContain("retroactive")
    expect(MATCH_CONFIDENCES).toContain("manual")
  })

  it("NEVER permits 'diagnostic'", () => {
    // Two CRM diagnose routes wrote this inside an unbounded fuzzy-name bulk update that
    // stamped one payment id onto EVERY feed whose sender name contained the company name.
    // It never landed a row only because the database rejected the value — the constraint
    // was accidentally shielding us from a mass mis-attribution of payments. The write is
    // deleted. Adding the value back would switch the landmine on.
    expect(MATCH_CONFIDENCES).not.toContain("diagnostic")
  })

  it("lists every real feed source", () => {
    expect(FEED_SOURCES).toContain("stripe")
    expect(FEED_SOURCES).toContain("relay")
    expect(FEED_SOURCES).toContain("mercury_api")
  })
})

describe("auditLinkMetadata — an audit link must never look like a payment", () => {
  it("always records that no money moved", () => {
    const meta = auditLinkMetadata("payment_intent", "Already paid via Stripe.")
    expect(meta.audit_link).toBe(true)
    expect(meta.money_applied).toBe(false)
    expect(meta.link_kind).toBe("payment_intent")
    expect(meta.note).toBe("Already paid via Stripe.")
  })

  it("distinguishes the certain link from the fuzzy guess and the human's decision", () => {
    expect(auditLinkMetadata("payment_intent", "x").link_kind).toBe("payment_intent")
    expect(auditLinkMetadata("fuzzy", "x").link_kind).toBe("fuzzy")
    expect(auditLinkMetadata("manual", "x").link_kind).toBe("manual")
  })
})
