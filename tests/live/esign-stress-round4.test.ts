/**
 * Round-4 stress: state-machine + concurrency + full in-portal loop + the
 * non-required-field path. Asserts CORRECT behavior (D1 fails before the fix).
 * Live cloud sandbox; SANDBOX_MODE=1.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { PDFDocument } from "pdf-lib"
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope, type EsignFieldInput, type EsignSignerInput } from "@/lib/operations/esign"
import { dispatchSignerDelivery } from "@/lib/esign/dispatch-delivery"
import { POST as submitRoute } from "@/app/api/sign/[token]/submit/route"
import { POST as declineRoute } from "@/app/api/sign/[token]/decline/route"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const rand = () => Math.random().toString(36).slice(2, 10)
const sig = (i: number): EsignFieldInput => ({ field_type: "signature", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.3, height: 0.06, signer_index: i, required: true })
async function makeEnvelope(signers: EsignSignerInput[], fields: EsignFieldInput[], extra: Record<string, unknown> = {}) {
  const doc = await PDFDocument.create(); doc.addPage([612, 792])
  return createEsignEnvelope({ document_name: `R4 ${rand()}`, pdfBuffer: Buffer.from(await doc.save()), fileName: "qa.pdf", pageCount: 1, signers, fields, origin: "staff", ...extra })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const submit = (token: string, body: any) =>
  submitRoute(new NextRequest(`https://t/api/sign/${token}/submit`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ token }) }).then(async r => ({ status: r.status, json: await r.json() }))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const decline = (token: string, body: any) =>
  declineRoute(new NextRequest(`https://t/api/sign/${token}/decline`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ token }) }).then(async r => ({ status: r.status, json: await r.json() }))

let accountId: string, contactId: string, portalEmail: string
beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)
  const { data: link } = await db.from("account_contacts").select("contact_id, account_id").limit(1).maybeSingle()
  contactId = link.contact_id; accountId = link.account_id
  portalEmail = (await db.auth.admin.listUsers({ page: 1, perPage: 1 })).data?.users?.[0]?.email
})

describe("E-Sign round-4 stress (live sandbox)", () => {
  it("D1 — a DECLINED envelope cannot be signed by another signer (parallel) and is not resurrected", async () => {
    const env = await makeEnvelope(
      [{ name: "A", email: `a-${rand()}@example.com` }, { name: "B", email: `b-${rand()}@example.com` }],
      [sig(0), sig(1)],
      { routing_order: "parallel" },
    )
    const [a, b] = env.signers
    try {
      const d = await decline(a.token, { code: a.access_code, reason: "no" })
      expect(d.status).toBe(200)
      const { data: e1 } = await db.from("esign_envelopes").select("status").eq("id", env.id).maybeSingle()
      expect(e1.status).toBe("declined")
      // Signer B tries to sign the declined envelope — must be rejected (410), NOT resurrect it.
      const r = await submit(b.token, { code: b.access_code, signature_png: PNG, signed_by_name: "B", consent: true })
      expect(r.status).toBe(410)
      const { data: e2 } = await db.from("esign_envelopes").select("status").eq("id", env.id).maybeSingle()
      expect(e2.status).toBe("declined") // still declined, not in_progress
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("C1 — CONCURRENT last-signer race (parallel): exactly ONE completion, count == total, ONE filing", async () => {
    const env = await makeEnvelope(
      [{ name: "P1", email: `p1-${rand()}@example.com` }, { name: "P2", email: `p2-${rand()}@example.com` }],
      [sig(0), sig(1)],
      { routing_order: "parallel", owner_account_id: accountId },
    )
    const [s1, s2] = env.signers
    try {
      // Fire both submits at once.
      const [r1, r2] = await Promise.all([
        submit(s1.token, { code: s1.access_code, signature_png: PNG, signed_by_name: "P1", consent: true }),
        submit(s2.token, { code: s2.access_code, signature_png: PNG, signed_by_name: "P2", consent: true }),
      ])
      expect([r1.status, r2.status].every(s => s === 200)).toBe(true)
      const completes = [r1.json.completed, r2.json.completed].filter(Boolean).length
      expect(completes).toBe(1) // exactly one signer observes completion
      const { data: e } = await db.from("esign_envelopes").select("status, signed_count, total_signers, signed_pdf_path").eq("id", env.id).maybeSingle()
      expect(e.status).toBe("completed")
      expect(e.signed_count).toBe(e.total_signers) // no over/under count
      // Exactly one document filed (no double-filing under the race).
      const { data: docs } = await db.from("documents").select("id").eq("drive_file_id", `storage:signed-documents/${e.signed_pdf_path}`)
      expect((docs ?? []).length).toBe(1)
      await db.from("documents").delete().eq("drive_file_id", `storage:signed-documents/${e.signed_pdf_path}`)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 120000)

  it("P1 — full in-portal CRM loop: create → portal dispatch → sign (submit) → completed + filed", async () => {
    const env = await makeEnvelope([{ name: "CRM Client", email: portalEmail, contact_id: contactId }], [sig(0)], { owner_account_id: accountId, routing_order: "parallel" })
    const s = env.signers[0]
    const docName = (await db.from("esign_envelopes").select("document_name").eq("id", env.id).maybeSingle()).data.document_name
    let signedPath: string | null = null
    try {
      const channel = await dispatchSignerDelivery({ signerId: s.id, baseUrl: "https://t" })
      expect(channel).toBe("portal") // CRM client w/ portal login
      // The portal embed posts to the SAME submit route.
      const r = await submit(s.token, { code: s.access_code, signature_png: PNG, signed_by_name: "CRM Client", consent: true })
      expect(r.status).toBe(200)
      expect(r.json.completed).toBe(true)
      const { data: e } = await db.from("esign_envelopes").select("status, signed_pdf_path").eq("id", env.id).maybeSingle()
      expect(e.status).toBe("completed")
      expect(e.signed_pdf_path).toBeTruthy()
      signedPath = e.signed_pdf_path
      const { data: filed } = await db.from("documents").select("portal_visible").eq("drive_file_id", `storage:signed-documents/${signedPath}`).maybeSingle()
      expect(filed?.portal_visible).toBe(true)
    } finally {
      if (signedPath) await db.from("documents").delete().eq("drive_file_id", `storage:signed-documents/${signedPath}`)
      await db.from("portal_notifications").delete().eq("title", `Document to sign: ${docName}`)
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 120000)

  it("NR1 — a NON-required field left empty does NOT block completion (enforcement isn't over-strict)", async () => {
    const env = await makeEnvelope(
      [{ name: "Solo", email: `solo-${rand()}@example.com` }],
      [sig(0), { field_type: "text", page_index: 0, pos_x: 0.1, pos_y: 0.5, width: 0.3, height: 0.03, signer_index: 0, required: false }],
      { owner_account_id: accountId },
    )
    const s = env.signers[0]
    let signedPath: string | null = null
    try {
      // Sign with only the signature; leave the optional text empty.
      const r = await submit(s.token, { code: s.access_code, signature_png: PNG, signed_by_name: "Solo", consent: true, fields: [] })
      expect(r.status).toBe(200)
      expect(r.json.completed).toBe(true)
      signedPath = (await db.from("esign_envelopes").select("signed_pdf_path").eq("id", env.id).maybeSingle()).data?.signed_pdf_path
    } finally {
      if (signedPath) await db.from("documents").delete().eq("drive_file_id", `storage:signed-documents/${signedPath}`)
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 90000)
})
