import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { ingestOwnerStatement } from '@/lib/owner-statement-ingest'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_BYTES = 25 * 1024 * 1024

/** Statement file → the owner's books (Phase 2 backfill). Parsing, double-count guards
 * and reporting live in lib/owner-statement-ingest.ts. */
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected a file upload' }, { status: 400 })
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 25 MB` }, { status: 400 })
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const report = await ingestOwnerStatement(buffer, file.name, file.type || 'application/octet-stream')
    return NextResponse.json({ report })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Import failed' }, { status: 500 })
  }
}
