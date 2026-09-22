/**
 * List the documents a client uploaded on an onboarding submission that has
 * not yet been reviewed by staff — i.e. before any account or Drive folder
 * exists (dev job bc2a8f7f, Antonio's 2026-09-20 staff-review-first decision).
 *
 * Deliberately NOT the same endpoint as /api/flows/[id]/documents: that one
 * reads the `documents` table keyed by service_delivery_id, which does not
 * exist yet at this stage. This reads straight off
 * onboarding_submissions.upload_paths in Supabase Storage and mints
 * short-lived signed URLs, matching the AI Architect's finding that the
 * existing DocumentViewer component cannot be reused pre-account-creation.
 *
 * GET → { success, documents: [{ path, file_name, url }] }
 * [id] = onboarding_submissions.id.
 *
 * Read-only, staff-only.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { createSignedUrlMap } from '@/lib/storage/signed-urls'

const UPLOAD_BUCKET = 'onboarding-uploads'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const { data: sub, error } = await supabaseAdmin
      .from('onboarding_submissions')
      .select('token, contact_id, account_id, offer_id, lead_id, upload_paths')
      .eq('id', params.id)
      .single()

    if (error || !sub) {
      return NextResponse.json({ success: false, error: 'Submission not found' }, { status: 404 })
    }

    const allPaths = (sub.upload_paths as string[] | null) || []

    // Ownership check (2026-09-20, bug-hunter finding on dev job bc2a8f7f):
    // upload_paths is written from client-submitted data with only a prefix
    // check upstream (lib/portal/wizard-uploads.ts), not a real ownership
    // check — a crafted submission could in principle reference another
    // client's storage path. This route is the first place a stored path
    // becomes a clickable signed link for staff, so it must not trust
    // upload_paths blindly: only sign a path that actually belongs to THIS
    // submission.
    //
    // The real upload path's identifier (app/portal/wizard/wizard-client.tsx)
    // is `leadId || offerId || accountId || contactId` — account_id is always
    // forced null pre-review (staff-review-first), so in practice this is
    // leadId for a first-time onboarding, offerId for a returning client's
    // second+ company (no lead — dev job bc2a8f7f, corrected 2026-09-21), or
    // contactId as the final fallback. Missing ANY of these here means every
    // real document for that case is silently filtered out with zero
    // indication to staff (found live in sandbox QA, 2026-09-20 for the
    // accountId case, then again 2026-09-22 for the offer_id case: "3
    // documents uploaded but none could be shown" — lead_id was never in this
    // list at all and is added here from the same audit, before it could bite
    // the far more common first-time-onboarding path the same way).
    const ownedPrefixes = [
      `${sub.token}/`,
      sub.account_id ? `onboarding/${sub.account_id}/` : null,
      sub.lead_id ? `onboarding/${sub.lead_id}/` : null,
      sub.offer_id ? `onboarding/${sub.offer_id}/` : null,
      sub.contact_id ? `onboarding/${sub.contact_id}/` : null,
    ].filter((p): p is string => !!p)
    const uploadPaths = allPaths.filter((p) => ownedPrefixes.some((prefix) => p.startsWith(prefix)))
    const rejectedCount = allPaths.length - uploadPaths.length

    const signedMap = await createSignedUrlMap(UPLOAD_BUCKET, uploadPaths)

    const documents = uploadPaths.map((path) => {
      const cleanPath = path.replace(/^\/+/, '')
      const fileName = cleanPath.split('/').pop() || cleanPath
      return {
        path,
        file_name: fileName,
        url: signedMap.get(path) || null,
      }
    })

    if (rejectedCount > 0) {
      // eslint-disable-next-line no-console
      console.error(`[onboarding-review documents] Rejected ${rejectedCount} path(s) not owned by submission ${params.id}`)
    }

    return NextResponse.json(
      { success: true, documents },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    )
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
