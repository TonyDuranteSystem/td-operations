/**
 * GET /api/flows/[id]/articles-formation-date?storage_path=<path>
 *
 * Best-effort OCR prefill for the "Confirm formation date" step when uploading
 * the Articles of Organization in the formation workspace. The UI stages the
 * file to Supabase Storage (onboarding-uploads) first, then calls this with the
 * storage_path to get a suggested filing date that staff confirm/correct before
 * the upload commits and materializes the company.
 *
 * Also returns `articles_name` — the company name printed on the Articles (null when it cannot be read with confidence) —
 * which only PREFILLS the window's "Company legal name" field; staff confirm it (job 80cce1cb).
 *
 * Never throws to the caller — on any failure it returns { formation_date: null }
 * and the UI falls back to manual entry. [id] = service_delivery_id (audit only).
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { ocrRawContent } from '@/lib/docai'
import { parseFormationDate, parseArticlesCompanyName } from '@/lib/articles-parse'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

export async function GET(req: NextRequest, { params: _params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const storagePath = req.nextUrl.searchParams.get('storage_path')
    if (!storagePath) {
      return NextResponse.json({ success: true, formation_date: null, reason: 'no_storage_path' })
    }

    const { data, error } = await supabaseAdmin.storage.from('onboarding-uploads').download(storagePath)
    if (error || !data) {
      return NextResponse.json({ success: true, formation_date: null, reason: 'storage_download_failed' })
    }

    const buf = Buffer.from(await data.arrayBuffer())
    const mimeType = data.type || 'application/pdf'
    const fileName = storagePath.split('/').pop() || 'articles.pdf'

    const ocr = await ocrRawContent(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      mimeType,
      fileName,
    )
    const formationDate = ocr?.fullText ? parseFormationDate(ocr.fullText) : null
    // The company name printed on the Articles — PREFILL only for the window's "Company legal name" field (staff confirm it).
    const articlesName = ocr?.fullText ? parseArticlesCompanyName(ocr.fullText) : null

    return NextResponse.json({ success: true, formation_date: formationDate, articles_name: articlesName })
  } catch (e) {
    // Best-effort: never block the workspace. UI falls back to manual entry.
    return NextResponse.json({ success: true, formation_date: null, reason: e instanceof Error ? e.message : 'ocr_failed' })
  }
}
