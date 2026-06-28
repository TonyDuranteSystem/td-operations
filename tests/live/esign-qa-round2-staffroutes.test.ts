/**
 * E-Sign QA round 2 — STAFF routes (create + send) with mocked dashboard auth,
 * which the public-route harness can't reach. Drives the real handlers + real
 * sandbox writes (only the auth client is mocked). SANDBOX_MODE=1.
 */
import { describe, it, expect, beforeAll, vi } from "vitest"
import { PDFDocument } from "pdf-lib"
import { NextRequest } from "next/server"

// Mock ONLY the auth surfaces so isDashboardUser passes. supabaseAdmin (data)
// stays real, so the operation writes to the real sandbox.
vi.mock("@/lib/auth", async (orig) => ({ ...(await (orig() as Promise<object>)), isDashboardUser: () => true }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "qa-staff", email: "staff@td.test" } } }) } }),
}))

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope, type EsignFieldInput, type EsignSignerInput } from "@/lib/operations/esign"
import { POST as createRoute } from "@/app/api/esign/envelopes/route"
import { POST as sendRoute } from "@/app/api/esign/envelopes/[id]/send/route"
import { POST as voidRoute } from "@/app/api/esign/envelopes/[id]/void/route"
import { POST as submitRoute } from "@/app/api/sign/[token]/submit/route"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const rand = () => Math.random().toString(36).slice(2, 10)
const sigField = (signer_index: number): EsignFieldInput => ({ field_type: "signature", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.3, height: 0.06, signer_index })

async function pdfFile() {
  const doc = await PDFDocument.create(); doc.addPage([612, 792])
  return new File([Buffer.from(await doc.save())], "qa.pdf", { type: "application/pdf" })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function postCreate(payload: any) {
  const form = new FormData()
  form.append("pdf", await pdfFile())
  form.append("payload", JSON.stringify(payload))
  const req = new NextRequest("https://t/api/esign/envelopes", { method: "POST", body: form })
  const res = await createRoute(req)
  return { status: res.status, json: await res.json() }
}
async function postSend(id: string) {
  const req = new NextRequest(`https://t/api/esign/envelopes/${id}/send`, { method: "POST" })
  const res = await sendRoute(req, { params: Promise.resolve({ id }) })
  return { status: res.status, json: await res.json() }
}
async function postVoid(id: string, reason?: string) {
  const req = new NextRequest(`https://t/api/esign/envelopes/${id}/void`, { method: "POST", body: JSON.stringify({ reason }), headers: { "content-type": "application/json" } })
  const res = await voidRoute(req, { params: Promise.resolve({ id }) })
  return { status: res.status, json: await res.json() }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function publicSubmit(token: string, body: any) {
  const req = new NextRequest(`https://t/api/sign/${token}/submit`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
  const res = await submitRoute(req, { params: Promise.resolve({ token }) })
  return { status: res.status, json: await res.json() }
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
async function makeEnvelope(signers: EsignSignerInput[], extra: Record<string, unknown> = {}) {
  const doc = await PDFDocument.create(); doc.addPage([612, 792])
  return createEsignEnvelope({ document_name: `QA2-staff ${rand()}`, pdfBuffer: Buffer.from(await doc.save()), fileName: "qa.pdf", pageCount: 1, signers, fields: signers.map((_, i) => sigField(i)), origin: "staff", routing_order: "parallel", ...extra })
}

let accountId: string, contactId: string, portalEmail: string
beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)
  const { data: link } = await db.from("account_contacts").select("contact_id, account_id").limit(1).maybeSingle()
  contactId = link.contact_id; accountId = link.account_id
  portalEmail = (await db.auth.admin.listUsers({ page: 1, perPage: 1 })).data?.users?.[0]?.email
})

describe("E-Sign QA round 2 — staff routes (live sandbox, mocked auth)", () => {
  it("RC1 — create route: valid envelope (CRM + third party) → 200, persisted with contact_id", async () => {
    const { status, json } = await postCreate({
      document_name: `QA2 create ${rand()}`,
      owner_account_id: accountId,
      routing_order: "parallel",
      signers: [
        { name: "CRM Client", email: portalEmail, contact_id: contactId },
        { name: "Third Party", email: `tp-${rand()}@example.com` },
      ],
      fields: [sigField(0), sigField(1)],
    })
    expect(status).toBe(200)
    expect(json.id).toBeTruthy()
    expect((json.signers ?? []).length).toBe(2)
    try {
      const { data: rows } = await db.from("esign_signers").select("contact_id").eq("envelope_id", json.id).order("signer_index")
      expect(rows[0].contact_id).toBe(contactId) // CRM link persisted
      expect(rows[1].contact_id).toBeNull()       // third party has none
    } finally {
      await db.from("esign_envelopes").delete().eq("id", json.id)
    }
  }, 60000)

  it("RC2 — create route: third-party signer with NO email is rejected (400)", async () => {
    const { status, json } = await postCreate({
      document_name: `QA2 reject ${rand()}`,
      signers: [{ name: "No Email Third Party" }], // no email, no contact_id
      fields: [sigField(0)],
    })
    expect(status).toBe(400)
    expect(String(json.error || "")).toMatch(/email/i)
  }, 60000)

  it("RC3 — send route: mixed signers → response counts {emailed, portal, undeliverable}", async () => {
    // signer 0 CRM w/ portal login → portal; signer 1 third party → email.
    const env = await makeEnvelope(
      [{ name: "CRM", email: portalEmail, contact_id: contactId }, { name: "TP", email: `tp-${rand()}@example.com` }],
      { owner_account_id: accountId },
    )
    const docName = (await db.from("esign_envelopes").select("document_name").eq("id", env.id).maybeSingle()).data.document_name
    try {
      const { status, json } = await postSend(env.id)
      expect(status).toBe(200)
      expect(json.portal).toBe(1)   // CRM client → portal
      expect(json.emailed).toBe(1)  // third party → email
      expect(json.undeliverable).toBe(0)
      // Envelope flipped draft → sent.
      const { data: e } = await db.from("esign_envelopes").select("status").eq("id", env.id).maybeSingle()
      expect(e.status).toBe("sent")
    } finally {
      await db.from("portal_notifications").delete().eq("title", `Document to sign: ${docName}`)
      await db.from("job_queue").delete().eq("job_type", "esign_send_email").eq("related_entity_id", env.id)
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("RC4 — send route on a terminal (completed) envelope is rejected", async () => {
    const env = await makeEnvelope([{ name: "X", email: `x-${rand()}@example.com` }], { owner_account_id: accountId })
    await db.from("esign_envelopes").update({ status: "completed" }).eq("id", env.id)
    try {
      const { status } = await postSend(env.id)
      expect(status).toBe(400)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("VOID1 — void an active envelope → 200, status voided, reason + 'voided' event recorded", async () => {
    const env = await makeEnvelope([{ name: "V", email: `v-${rand()}@example.com` }])
    try {
      const r = await postVoid(env.id, "QA void reason")
      expect(r.status).toBe(200)
      expect(r.json.status).toBe("voided")
      const { data: e } = await db.from("esign_envelopes").select("status, void_reason, voided_at").eq("id", env.id).maybeSingle()
      expect(e.status).toBe("voided")
      expect(e.void_reason).toBe("QA void reason")
      expect(e.voided_at).toBeTruthy()
      const { data: ev } = await db.from("esign_events").select("metadata").eq("envelope_id", env.id).eq("event_type", "voided").maybeSingle()
      expect(ev?.metadata?.reason).toBe("QA void reason")
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("VOID2 — voiding an already-terminal (completed) envelope is rejected (400)", async () => {
    const env = await makeEnvelope([{ name: "X", email: `x-${rand()}@example.com` }])
    await db.from("esign_envelopes").update({ status: "completed" }).eq("id", env.id)
    try {
      const r = await postVoid(env.id)
      expect(r.status).toBe(400)
      expect(String(r.json.error || "")).toMatch(/already completed/i)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("VOID3 — after void, the signer can no longer sign (public submit → 410)", async () => {
    const env = await makeEnvelope([{ name: "S", email: `s-${rand()}@example.com` }])
    // grab the signer's token+access_code seeded by createEsignEnvelope
    const { data: signer } = await db.from("esign_signers").select("token, access_code").eq("envelope_id", env.id).maybeSingle()
    try {
      expect((await postVoid(env.id, "cancelled")).status).toBe(200)
      const sub = await publicSubmit(signer.token, { code: signer.access_code, signature_png: PNG, signed_by_name: "S", consent: true })
      expect(sub.status).toBe(410)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)
})
