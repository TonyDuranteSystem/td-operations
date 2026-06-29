import { describe, it, expect } from "vitest"
import { PDFDocument } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createEsignTemplate, getEsignTemplate, listEsignTemplates } from "@/lib/operations/esign"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

describe("esign templates (live sandbox)", () => {
  it("creates a template, reads it back, lists it, and enforces role validation", async () => {
    expect((process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes("xjcxlmlpeywtwkhstjlw")).toBe(true)

    const doc = await PDFDocument.create()
    doc.addPage([612, 792])
    const bytes = Buffer.from(await doc.save())

    const { id } = await createEsignTemplate({
      name: "TEMPLATE TEST (auto-cleanup)",
      pdfBuffer: bytes,
      fileName: "tpl.pdf",
      pageCount: 1,
      roleCount: 2,
      fields: [
        { field_type: "signature", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.3, height: 0.06, signer_role_index: 0 },
        { field_type: "signature", page_index: 0, pos_x: 0.55, pos_y: 0.8, width: 0.3, height: 0.06, signer_role_index: 1 },
        { field_type: "date", page_index: 0, pos_x: 0.1, pos_y: 0.9, width: 0.15, height: 0.03, signer_role_index: 0 },
      ],
    })

    try {
      const tpl = await getEsignTemplate(id)
      expect(tpl).toBeTruthy()
      expect(tpl!.roleCount).toBe(2)
      expect(tpl!.fields.length).toBe(3)
      expect(tpl!.pdfUrl).toBeTruthy()

      const list = await listEsignTemplates()
      expect(list.some(t => t.id === id)).toBe(true)

      // A role with no fields must be rejected (before any storage write).
      await expect(
        createEsignTemplate({
          name: "bad", pdfBuffer: bytes, fileName: "b.pdf", pageCount: 1, roleCount: 3,
          fields: [{ field_type: "signature", page_index: 0, pos_x: 0.1, pos_y: 0.8, width: 0.2, height: 0.05, signer_role_index: 0 }],
        }),
      ).rejects.toThrow(/role/i)

      console.warn(`template ${id}: roleCount=${tpl!.roleCount}, fields=${tpl!.fields.length}`)
    } finally {
      await db.from("esign_templates").delete().eq("id", id) // cascades template_fields
    }
  }, 60000)
})
