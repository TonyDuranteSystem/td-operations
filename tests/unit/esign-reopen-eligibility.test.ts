/**
 * Reopen eligibility. Every refusal here corresponds to a way a reopened
 * document fails SILENTLY in production, so each one gets a test that fails if
 * the rule is deleted.
 */

import { describe, it, expect } from "vitest"
import { decideReopen } from "@/lib/esign/reopen-eligibility"

const signer = (status: string) => ({ status })

describe("decideReopen", () => {
  it("reopens an untouched expired envelope as 'sent'", () => {
    const d = decideReopen({ status: "expired", signed_count: 0, total_signers: 1, signers: [signer("sent")] })
    expect(d).toEqual({ kind: "allowed", nextStatus: "sent" })
  })

  it("reopens a partly-signed envelope as 'in_progress'", () => {
    const d = decideReopen({
      status: "expired",
      signed_count: 1,
      total_signers: 2,
      signers: [signer("signed"), signer("viewed")],
    })
    expect(d).toEqual({ kind: "allowed", nextStatus: "in_progress" })
  })

  it.each(["voided", "declined", "completed", "sent", "in_progress", "draft"])(
    "refuses a %s envelope — reopen is only ever for expiry",
    status => {
      const d = decideReopen({ status, signed_count: 0, total_signers: 1, signers: [signer("sent")] })
      expect(d.kind).toBe("refused")
      if (d.kind === "refused") expect(d.reason).toBe("not_expired")
    },
  )

  it("refuses a fully-signed expired envelope — reopening it would file a SECOND signed copy", () => {
    // Reachable: the expiry cron can land between the submit route's terminal
    // check and its completion claim, leaving every signature counted but the
    // envelope stuck at 'expired'. Back in_progress, the reconcile step
    // flattens, completes and files it into the client's Drive and portal.
    const d = decideReopen({
      status: "expired",
      signed_count: 2,
      total_signers: 2,
      signers: [signer("signed"), signer("signed")],
    })
    expect(d.kind).toBe("refused")
    if (d.kind === "refused") expect(d.reason).toBe("fully_signed")
  })

  it("refuses when a signer declined — the envelope could never complete", () => {
    const d = decideReopen({
      status: "expired",
      signed_count: 0,
      total_signers: 2,
      signers: [signer("sent"), signer("declined")],
    })
    expect(d.kind).toBe("refused")
    if (d.kind === "refused") expect(d.reason).toBe("has_declined_signer")
  })

  it("prefers the decline refusal over the fully-signed one when both apply", () => {
    const d = decideReopen({
      status: "expired",
      signed_count: 1,
      total_signers: 1,
      signers: [signer("signed"), signer("declined")],
    })
    expect(d.kind).toBe("refused")
    if (d.kind === "refused") expect(d.reason).toBe("has_declined_signer")
  })

  it("refuses when nobody is left to act", () => {
    const d = decideReopen({ status: "expired", signed_count: 0, total_signers: 1, signers: [signer("declined_x")] })
    expect(d.kind).toBe("refused")
    if (d.kind === "refused") expect(d.reason).toBe("no_actionable_signer")
  })

  it("gives a message a non-engineer can act on for every refusal", () => {
    for (const input of [
      { status: "voided", signed_count: 0, total_signers: 1, signers: [signer("sent")] },
      { status: "expired", signed_count: 1, total_signers: 1, signers: [signer("signed")] },
      { status: "expired", signed_count: 0, total_signers: 2, signers: [signer("sent"), signer("declined")] },
    ]) {
      const d = decideReopen(input)
      expect(d.kind).toBe("refused")
      if (d.kind === "refused") {
        expect(d.message.length).toBeGreaterThan(20)
        expect(d.message).not.toMatch(/signed_count|total_signers|envelope_id|null|undefined/)
      }
    }
  })
})
