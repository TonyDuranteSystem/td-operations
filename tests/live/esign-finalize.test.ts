import { describe, it, expect } from "vitest"
import { PDFDocument } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignEnvelope, flattenEnvelopeToSignedPdf, finalizeEsignCompletion } from "@/lib/operations/esign"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

describe("esign finalize completion (live sandbox)", () => {
  it("files the signed PDF into the linked account's documents (portal-visible)", async () => {
    expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)
    expect(process.env.SANDBOX_MODE).toBe("1")

    const { data: accts } = await db.from("accounts").select("id, company_name").limit(1)
    const account = accts?.[0]
    expect(account, "need an account in sandbox").toBeTruthy()

    const doc = await PDFDocument.create()
    doc.addPage([612, 792])
    const bytes = Buffer.from(await doc.save())

    const env = await createEsignEnvelope({
      document_name: "FINALIZE TEST (auto-cleanup)",
      pdfBuffer: bytes,
      fileName: "finalize-test.pdf",
      pageCount: 1,
      owner_account_id: account.id,
      signers: [{ name: "Test Signer", email: "finalize-test@example.test" }],
      fields: [{ field_type: "date", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.2, height: 0.03, signer_index: 0 }],
    })

    let docId: string | null = null
    try {
      const { signedPath } = await flattenEnvelopeToSignedPdf(env.id)
      await db.from("esign_envelopes").update({ signed_pdf_path: signedPath, status: "completed" }).eq("id", env.id)
      await finalizeEsignCompletion(env.id)

      // The signed PDF is filed into the client's documents either via Google
      // Drive (account has a drive_folder_id) or the storage fallback. Match on
      // the document name + account so the test holds for BOTH paths.
      const { data: docRow } = await db
        .from("documents")
        .select("id, portal_visible, drive_link, drive_file_id, category, document_type_name, confidence, status")
        .eq("account_id", account.id)
        .eq("document_type_name", "FINALIZE TEST (auto-cleanup)")
        .maybeSingle()

      expect(docRow, "expected a documents row for the signed PDF").toBeTruthy()
      expect(docRow.portal_visible).toBe(true)
      expect(docRow.category).toBe(5)
      docId = docRow.id
      console.warn(`filed doc ${docId} ("${docRow.document_type_name}", drive_file_id=${String(docRow.drive_file_id).slice(0, 24)}…, status=${docRow.status}) into ${account.company_name}`)

      // Idempotency: finalize again → no duplicate row.
      await finalizeEsignCompletion(env.id)
      const { data: dupes } = await db.from("documents").select("id").eq("account_id", account.id).eq("document_type_name", "FINALIZE TEST (auto-cleanup)")
      expect((dupes ?? []).length).toBe(1)
    } finally {
      if (docId) await db.from("documents").delete().eq("id", docId)
      await db.from("esign_envelopes").delete().eq("id", env.id)
    }
  }, 90000)
})
