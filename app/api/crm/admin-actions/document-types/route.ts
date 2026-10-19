/**
 * GET /api/crm/admin-actions/document-types
 *
 * Returns the deduplicated list of document_type_name values seen across the
 * documents table. The upload UI merges this with a hardcoded base list so
 * that any new "Custom" type an admin enters automatically appears as a
 * dropdown option on future uploads.
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

export async function GET() {
  // STAFF ONLY: /api/* inherits only "is logged in" from the middleware, and a portal client has a login.
  const denied = await requireStaffRoute()
  if (denied) return denied
  // Use the DB function so DISTINCT is computed server-side — the documents
  // table has thousands of rows and client-side deduplication would miss
  // custom types beyond the PostgREST row cap.
  const { data, error } = await supabaseAdmin.rpc('get_document_type_names')

  if (error) {
    return NextResponse.json({ types: [], error: error.message }, { status: 500 })
  }

  const types = (data ?? [])
    .map((r: { document_type_name: string }) => r.document_type_name.trim())
    .filter((name: string) => name.length > 0 && name.toLowerCase() !== 'other')

  return NextResponse.json({ types })
}
