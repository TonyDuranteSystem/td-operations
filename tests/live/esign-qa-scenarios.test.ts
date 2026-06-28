/**
 * Comprehensive E-Sign QA — drives the REAL public signer route handlers
 * (fetch/submit/decline) end-to-end against sandbox, plus create-validation.
 * Each scenario creates + cleans up its own data. SANDBOX_MODE=1 (no real email).
 */
import { describe, it, expect, beforeAll } from "vitest"
import { PDFDocument } from "pdf-lib"
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope, type EsignFieldInput, type EsignSignerInput } from "@/lib/operations/esign"
import { POST as submitRoute } from "@/app/api/sign/[token]/submit/route"
import { GET as fetchRoute } from "@/app/api/sign/[token]/fetch/route"
import { POST as declineRoute } from "@/app/api/sign/[token]/decline/route"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const sigField = (signer_index: number, x = 0.1): EsignFieldInput => ({ field_type: "signature", page_index: 0, pos_x: x, pos_y: 0.82, width: 0.3, height: 0.06, signer_index })

async function makeEnvelope(signers: EsignSignerInput[], fields: EsignFieldInput[], extra: Partial<Parameters<typeof createEsignEnvelope>[0]> = {}) {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  const pdfBuffer = Buffer.from(await doc.save())
  return createEsignEnvelope({ document_name: "QA SCENARIO (auto-cleanup)", pdfBuffer, fileName: "qa.pdf", pageCount: 1, signers, fields, ...extra })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callJson(res: any) {
  return { status: res.status as number, json: await res.json() }
}
function fetchFields(token: string, code: string, preview = false) {
  const url = `https://t/api/sign/${token}/fetch?code=${encodeURIComponent(code)}${preview ? "&preview=td" : ""}`
  return fetchRoute(new NextRequest(url), { params: Promise.resolve({ token }) }).then(callJson)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function submit(token: string, body: any) {
  const req = new NextRequest(`https://t/api/sign/${token}/submit`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
  return submitRoute(req, { params: Promise.resolve({ token }) }).then(callJson)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decline(token: string, body: any) {
  const req = new NextRequest(`https://t/api/sign/${token}/decline`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
  return declineRoute(req, { params: Promise.resolve({ token }) }).then(callJson)
}

let accountId: string
beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)
  const { data } = await db.from("accounts").select("id").limit(1)
  accountId = data?.[0]?.id
})

describe("E-Sign QA scenarios (live sandbox, real route handlers)", () => {
  it("S1 — single signer, all field types: fetch → submit → completed + cert + filed", async () => {
    const env = await makeEnvelope(
      [{ name: "Alice", email: "alice@example.test" }],
      [
        sigField(0),
        { field_type: "date", page_index: 0, pos_x: 0.1, pos_y: 0.7, width: 0.18, height: 0.03, signer_index: 0 },
        { field_type: "text", page_index: 0, pos_x: 0.1, pos_y: 0.6, width: 0.3, height: 0.03, signer_index: 0 },
        { field_type: "checkbox", page_index: 0, pos_x: 0.6, pos_y: 0.6, width: 0.03, height: 0.025, signer_index: 0 },
      ],
      { owner_account_id: accountId },
    )
    const s = env.signers[0]
    try {
      const f = await fetchFields(s.token, s.access_code)
      expect(f.status).toBe(200)
      expect(f.json.fields.length).toBe(4)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fieldVals = f.json.fields.filter((x: any) => ["date", "text", "checkbox"].includes(x.field_type)).map((x: any) => ({ field_id: x.id, value: x.field_type === "checkbox" ? "true" : x.field_type === "date" ? "06/27/2026" : "Hello QA" }))
      const r = await submit(s.token, { code: s.access_code, signature_png: PNG, signed_by_name: "Alice", consent: true, fields: fieldVals })
      expect(r.status).toBe(200)
      expect(r.json.completed).toBe(true)

      const { data: e } = await db.from("esign_envelopes").select("status, signed_pdf_path").eq("id", env.id).maybeSingle()
      expect(e.status).toBe("completed")
      expect(e.signed_pdf_path).toBeTruthy()
      const { data: filed } = await db.from("documents").select("id, portal_visible").eq("account_id", accountId).eq("drive_file_id", `storage:signed-documents/${e.signed_pdf_path}`).maybeSingle()
      expect(filed?.portal_visible).toBe(true)
      await db.from("documents").delete().eq("id", filed.id)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 90000)

  it("S2 — multi-signer sequential: signer 1 signs → in_progress + signer 2 queued → signer 2 signs → completed", async () => {
    const env = await makeEnvelope(
      [{ name: "One", email: "one@example.test" }, { name: "Two", email: "two@example.test" }],
      [sigField(0, 0.1), sigField(1, 0.55)],
      { routing_order: "sequential" },
    )
    const [s1, s2] = env.signers
    try {
      const r1 = await submit(s1.token, { code: s1.access_code, signature_png: PNG, signed_by_name: "One", consent: true })
      expect(r1.json.completed).toBe(false)
      const { data: e1 } = await db.from("esign_envelopes").select("status").eq("id", env.id).maybeSingle()
      expect(e1.status).toBe("in_progress")
      // signer 2 reminder/invite job queued
      const { data: jobs } = await db.from("job_queue").select("id").eq("job_type", "esign_send_email").contains("payload", { signer_id: s2.id })
      expect((jobs ?? []).length).toBeGreaterThanOrEqual(1)
      for (const j of jobs ?? []) await db.from("job_queue").delete().eq("id", j.id)

      const r2 = await submit(s2.token, { code: s2.access_code, signature_png: PNG, signed_by_name: "Two", consent: true })
      expect(r2.json.completed).toBe(true)
      const { data: e2 } = await db.from("esign_envelopes").select("status, signed_count").eq("id", env.id).maybeSingle()
      expect(e2.status).toBe("completed")
      expect(e2.signed_count).toBe(2)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 90000)

  it("S3 — multi-signer parallel: both sign independently → completed", async () => {
    const env = await makeEnvelope(
      [{ name: "P1", email: "p1@example.test" }, { name: "P2", email: "p2@example.test" }],
      [sigField(0, 0.1), sigField(1, 0.55)],
      { routing_order: "parallel" },
    )
    const [s1, s2] = env.signers
    try {
      expect((await submit(s1.token, { code: s1.access_code, signature_png: PNG, signed_by_name: "P1", consent: true })).json.completed).toBe(false)
      expect((await submit(s2.token, { code: s2.access_code, signature_png: PNG, signed_by_name: "P2", consent: true })).json.completed).toBe(true)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 90000)

  it("S4 — decline: signer declines → envelope + signer declined, audit event", async () => {
    const env = await makeEnvelope([{ name: "D", email: "d@example.test" }], [sigField(0)])
    const s = env.signers[0]
    try {
      const r = await decline(s.token, { code: s.access_code, reason: "Wrong document" })
      expect(r.status).toBe(200)
      const { data: e } = await db.from("esign_envelopes").select("status").eq("id", env.id).maybeSingle()
      expect(e.status).toBe("declined")
      const { data: sg } = await db.from("esign_signers").select("status, decline_reason").eq("id", s.id).maybeSingle()
      expect(sg.status).toBe("declined")
      expect(sg.decline_reason).toBe("Wrong document")
      const { data: ev } = await db.from("esign_events").select("id").eq("envelope_id", env.id).eq("event_type", "declined")
      expect((ev ?? []).length).toBe(1)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("S5 — wrong access code is rejected (fetch + submit)", async () => {
    const env = await makeEnvelope([{ name: "W", email: "w@example.test" }], [sigField(0)])
    const s = env.signers[0]
    try {
      expect((await fetchFields(s.token, "WRONGCODE")).status).toBe(403)
      expect((await submit(s.token, { code: "WRONGCODE", signature_png: PNG, signed_by_name: "W", consent: true })).status).toBe(403)
      const { data: sg } = await db.from("esign_signers").select("status").eq("id", s.id).maybeSingle()
      expect(sg.status).not.toBe("signed")
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("S6 — double-sign (TOCTOU): second submit rejected, no double-count", async () => {
    const env = await makeEnvelope([{ name: "T", email: "t@example.test" }], [sigField(0)])
    const s = env.signers[0]
    try {
      const r1 = await submit(s.token, { code: s.access_code, signature_png: PNG, signed_by_name: "T", consent: true })
      expect(r1.json.completed).toBe(true)
      const r2 = await submit(s.token, { code: s.access_code, signature_png: PNG, signed_by_name: "T", consent: true })
      expect([409, 410]).toContain(r2.status) // already signed / envelope completed
      const { data: e } = await db.from("esign_envelopes").select("signed_count, total_signers").eq("id", env.id).maybeSingle()
      expect(e.signed_count).toBe(e.total_signers) // never exceeded
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 90000)

  it("S10 — create validation rejects bad inputs", async () => {
    await expect(makeEnvelope([], [sigField(0)])).rejects.toThrow(/signer/i)
    await expect(makeEnvelope([{ name: "A" }], [])).rejects.toThrow(/field/i)
    await expect(makeEnvelope([{ name: "A" }], [sigField(5)])).rejects.toThrow(/signer/i) // field → nonexistent signer
    await expect(makeEnvelope([{ name: "A" }, { name: "B" }], [sigField(0)])).rejects.toThrow(/no fields/i) // signer B has none
  }, 60000)
})
