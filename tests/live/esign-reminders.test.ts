import { describe, it, expect } from "vitest"
import { PDFDocument } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope } from "@/lib/operations/esign"
import { runEsignReminders } from "@/lib/esign/reminders"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

async function makeEnvelope() {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  const bytes = Buffer.from(await doc.save())
  return createEsignEnvelope({
    document_name: "REMINDER TEST (auto-cleanup)",
    pdfBuffer: bytes, fileName: "r.pdf", pageCount: 1, routing_order: "parallel",
    signers: [{ name: "S", email: "reminder-test@example.test" }],
    fields: [{ field_type: "signature", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.2, height: 0.05, signer_index: 0 }],
  })
}

describe("esign reminders + expiry (live sandbox)", () => {
  it("expires an envelope past its expires_at", async () => {
    expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)
    const env = await makeEnvelope()
    try {
      await db.from("esign_envelopes").update({ status: "sent", expires_at: new Date(Date.now() - 86400000).toISOString() }).eq("id", env.id)
      await runEsignReminders(new Date())
      const { data: row } = await db.from("esign_envelopes").select("status").eq("id", env.id).maybeSingle()
      expect(row.status).toBe("expired")
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)

  it("enqueues a reminder for an invited-but-unsigned signer past the quiet period", async () => {
    const env = await makeEnvelope()
    const signerId = env.signers[0].id
    try {
      await db.from("esign_envelopes").update({ status: "sent", expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }).eq("id", env.id)
      await db.from("esign_signers").update({ status: "sent", sent_at: new Date(Date.now() - 3 * 86400000).toISOString() }).eq("id", signerId)

      const res = await runEsignReminders(new Date())
      expect(res.reminded).toBeGreaterThanOrEqual(1)

      const { data: jobs } = await db
        .from("job_queue")
        .select("id, payload")
        .eq("job_type", "esign_send_email")
        .contains("payload", { signer_id: signerId, reminder: true })
      expect((jobs ?? []).length).toBeGreaterThanOrEqual(1)
      for (const j of (jobs ?? []) as Array<{ id: string }>) await db.from("job_queue").delete().eq("id", j.id)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 60000)
})
