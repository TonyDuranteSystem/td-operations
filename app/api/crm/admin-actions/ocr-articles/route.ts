/**
 * OCR Articles of Organization
 *
 * POST { storage_path, file_name, mime_type }
 *
 * Downloads the file from Supabase Storage (onboarding-uploads bucket),
 * runs Document AI OCR, then parses structured fields:
 *   - company_name (LLC name from the filing)
 *   - entity_type (LLC type — single, multi, etc.)
 *   - state_of_formation (state that issued the filing)
 *   - formation_date (filing/effective date)
 *   - filing_id (state filing number)
 *   - registered_agent (RA name if present)
 *
 * Returns the parsed fields for the chain audit form to auto-fill.
 *
 * The parsing rules live in lib/articles-parse.ts — the ONE parser shared with the formation workspace's Articles upload
 * (this route used to carry its own older copy, which read dates and Filing IDs less well; job 64d2be64).
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { ocrRawContent } from "@/lib/docai"
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { parseArticlesText } from "@/lib/articles-parse"

// ─── POST Handler ───

export async function POST(req: NextRequest) {
  // STAFF ONLY: /api/* inherits only "is logged in" from the middleware, and a portal client has a login.
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const { storage_path, file_name, mime_type } = await req.json()

    if (!storage_path || !file_name) {
      return NextResponse.json({ error: "storage_path and file_name required" }, { status: 400 })
    }

    // Download from Supabase Storage
    const { data: fileData, error: dlError } = await supabaseAdmin
      .storage
      .from("onboarding-uploads")
      .download(storage_path)

    if (dlError || !fileData) {
      return NextResponse.json({ error: `Failed to download: ${dlError?.message ?? "no data"}` }, { status: 500 })
    }

    const buffer = await fileData.arrayBuffer()
    const resolvedMime = mime_type || "application/pdf"

    // Run OCR
    const ocrResult = await ocrRawContent(buffer, resolvedMime, file_name)

    if (!ocrResult.fullText || ocrResult.fullText.length < 20) {
      return NextResponse.json({
        error: "OCR returned insufficient text. The file may be an image that couldn't be read, or it may be empty.",
        raw_text: ocrResult.fullText ?? "",
      }, { status: 422 })
    }

    // Parse structured fields
    const parsed = parseArticlesText(ocrResult.fullText)

    return NextResponse.json({
      success: true,
      ...parsed,
      raw_text: ocrResult.fullText,
      page_count: ocrResult.pageCount,
      ocr_confidence: ocrResult.confidence,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
