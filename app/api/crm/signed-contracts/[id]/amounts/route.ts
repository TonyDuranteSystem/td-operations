/**
 * POST /api/crm/signed-contracts/[id]/amounts   { january, june, expectedUpdatedAt }  ->  { entry, warning? }
 *
 * `entry` is null (with a `warning`) when the amounts were saved but the line could not be read back.
 * Owner only (Antonio, or a person on the owner list). Corrects the installment amounts SAVED for one signed contract — see
 * lib/signed-contracts/correct.ts for exactly what it changes and what it never touches (the signed PDF, invoices already sent,
 * the company's own installment amounts). Errors answer { error } in plain words (R099).
 */
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUserDisplayName, isOwnerOnly } from '@/lib/auth'
import { correctSignedContractAmounts } from '@/lib/signed-contracts/correct'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { data, error } = await createClient().auth.getUser()
  const user = data?.user ?? null
  if (error || !user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Only an owner can correct a saved amount.' }, { status: 403 })
  }
  if (!UUID.test(params.id)) {
    return NextResponse.json({ error: 'This is not a signed contract.' }, { status: 400 })
  }

  let body: { january?: unknown; june?: unknown; expectedUpdatedAt?: unknown } = {}
  try {
    const parsed: unknown = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as typeof body
  } catch {
    return NextResponse.json({ error: 'The request could not be read. Reload the page and try again.' }, { status: 400 })
  }

  const result = await correctSignedContractAmounts({
    contractId: params.id,
    january: body.january,
    june: body.june,
    expectedUpdatedAt: typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : null,
    actor: { email: (user.email ?? user.id).toLowerCase(), name: getUserDisplayName(user) },
  })
  if (result.kind === 'refused') {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json({ entry: result.entry, ...(result.warning ? { warning: result.warning } : {}) })
}
