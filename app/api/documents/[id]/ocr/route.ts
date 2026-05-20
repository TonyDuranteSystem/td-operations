/**
 * Document OCR text API
 * Returns the stored OCR text + metadata for a document so admin/team can read
 * the extracted text from any CRM file view. Read-only; admin dashboard routes
 * are auth-gated by middleware (same as the sibling preview route).
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createClient } from "@/lib/supabase/server"
import { isClient } from "@/lib/auth"

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  // Admin/team only — OCR text can contain sensitive client data.
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || isClient(user)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const { id } = params

  const { data: doc, error } = await supabaseAdmin
    .from("documents")
    .select("id, file_name, document_type_name, ocr_text, ocr_page_count, ocr_confidence, status, processed_at")
    .eq("id", id)
    .single()

  if (error || !doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 })
  }

  return NextResponse.json({
    id: doc.id,
    file_name: doc.file_name,
    document_type_name: doc.document_type_name,
    ocr_text: doc.ocr_text ?? null,
    ocr_page_count: doc.ocr_page_count ?? null,
    ocr_confidence: doc.ocr_confidence ?? null,
    status: doc.status ?? null,
    processed_at: doc.processed_at ?? null,
    has_ocr: !!(doc.ocr_text && String(doc.ocr_text).trim().length > 0),
  })
}
