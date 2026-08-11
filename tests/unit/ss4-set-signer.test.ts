/**
 * Unit tests for the SS-4 signer switch decision core
 * (lib/operations/ss4-set-signer.ts::computeSs4SignerSwitch).
 *
 * The DB wrapper (setSs4Signer) is exercised at the DB/CLICKED levels in the
 * job's test matrix; this file pins the decision + the exact patch, which is
 * where a partial write would put the previous person's tax ID under the new
 * person's name on a federal form.
 */

import { describe, it, expect } from "vitest"
import {
  computeSs4SignerSwitch,
  type Ss4SignerSwitchRow,
  type Ss4SwitchContact,
} from "@/lib/operations/ss4-set-signer"

const NEW_CODE = "deadbeef"

const draftRow: Ss4SignerSwitchRow = {
  id: "ss4-1",
  token: "ss4-ace-marketing-group-llc-2026",
  access_code: "oldcode1",
  status: "draft",
  signed_at: null,
  contact_id: "rep-contact",
  company_name: "ACE Marketing Group LLC",
}

const newSigner: Ss4SwitchContact = {
  id: "owner-contact",
  full_name: "Mohamed Kosba",
  itin_number: "912-34-5678",
  phone: "+1 555 0100",
}

describe("computeSs4SignerSwitch", () => {
  it("rewrites the responsible party as a SET, never a bare contact_id", () => {
    const d = computeSs4SignerSwitch({ ss4: draftRow, contact: newSigner, newAccessCode: NEW_CODE })
    expect(d.kind).toBe("switch")
    if (d.kind !== "switch") return
    // All five correlated fields move together — the filled IRS PDF renders the
    // name and the tax ID, so a partial write is a wrong federal filing.
    expect(d.updates.contact_id).toBe("owner-contact")
    expect(d.updates.responsible_party_name).toBe("Mohamed Kosba")
    expect(d.updates.responsible_party_itin).toBe("912-34-5678")
    expect(d.updates.responsible_party_phone).toBe("+1 555 0100")
    expect(d.previousContactId).toBe("rep-contact")
  })

  it("ROTATES the access code — this is what actually kills the old link", () => {
    const d = computeSs4SignerSwitch({ ss4: draftRow, contact: newSigner, newAccessCode: NEW_CODE })
    if (d.kind !== "switch") throw new Error("expected switch")
    expect(d.updates.access_code).toBe(NEW_CODE)
    expect(d.updates.access_code).not.toBe(draftRow.access_code)
    expect(d.newAccessCode).toBe(NEW_CODE)
  })

  it("awaiting_signature → resets to draft", () => {
    const sent = { ...draftRow, status: "awaiting_signature" }
    const d = computeSs4SignerSwitch({ ss4: sent, contact: newSigner, newAccessCode: NEW_CODE })
    if (d.kind !== "switch") throw new Error("expected switch")
    expect(d.updates.status).toBe("draft")
    expect(d.statusReset).toBe(true)
  })

  it("a draft stays a draft — a switch never silently promotes to awaiting_signature", () => {
    const d = computeSs4SignerSwitch({ ss4: draftRow, contact: newSigner, newAccessCode: NEW_CODE })
    if (d.kind !== "switch") throw new Error("expected switch")
    expect(d.updates.status).toBeUndefined()
    expect(d.statusReset).toBe(false)
  })

  it("empty ITIN / phone are stored as null, not empty strings", () => {
    const bare: Ss4SwitchContact = { id: "owner-contact", full_name: "No Docs", itin_number: "", phone: "" }
    const d = computeSs4SignerSwitch({ ss4: draftRow, contact: bare, newAccessCode: NEW_CODE })
    if (d.kind !== "switch") throw new Error("expected switch")
    expect(d.updates.responsible_party_itin).toBeNull()
    expect(d.updates.responsible_party_phone).toBeNull()
  })

  it("picking the person already named is a no-op (no pointless code rotation)", () => {
    const d = computeSs4SignerSwitch({
      ss4: draftRow,
      contact: { id: "rep-contact", full_name: "Same Person", itin_number: null, phone: null },
      newAccessCode: NEW_CODE,
    })
    expect(d).toEqual({ kind: "unchanged" })
  })

  it("SIGNED is immutable — the client signed that exact document", () => {
    for (const status of ["signed", "submitted", "done"]) {
      const d = computeSs4SignerSwitch({
        ss4: { ...draftRow, status },
        contact: newSigner,
        newAccessCode: NEW_CODE,
      })
      expect(d.kind).toBe("locked")
      if (d.kind === "locked") expect(d.message).toContain(status)
    }
  })

  it("locks on signed_at even when the status still says awaiting_signature", () => {
    // Either field can lag the other; a signature present must win.
    const d = computeSs4SignerSwitch({
      ss4: { ...draftRow, status: "awaiting_signature", signed_at: "2026-08-10T12:00:00Z" },
      contact: newSigner,
      newAccessCode: NEW_CODE,
    })
    expect(d.kind).toBe("locked")
  })

  it("MUTATION PROOF — dropping the code rotation or the draft reset fails these", () => {
    const sent = { ...draftRow, status: "awaiting_signature" }
    const d = computeSs4SignerSwitch({ ss4: sent, contact: newSigner, newAccessCode: NEW_CODE })
    if (d.kind !== "switch") throw new Error("expected switch")
    // Both are load-bearing for "the old signing link no longer works".
    expect(d.updates).toHaveProperty("access_code", NEW_CODE)
    expect(d.updates).toHaveProperty("status", "draft")
  })
})
