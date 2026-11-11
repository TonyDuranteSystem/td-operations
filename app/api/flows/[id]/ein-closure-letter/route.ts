/**
 * Company Closure, "IRS Closure" — the EIN closure letter (staff only). [id] = service_delivery_id.
 *
 * GET  → { success, facts } what the panel shows: the company's name / EIN, who signs, the address (when we know it), the copies of the EIN notice
 *        on file, the letter already made, and the warnings to read before printing.
 * POST → { address, notice_document_id, facts_hash?, company_name?, ein? } makes the letter, merges the chosen EIN notice behind it and saves the package on the job
 *        (lib/closure/ein-closure-package.ts). Nothing is sent to anyone; the PDF is opened from the job's documents.
 *        company_name / ein = staff's correction of what the client wrote — honoured ONLY on a job with no company of ours (ignored on a company's job).
 */
export const dynamic = 'force-dynamic'
// reading the EIN copy and joining it behind the letter can take a while for a big scan — the default host limit is shorter
export const maxDuration = 60

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
  const raw: unknown = await req.json().catch(() => null)
  const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  if (typeof body.address !== 'string') return NextResponse.json({ success: false, error: 'The company address must be text.' }, { status: 400 })
  const notice = body.notice_document_id
  if (notice !== null && notice !== undefined && typeof notice !== 'string') {
    return NextResponse.json({ success: false, error: 'notice_document_id must be a document id or empty.' }, { status: 400 })
  }
  const factsHash = typeof body.facts_hash === 'string' && body.facts_hash ? body.facts_hash : null
  for (const k of ['company_name', 'ein'] as const) {
    if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') return NextResponse.json({ success: false, error: `${k} must be text.` }, { status: 400 })
  }
  const r = await buildEinClosurePackage({
    jobId: params.id,
    addressLines: splitAddress(body.address),
    noticeDocumentId: (notice as string | null | undefined) || null,
    factsHash,
    companyName: (body.company_name as string | null | undefined) ?? null,
    ein: (body.ein as string | null | undefined) ?? null,
  })
  if (isFail(r)) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, result: r })
}
