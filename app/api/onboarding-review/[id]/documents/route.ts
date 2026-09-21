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
      .select('token, contact_id, account_id, upload_paths')
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
    // is `leadId || accountId || contactId` — for the onboarding wizard,
    // onboarding has no leadId, so it's accountId whenever the client
    // already has ANY account (a returning client onboarding an additional
    // company — a real, common case, not an edge case), falling back to
    // contactId only for a genuinely brand-new client with no account yet.
    // Missing the accountId case here meant every real document for a
    // returning client was silently filtered out with zero indication to
    // staff (found live in sandbox QA, 2026-09-20: "Documents (3)" heading,
    // zero documents rendered, no error shown).
    const ownedPrefixes = [
      `${sub.token}/`,
      sub.account_id ? `onboarding/${sub.account_id}/` : null,
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
