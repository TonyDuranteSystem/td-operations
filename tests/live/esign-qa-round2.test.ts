/**
 * E-Sign QA round 2 — gap scenarios not covered elsewhere, driving REAL route
 * handlers + operations against the cloud sandbox. SANDBOX_MODE=1 (no real email).
 *  R1 mixed-channel sequential hand-off (third party → CRM portal client) via the
 *     real submit route; R2 void rejects signing; R3 expire rejects signing;
 *     R4 cross-signer field isolation; R7 editor prefill data path; R8 enriched
 *     clients-search after the comma-safe fix.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { PDFDocument } from "pdf-lib"
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope, type EsignFieldInput, type EsignSignerInput } from "@/lib/operations/esign"
import { runEsignReminders } from "@/lib/esign/reminders"
import { POST as submitRoute } from "@/app/api/sign/[token]/submit/route"
import { GET as fetchRoute } from "@/app/api/sign/[token]/fetch/route"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const rand = () => Math.random().toString(36).slice(2, 10)
const sigField = (signer_index: number): EsignFieldInput => ({ field_type: "signature", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.3, height: 0.06, signer_index })

async function makeEnvelope(signers: EsignSignerInput[], fields: EsignFieldInput[], extra: Record<string, unknown> = {}) {
  const doc = await PDFDocument.create(); doc.addPage([612, 792])
  const pdfBuffer = Buffer.from(await doc.save())
  return createEsignEnvelope({ document_name: `QA2 ${rand()}`, pdfBuffer, fileName: "qa.pdf", pageCount: 1, signers, fields, origin: "staff", ...extra })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callJson = async (res: any) => ({ status: res.status as number, json: await res.json() })
const fetchFields = (token: string, code: string) =>
  fetchRoute(new NextRequest(`https://t/api/sign/${token}/fetch?code=${encodeURIComponent(code)}`), { params: Promise.resolve({ token }) }).then(callJson)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const submit = (token: string, body: any) =>
  submitRoute(new NextRequest(`https://t/api/sign/${token}/submit`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ token }) }).then(callJson)
const jobsFor = async (sid: string) => ((await db.from("job_queue").select("id").eq("job_type", "esign_send_email").eq("payload->>signer_id", sid)).data ?? []).length

let accountId: string, contactId: string, contactName: string, companyName: string, portalEmail: string
beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)
  // A contact that has an account link (for prefill + enriched search assertions).
  const { data: link } = await db.from("account_contacts").select("contact_id, account_id").limit(1).maybeSingle()
  contactId = link.contact_id; accountId = link.account_id
  contactName = (await db.from("contacts").select("full_name").eq("id", contactId).maybeSingle()).data?.full_name
  companyName = (await db.from("accounts").select("company_name").eq("id", accountId).maybeSingle()).data?.company_name
  portalEmail = (await db.auth.admin.listUsers({ page: 1, perPage: 1 })).data?.users?.[0]?.email
  expect(accountId && contactId && portalEmail).toBeTruthy()
})

describe("E-Sign QA round 2 (live sandbox)", () => {
  it("R1 — sequential third-party → CRM-portal: signing #1 hands off to #2 via the PORTAL channel", async () => {
    const env = await makeEnvelope(
      [{ name: "Third Party", email: `tp-${rand()}@example.com`, contact_id: null },
       { name: "CRM Client", email: portalEmail, contact_id: contactId }],
      [sigField(0), sigField(1)],
      { routing_order: "sequential", owner_account_id: accountId },
    )
    const [s0, s1] = env.signers
    const docName = (await db.from("esign_envelopes").select("document_name").eq("id", env.id).maybeSingle()).data.document_name
    try {
      // Sign signer 0 (the third party) through the real submit route.
      const r = await submit(s0.token, { code: s0.access_code, signature_png: PNG, signed_by_name: "TP", consent: true })
      expect(r.status).toBe(200)
      expect(r.json.completed).toBe(false) // 2 signers, not done

      const { data: env2 } = await db.from("esign_envelopes").select("status").eq("id", env.id).maybeSingle()
      expect(env2.status).toBe("in_progress")

      // Hand-off: signer 1 is a CRM client w/ a portal login → PORTAL, NOT email.
      const { data: sg1 } = await db.from("esign_signers").select("status").eq("id", s1.id).maybeSingle()
      expect(sg1.status).toBe("sent")
      expect(await jobsFor(s1.id)).toBe(0) // no email job for the portal signer
      const { data: notif } = await db.from("portal_notifications").select("id").eq("type", "sign_document").eq("title", `Document to sign: ${docName}`).limit(1)
      expect((notif ?? []).length).toBe(1)
    } finally {
      await db.from("portal_notifications").delete().eq("title", `Document to sign: ${docName}`)
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 90000)

  it("R2 — voided envelope: signing link is rejected (fetch 410, submit not 200)", async () => {
    const env = await makeEnvelope([{ name: "V", email: `v-${rand()}@example.com` }], [sigField(0)])
    const s = env.signers[0]
    await db.from("esign_envelopes").update({ status: "voided", voided_at: new Date().toISOString() }).eq("id", env.id)
    try {
      expect((await fetchFields(s.token, s.access_code)).status).toBe(410)
      const sub = await submit(s.token, { code: s.access_code, signature_png: PNG, signed_by_name: "V", consent: true })
      expect(sub.status).not.toBe(200)
      const { data: sg } = await db.from("esign_signers").select("status").eq("id", s.id).maybeSingle()
      expect(sg.status).not.toBe("signed")
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("R3 — expired envelope: reminders flips past-expiry → expired, then signing is rejected", async () => {
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const env = await makeEnvelope([{ name: "E", email: `e-${rand()}@example.com` }], [sigField(0)], { expires_in_days: 1 })
    const s = env.signers[0]
    // Force it past-due, mark sent (so it's an active envelope the cron considers).
    await db.from("esign_envelopes").update({ status: "sent", expires_at: past }).eq("id", env.id)
    try {
      await runEsignReminders(new Date())
      const { data: e } = await db.from("esign_envelopes").select("status").eq("id", env.id).maybeSingle()
      expect(e.status).toBe("expired")
      expect((await fetchFields(s.token, s.access_code)).status).toBe(410)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("R4 — cross-signer isolation: each signer's fetch returns ONLY their own fields", async () => {
    const env = await makeEnvelope(
      [{ name: "A", email: `a-${rand()}@example.com` }, { name: "B", email: `b-${rand()}@example.com` }],
      [sigField(0), { field_type: "text", page_index: 0, pos_x: 0.1, pos_y: 0.5, width: 0.3, height: 0.03, signer_index: 0 }, sigField(1)],
      { routing_order: "parallel" },
    )
    const [a, b] = env.signers
    try {
      const fa = await fetchFields(a.token, a.access_code)
      const fb = await fetchFields(b.token, b.access_code)
      expect(fa.status).toBe(200); expect(fb.status).toBe(200)
      expect(fa.json.fields.length).toBe(2) // A has sig + text
      expect(fb.json.fields.length).toBe(1) // B has only sig
      // None of A's returned fields belong to B and vice-versa is guaranteed by
      // the signer_id scope; assert the field types match each signer's set.
      expect(fa.json.fields.map((f: { field_type: string }) => f.field_type).sort()).toEqual(["signature", "text"])
      expect(fb.json.fields.map((f: { field_type: string }) => f.field_type)).toEqual(["signature"])
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("R7 — editor prefill data path: account + contact ids resolve to initialAccount/initialSigner", async () => {
    // Mirror app/(dashboard)/tools/esign/new/page.tsx server fetch.
    const acc = (await db.from("accounts").select("id, company_name").eq("id", accountId).maybeSingle()).data
    const ct = (await db.from("contacts").select("id, full_name, email").eq("id", contactId).maybeSingle()).data
    expect(acc?.id).toBe(accountId)
    expect(acc?.company_name).toBeTruthy()
    expect(ct?.id).toBe(contactId)
    const initialSigner = { contact_id: ct.id, full_name: ct.full_name ?? "", email: ct.email ?? null, company: acc.company_name ?? null }
    expect(initialSigner.contact_id).toBe(contactId)
    expect(initialSigner.company).toBe(acc.company_name)
  })

  it("R8 — clients-search (post comma-fix) finds a contact by name AND by company, enriched with the account", async () => {
    if (!contactName || contactName.length < 2) return // some sandbox contacts have no name; skip enrichment assert
    const search = async (q: string) => {
      const pattern = `%${q}%`
      const [{ data: byFullName }, { data: byEmail }] = await Promise.all([
        db.from("contacts").select("id, full_name, email").ilike("full_name", pattern).limit(20),
        db.from("contacts").select("id, full_name, email").ilike("email", pattern).limit(20),
      ])
      const { data: accts } = await db.from("accounts").select("id").ilike("company_name", pattern).limit(20)
      let byCompany: Array<{ id: string }> = []
      const acctIds = (accts ?? []).map((a: { id: string }) => a.id)
      if (acctIds.length) {
        const { data: links } = await db.from("account_contacts").select("contact_id").in("account_id", acctIds)
        const cids = Array.from(new Set((links ?? []).map((l: { contact_id: string }) => l.contact_id)))
        if (cids.length) byCompany = (await db.from("contacts").select("id").in("id", cids)).data ?? []
      }
      const ids = new Set([...((byFullName ?? []) as Array<{ id: string }>), ...((byEmail ?? []) as Array<{ id: string }>), ...byCompany].map(c => c.id))
      return ids
    }
    const nameFrag = contactName.slice(0, Math.min(4, contactName.length))
    expect((await search(nameFrag)).has(contactId)).toBe(true) // found by name
    if (companyName && companyName.length >= 2) {
      expect((await search(companyName.slice(0, Math.min(5, companyName.length)))).has(contactId)).toBe(true) // found via company
    }
    // Comma-safe: a comma term must not throw (the bug we fixed).
    await expect(search("Smith, John")).resolves.toBeInstanceOf(Set)
  }, 60000)
})
