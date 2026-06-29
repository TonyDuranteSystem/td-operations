import { describe, it, expect } from "vitest"
import { PDFDocument } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope } from "@/lib/operations/esign"
import { handleEsignSendEmail } from "@/lib/jobs/handlers/esign-send-email"
import type { Job } from "@/lib/jobs/queue"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

describe("esign send-email handler (live sandbox; email blocked)", () => {
  it("processes the invite job: signer → sent, plus a 'sent' audit event", async () => {
    expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)
    expect(process.env.SANDBOX_MODE).toBe("1") // guarantees no real email

    const doc = await PDFDocument.create()
    doc.addPage([612, 792])
    const bytes = Buffer.from(await doc.save())

    const env = await createEsignEnvelope({
      document_name: "SEND TEST (auto-cleanup)",
      pdfBuffer: bytes,
      fileName: "send-test.pdf",
      pageCount: 1,
      signers: [{ name: "Test Signer", email: "esign-send-test@example.com" }],
      fields: [{ field_type: "signature", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.2, height: 0.05, signer_index: 0 }],
    })
    const signerId = env.signers[0].id

    try {
      const job = { id: "test-job", job_type: "esign_send_email", payload: { signer_id: signerId, base_url: "https://example.test" }, status: "processing", priority: 5, result: null, error: null, attempts: 0 } as unknown as Job
      const res = await handleEsignSendEmail(job)

      expect(res.steps.some(s => s.name === "send_email" && s.status === "ok")).toBe(true)
      expect(res.steps.some(s => s.name === "mark_sent" && s.status === "ok")).toBe(true)

      const { data: signer } = await db.from("esign_signers").select("status, sent_at").eq("id", signerId).maybeSingle()
      expect(signer.status).toBe("sent")
      expect(signer.sent_at).toBeTruthy()

      const { data: events } = await db.from("esign_events").select("event_type").eq("signer_id", signerId).eq("event_type", "sent")
      expect((events ?? []).length).toBeGreaterThanOrEqual(1)
      console.warn(`handler ok: ${res.summary}`)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id) // cascades signers/fields/events
    }
  }, 60000)
})
