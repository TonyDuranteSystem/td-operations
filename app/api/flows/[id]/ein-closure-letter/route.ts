/**
 * Company Closure, "IRS Closure" — the EIN closure letter (staff only). [id] = service_delivery_id.
 *
 * GET  → { success, facts } what the panel shows: the company's name / EIN, who signs, the address (when we know it), the copies of the EIN notice
 *        on file, the letter already made, and the warnings to read before printing.
 * POST → { address, notice_document_id } makes the letter, merges the chosen EIN notice behind it and saves the package on the job
 *        (lib/closure/ein-closure-package.ts). Nothing is sent to anyone; the PDF is opened from the job's documents.
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { loadEinClosureFacts, buildEinClosurePackage, splitAddress, isFail } from '@/lib/closure/ein-closure-package'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const r = await loadEinClosureFacts(params.id)
  if (isFail(r)) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, facts: r.facts })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  if (typeof body.address !== 'string') return NextResponse.json({ success: false, error: 'The company address must be text.' }, { status: 400 })
  const notice = body.notice_document_id
  if (notice !== null && notice !== undefined && typeof notice !== 'string') {
    return NextResponse.json({ success: false, error: 'notice_document_id must be a document id or empty.' }, { status: 400 })
  }
  const r = await buildEinClosurePackage({ jobId: params.id, addressLines: splitAddress(body.address), noticeDocumentId: (notice as string | null | undefined) || null })
  if (isFail(r)) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, result: r })
}
