/**
 * Live sandbox QA for the NEW per-signer delivery routing (this session's code):
 * lib/esign/dispatch-delivery.ts — CRM client w/ portal login → portal (notification,
 * no email); CRM client w/o login → email; third party → email; no-contact-no-email →
 * none. Also exercises the in-portal To-Sign `contact_id`-OR-email match query.
 * SANDBOX_MODE=1 (no real email). Each test cleans up its own data.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { PDFDocument } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope, type EsignSignerInput, type EsignFieldInput } from "@/lib/operations/esign"
import { dispatchSignerDelivery } from "@/lib/esign/dispatch-delivery"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const sigField = (signer_index: number): EsignFieldInput => ({ field_type: "signature", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.3, height: 0.06, signer_index })

async function makeEnvelope(signers: EsignSignerInput[], extra: Record<string, unknown> = {}) {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  const pdfBuffer = Buffer.from(await doc.save())
  return createEsignEnvelope({
    document_name: "QA CHANNEL ROUTING (auto-cleanup)",
    pdfBuffer, fileName: "qa.pdf", pageCount: 1,
    signers, fields: signers.map((_, i) => sigField(i)),
    routing_order: "parallel", origin: "staff",
    ...extra,
  })
}

let accountId: string
let contactId: string
let portalLoginEmail: string
const rand = () => Math.random().toString(36).slice(2, 10)

beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)
  const { data: a } = await db.from("accounts").select("id").limit(1)
  accountId = a?.[0]?.id
  const { data: c } = await db.from("contacts").select("id").limit(1)
  contactId = c?.[0]?.id
  // A real sandbox auth-user email = a contact WITH a portal login. Use the same
  // admin source findAuthUserByEmail uses, so the lookup is guaranteed to match.
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1 })
  portalLoginEmail = list?.users?.[0]?.email
  expect(accountId).toBeTruthy()
  expect(contactId).toBeTruthy()
  expect(portalLoginEmail).toBeTruthy()
})

async function jobCountFor(signerId: string) {
  const { data } = await db.from("job_queue").select("id").eq("job_type", "esign_send_email").eq("payload->>signer_id", signerId)
  return (data ?? []).length
}

describe("E-Sign delivery channel routing (live sandbox)", () => {
  it("CR1 — CRM client WITH a portal login → portal (signer sent, sign_document notification, NO email job)", async () => {
    const env = await makeEnvelope(
      [{ name: "Portal Client", email: portalLoginEmail, contact_id: contactId }],
      { owner_account_id: accountId, contact_id: contactId },
    )
    const sid = env.signers[0].id
    try {
      const channel = await dispatchSignerDelivery({ signerId: sid, baseUrl: "https://t" })
      expect(channel).toBe("portal")

      const { data: s } = await db.from("esign_signers").select("status, sent_at").eq("id", sid).maybeSingle()
      expect(s.status).toBe("sent")
      expect(s.sent_at).toBeTruthy()

      expect(await jobCountFor(sid)).toBe(0) // portal channel does NOT email

      const { data: notif } = await db.from("portal_notifications")
        .select("id, type").eq("contact_id", contactId).eq("type", "sign_document")
        .order("created_at", { ascending: false }).limit(1)
      expect((notif ?? []).length).toBe(1) // nudge notification created

      const { data: ev } = await db.from("esign_events").select("event_type, metadata").eq("signer_id", sid).eq("event_type", "sent").maybeSingle()
      expect(ev?.metadata?.channel).toBe("portal")
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.envelopeId ?? env.id)
    }
  })

  it("CR2 — CRM client WITHOUT a portal login → email (job enqueued, no portal notification)", async () => {
    const noLogin = `no-login-${rand()}@example.com`
    const env = await makeEnvelope(
      [{ name: "Unregistered CRM", email: noLogin, contact_id: contactId }],
      { owner_account_id: accountId },
    )
    const sid = env.signers[0].id
    try {
      const channel = await dispatchSignerDelivery({ signerId: sid, baseUrl: "https://t" })
      expect(channel).toBe("email")
      expect(await jobCountFor(sid)).toBe(1)
    } finally {
      await db.from("job_queue").delete().eq("job_type", "esign_send_email").eq("payload->>signer_id", sid)
      await db.from("esign_envelopes").delete().eq("id", env.envelopeId ?? env.id)
    }
  })

  it("CR2b — idempotent email dispatch: dispatching the SAME signer twice enqueues ONE job (no duplicate invite)", async () => {
    const env = await makeEnvelope([{ name: "Once", email: `once-${rand()}@example.com`, contact_id: null }])
    const sid = env.signers[0].id
    try {
      const c1 = await dispatchSignerDelivery({ signerId: sid, baseUrl: "https://t" })
      const c2 = await dispatchSignerDelivery({ signerId: sid, baseUrl: "https://t" }) // double-click / retry
      expect(c1).toBe("email")
      expect(c2).toBe("email")
      expect(await jobCountFor(sid)).toBe(1) // exactly one invite job
      const { data: s } = await db.from("esign_signers").select("status").eq("id", sid).maybeSingle()
      expect(s.status).toBe("sent")
    } finally {
      await db.from("job_queue").delete().eq("job_type", "esign_send_email").eq("payload->>signer_id", sid)
      await db.from("esign_envelopes").delete().eq("id", env.envelopeId ?? env.id)
    }
  })

  it("CR3 — third party (no contact_id) → email (job enqueued)", async () => {
    const env = await makeEnvelope([{ name: "Third Party", email: `third-${rand()}@example.com`, contact_id: null }])
    const sid = env.signers[0].id
    try {
      const channel = await dispatchSignerDelivery({ signerId: sid, baseUrl: "https://t" })
      expect(channel).toBe("email")
      expect(await jobCountFor(sid)).toBe(1)
    } finally {
      await db.from("job_queue").delete().eq("job_type", "esign_send_email").eq("payload->>signer_id", sid)
      await db.from("esign_envelopes").delete().eq("id", env.envelopeId ?? env.id)
    }
  })

  it("CR4 — signer with no contact and no email → none (undeliverable, no job)", async () => {
    // Seed directly (the create route blocks this, but the dispatcher must be safe).
    const env = await makeEnvelope([{ name: "Has Email", email: `x-${rand()}@example.com`, contact_id: null }])
    const { data: bare } = await db.from("esign_signers")
      .insert({ envelope_id: env.envelopeId ?? env.id, signer_index: 1, name: "No Contact No Email", status: "pending" })
      .select("id").single()
    try {
      const channel = await dispatchSignerDelivery({ signerId: bare.id, baseUrl: "https://t" })
      expect(channel).toBe("none")
      expect(await jobCountFor(bare.id)).toBe(0)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.envelopeId ?? env.id)
    }
  })

  it("CR5 — terminal envelope (voided) → dispatch returns none for a portal signer", async () => {
    const env = await makeEnvelope(
      [{ name: "Portal Client", email: portalLoginEmail, contact_id: contactId }],
      { owner_account_id: accountId },
    )
    const sid = env.signers[0].id
    await db.from("esign_envelopes").update({ status: "voided" }).eq("id", env.envelopeId ?? env.id)
    try {
      const channel = await dispatchSignerDelivery({ signerId: sid, baseUrl: "https://t" })
      expect(channel).toBe("none")
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.envelopeId ?? env.id)
    }
  })

  it("CR6 — in-portal To-Sign matches a CRM signer by contact_id even when the email differs", async () => {
    const env = await makeEnvelope(
      [{ name: "CRM Client", email: `different-${rand()}@example.com`, contact_id: contactId }],
      { owner_account_id: accountId },
    )
    const sid = env.signers[0].id
    // Mark sent/viewed so it's "their turn" (matches the portal/sign predicate).
    await db.from("esign_signers").update({ status: "sent" }).eq("id", sid)
    await db.from("esign_envelopes").update({ status: "sent" }).eq("id", env.envelopeId ?? env.id)
    try {
      // Replicate app/portal/sign/page.tsx: match by contact_id OR login email.
      const loginEmail = "totally-unrelated@example.com" // deliberately NOT the signer email
      const { data: rows } = await db.from("esign_signers")
        .select("token, status, esign_envelopes!inner(document_name, status)")
        .or(`contact_id.eq.${contactId},email.ilike.${loginEmail}`)
        .in("status", ["sent", "viewed"])
      const found = (rows ?? []).some((r: { token: string }) => r.token === env.signers[0].token)
      expect(found).toBe(true) // matched by contact_id, not email
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.envelopeId ?? env.id)
    }
  })
})
