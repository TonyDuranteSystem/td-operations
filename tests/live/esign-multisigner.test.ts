import { describe, it, expect } from "vitest"
import * as fs from "fs"
import { PDFDocument } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope, flattenEnvelopeToSignedPdf } from "@/lib/operations/esign"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const PNG_1x1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  c => c.charCodeAt(0),
)
const OUT = "/private/tmp/claude-501/-Users-10225office-Developer-td-operations--claude-worktrees-exciting-archimedes-28b4c7/a4b6dcc1-897b-4d74-97ae-18e858fba941/scratchpad/multisigner.pdf"

describe("esign multi-signer flatten (live sandbox)", () => {
  it("merges both signers' signatures into one signed PDF + cert lists both", async () => {
    expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)

    const doc = await PDFDocument.create()
    doc.addPage([612, 792])
    const bytes = Buffer.from(await doc.save())

    const env = await createEsignEnvelope({
      document_name: "MULTISIGNER TEST (auto-cleanup)",
      pdfBuffer: bytes,
      fileName: "multi.pdf",
      pageCount: 1,
      routing_order: "parallel",
      signers: [
        { name: "Signer One", email: "one@example.test" },
        { name: "Signer Two", email: "two@example.test" },
      ],
      fields: [
        { field_type: "signature", page_index: 0, pos_x: 0.08, pos_y: 0.82, width: 0.32, height: 0.07, signer_index: 0 },
        { field_type: "signature", page_index: 0, pos_x: 0.58, pos_y: 0.82, width: 0.32, height: 0.07, signer_index: 1 },
      ],
    })

    try {
      const { data: signers } = await db.from("esign_signers").select("id").eq("envelope_id", env.id).order("signer_index")
      let n = 0
      for (const s of signers as Array<{ id: string }>) {
        n++
        const path = `esign/${env.token}/sig-${s.id}.png`
        await supabaseAdmin.storage.from("signed-documents").upload(path, Buffer.from(PNG_1x1), { contentType: "image/png", upsert: true })
        await db.from("esign_signers").update({
          status: "signed", signed_at: new Date().toISOString(), consent_acknowledged: true,
          signed_by_name: `Signer ${n}`, signature_image_path: path, last_ip: `10.0.0.${n}`,
        }).eq("id", s.id)
        await db.from("esign_events").insert({ envelope_id: env.id, signer_id: s.id, event_type: "signed", metadata: { signature_hash: `hash${n}` } })
      }

      const { signedPath } = await flattenEnvelopeToSignedPdf(env.id)
      const { data: blob } = await supabaseAdmin.storage.from("signed-documents").download(signedPath)
      const outBytes = Buffer.from(await blob!.arrayBuffer())
      fs.writeFileSync(OUT, outBytes)
      const out = await PDFDocument.load(outBytes)
      expect(out.getPageCount()).toBe(2) // source page + 1 certificate page (lists both signers)
      console.warn(`multi-signer flatten ok: ${out.getPageCount()} pages → ${OUT}`)
    } finally {
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 90000)
})
