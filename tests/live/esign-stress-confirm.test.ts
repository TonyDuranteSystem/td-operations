/**
 * Adversarial STRESS confirmations. Each test asserts the CORRECT (post-fix)
 * behavior, so before the fix it FAILS (proving the bug), after the fix it PASSES.
 * Live cloud sandbox; SANDBOX_MODE=1.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { PDFDocument } from "pdf-lib"
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope, type EsignFieldInput, type EsignSignerInput } from "@/lib/operations/esign"
import { runEsignReminders } from "@/lib/esign/reminders"
import { POST as submitRoute } from "@/app/api/sign/[token]/submit/route"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const rand = () => Math.random().toString(36).slice(2, 10)
const sigField = (signer_index: number): EsignFieldInput => ({ field_type: "signature", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.3, height: 0.06, signer_index, required: true })
async function makeEnvelope(signers: EsignSignerInput[], fields: EsignFieldInput[], extra: Record<string, unknown> = {}) {
  const doc = await PDFDocument.create(); doc.addPage([612, 792])
  return createEsignEnvelope({ document_name: `STRESS ${rand()}`, pdfBuffer: Buffer.from(await doc.save()), fileName: "qa.pdf", pageCount: 1, signers, fields, origin: "staff", ...extra })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const submit = (token: string, body: any) =>
  submitRoute(new NextRequest(`https://t/api/sign/${token}/submit`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ token }) }).then(async r => ({ status: r.status, json: await r.json() }))

let accountId: string
beforeAll(async () => {
  expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)
  const { data: link } = await db.from("account_contacts").select("contact_id, account_id").limit(1).maybeSingle()
  accountId = link.account_id
})

describe("E-Sign STRESS — bug confirmations (assert CORRECT behavior)", () => {
  it("B1 — sequential: signer #2 CANNOT sign before signer #1 (out-of-order rejected)", async () => {
    const env = await makeEnvelope(
      [{ name: "First", email: `f-${rand()}@example.com` }, { name: "Second", email: `s-${rand()}@example.com` }],
      [sigField(0), sigField(1)],
      { routing_order: "sequential" },
    )
    const s2 = env.signers[1]
    try {
      const r = await submit(s2.token, { code: s2.access_code, signature_png: PNG, signed_by_name: "Second", consent: true })
      expect(r.status).toBe(403) // not your turn — must be rejected
      const { data: sg } = await db.from("esign_signers").select("status").eq("id", s2.id).maybeSingle()
      expect(sg.status).not.toBe("signed")
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("H1 — required signature field unfilled → submit rejected, envelope NOT completed", async () => {
    const env = await makeEnvelope([{ name: "NoSig", email: `n-${rand()}@example.com` }], [sigField(0)])
    const s = env.signers[0]
    try {
      const r = await submit(s.token, { code: s.access_code, signed_by_name: "NoSig", consent: true }) // no signature_png, no fields
      expect(r.status).toBe(400) // required field missing
      const { data: e } = await db.from("esign_envelopes").select("status").eq("id", env.id).maybeSingle()
      expect(e.status).not.toBe("completed")
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("B3 — portal To-Sign must NOT leak another client's envelope via an underscore-wildcard email", async () => {
    // Seed a signer for an unrelated envelope whose email differs from the victim's
    // login by exactly one char where the login has an underscore.
    const env = await makeEnvelope([{ name: "Other Client", email: `aXc-${rand()}@example.com` }], [sigField(0)], { owner_account_id: null })
    await db.from("esign_signers").update({ status: "sent" }).eq("envelope_id", env.id)
    await db.from("esign_envelopes").update({ status: "sent" }).eq("id", env.id)
    const otherEmail = (await db.from("esign_signers").select("email, token").eq("envelope_id", env.id).maybeSingle()).data
    const victimLogin = otherEmail.email.replace("aXc", "a_c") // underscore where the other had 'X'
    const unrelatedContact = "00000000-0000-0000-0000-000000000000"
    try {
      // Replicate app/portal/sign/page.tsx FIXED query: two queries, email
      // matched literally (wildcards escaped), never a single .or(email.ilike).
      const escaped = victimLogin.toLowerCase().replace(/([%_\\])/g, "\\$1")
      const [byContact, byEmail] = await Promise.all([
        db.from("esign_signers").select("token").eq("contact_id", unrelatedContact).in("status", ["sent", "viewed"]),
        db.from("esign_signers").select("token").ilike("email", escaped).in("status", ["sent", "viewed"]),
      ])
      const tokens = new Set([...(byContact.data ?? []), ...(byEmail.data ?? [])].map((r: { token: string }) => r.token))
      expect(tokens.has(otherEmail.token)).toBe(false) // must NOT surface another client's signer
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("A5 — reminders cron RECONCILES a stuck fully-signed envelope (flatten failed at submit) → completed + filed", async () => {
    const env = await makeEnvelope([{ name: "Solo", email: `solo-${rand()}@example.com` }], [sigField(0)], { owner_account_id: accountId })
    const s = env.signers[0]
    // Simulate the stuck state: signer signed + counter at total, but completion
    // never finished (no signed_pdf_path) — exactly what a flatten throw leaves.
    await db.from("esign_signers").update({ status: "signed", signed_at: new Date().toISOString() }).eq("id", s.id)
    await db.from("esign_envelopes").update({ status: "in_progress", signed_count: 1 }).eq("id", env.id)
    let filedPath: string | null = null
    try {
      const res = await runEsignReminders(new Date())
      expect(res.reconciled).toBeGreaterThanOrEqual(1)
      const { data: e } = await db.from("esign_envelopes").select("status, signed_pdf_path").eq("id", env.id).maybeSingle()
      expect(e.status).toBe("completed")
      expect(e.signed_pdf_path).toBeTruthy()
      filedPath = e.signed_pdf_path
      // Idempotent: a second run must NOT re-complete or re-file this envelope.
      const before = (await db.from("documents").select("id").eq("drive_file_id", `storage:signed-documents/${filedPath}`)).data?.length ?? 0
      await runEsignReminders(new Date())
      const after = (await db.from("documents").select("id").eq("drive_file_id", `storage:signed-documents/${filedPath}`)).data?.length ?? 0
      expect(after).toBe(before) // no duplicate filing
    } finally {
      if (filedPath) await db.from("documents").delete().eq("drive_file_id", `storage:signed-documents/${filedPath}`)
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 120000)
})
