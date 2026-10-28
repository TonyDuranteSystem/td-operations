/**
 * POST /api/crm/admin-actions/workspace-check — "is a workspace step waiting for this file?" for the CONTACT page's "Upload Document"
 * (dev job e3215801, Door A). Read-only, staff only.
 * Body: { contact_id, document_type, category } — the same fields the upload itself sends, read by the same mapping
 * (`contactUploadRouting`), so the check and the save always mean the same thing -> { hits: WaitingWorkspaceStep[] }.
 * The page asks it BEFORE the file is staged; a hit makes it show the pop-up (Open the workspace / Save in Storage only).
 * A check that cannot be completed answers 503 and the page uploads nothing — it never lets the file through unchecked.
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const contactId = typeof body.contact_id === 'string' ? body.contact_id : ''
  const documentType = typeof body.document_type === 'string' && body.document_type ? body.document_type : 'Other'
  const category = typeof body.category === 'string' ? body.category : undefined
  if (!contactId) return NextResponse.json({ error: 'Missing contact_id' }, { status: 400 })
  try {
    const { contactUploadRouting } = await import('@/lib/crm-store/contact-upload-routing')
    const { findWaitingWorkspaceStepsForContact } = await import('@/lib/flows/storage-step-hints')
    const { storeType, checkFolderKind } = contactUploadRouting(documentType, category)
    const hits = await findWaitingWorkspaceStepsForContact({ contactId, documentType: storeType, folderKind: checkFolderKind })
    return NextResponse.json({ hits }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Could not check whether a workspace is waiting for this file — nothing was uploaded. Please try again.' }, { status: 503 })
  }
}
