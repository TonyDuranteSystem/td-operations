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

  return NextResponse.json(shapeOcr(doc))
}

/**
 * POST — run OCR on this document now (extract text + classify), then return
 * the refreshed OCR text. Admin/team only.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || isClient(user)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const { id } = params

  const { data: doc, error } = await supabaseAdmin
    .from("documents")
    .select("id, drive_file_id, account_id, account_name, contact_id")
    .eq("id", id)
    .single()

  if (error || !doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 })
  }
  if (!doc.drive_file_id) {
    return NextResponse.json({ error: "This document has no Drive file to OCR." }, { status: 400 })
  }

  // CRM Store pilot (job 685467b5): the bytes live in the new store, not in Drive. Read them there and
  // save the text on THIS row. The document type is already known (it was chosen when the file was
  // saved), so the Drive classifier is not run and the row's type / category / visibility stay as they are.
  const { parseStorePointer } = await import("@/lib/crm-store/document-pointer")
  const storeFileId = parseStorePointer(doc.drive_file_id)
  if (storeFileId) {
    try {
      const { ocrByPointer } = await import("@/lib/crm-store/ocr")
      const ocr = await ocrByPointer(doc.drive_file_id)
      const { error: upErr } = await supabaseAdmin.from("documents").update({
        ocr_text: ocr.fullText || null,
        ocr_page_count: ocr.pageCount || null,
        ocr_confidence: ocr.confidence || null,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", id)
      if (upErr) return NextResponse.json({ error: `The text was read but could not be saved: ${upErr.message}` }, { status: 500 })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "OCR failed" }, { status: 500 })
    }
    const { data: fresh } = await supabaseAdmin
      .from("documents")
      .select("id, file_name, document_type_name, ocr_text, ocr_page_count, ocr_confidence, status, processed_at")
      .eq("id", id)
      .maybeSingle()
    return NextResponse.json(shapeOcr(fresh ?? doc))
  }

  const { processFile } = await import("@/lib/mcp/tools/doc")
  const result = await processFile(
    doc.drive_file_id,
    doc.account_id ?? undefined,
    doc.account_name ?? undefined,
    doc.contact_id ?? undefined,
  )
  if (!result.success) {
    return NextResponse.json({ error: result.error || "OCR failed" }, { status: 500 })
  }

  // Re-read the (upserted) row for the fresh OCR text.
  const { data: fresh } = await supabaseAdmin
    .from("documents")
    .select("id, file_name, document_type_name, ocr_text, ocr_page_count, ocr_confidence, status, processed_at")
    .eq("drive_file_id", doc.drive_file_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json(shapeOcr(fresh ?? doc))
}

function shapeOcr(doc: Record<string, unknown>) {
  const ocrText = (doc.ocr_text as string | null) ?? null
  return {
    id: doc.id ?? null,
    file_name: (doc.file_name as string | null) ?? null,
    document_type_name: (doc.document_type_name as string | null) ?? null,
    ocr_text: ocrText,
    ocr_page_count: (doc.ocr_page_count as number | null) ?? null,
    ocr_confidence: (doc.ocr_confidence as string | null) ?? null,
    status: (doc.status as string | null) ?? null,
    processed_at: (doc.processed_at as string | null) ?? null,
    has_ocr: !!(ocrText && String(ocrText).trim().length > 0),
  }
}
