/**
 * GET /api/crm/signed-contracts/[id]/open  ->  { url }
 *
 * Staff only. A short-lived (60 s) private link to the signed PDF of one signing, for the "Open signed contract" button on the
 * Contact page. The path signed is the one RECORDED on the contract row (`contracts.pdf_path`), never a folder listing, so a file
 * planted in the bucket can never be served. A client, a partner or a signed-out visitor is refused.
 *
 * (The client's own copy still goes through /api/offer/[token]/contract-pdf, which needs the offer's access code.)
 */
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createRecordedSignedUrl } from '@/lib/storage/signed-download'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { data, error } = await createClient().auth.getUser()
  if (error || !isStaffUser(data?.user ?? null)) {
    return NextResponse.json({ error: 'Only the team can open a signed contract.' }, { status: 403 })
  }
  if (!UUID.test(params.id)) {
    return NextResponse.json({ error: 'This is not a signed contract.' }, { status: 400 })
  }

  const { data: row, error: readErr } = await db.from('contracts').select('pdf_path').eq('id', params.id).maybeSingle()
  if (readErr) {
    return NextResponse.json({ error: `Could not read the contract: ${readErr.message}` }, { status: 500 })
  }
  if (!row?.pdf_path) {
    return NextResponse.json({ error: 'No signed file is recorded for this contract.' }, { status: 404 })
  }
  const url = await createRecordedSignedUrl('signed-contracts', row.pdf_path, 60)
  if (!url) {
    return NextResponse.json({ error: 'The signed file could not be opened right now.' }, { status: 404 })
  }
  return NextResponse.json({ url })
}
