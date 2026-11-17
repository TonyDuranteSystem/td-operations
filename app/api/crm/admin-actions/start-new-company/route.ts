/**
 * "Start a new company" — staff only (dev job bf9886a3).
 *
 *   GET  ?contact_id=…                                   → the pop-up's facts (which company, what will happen, the draft message)
 *   POST { contact_id, replace_delivery_id, message }    → does it (lib/operations/start-new-company.ts)
 *
 * Errors carry a plain-English `error` the pop-up shows as it is.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { createClient } from '@/lib/supabase/server'
import { previewStartNewCompany, startNewCompany } from '@/lib/operations/start-new-company'

/** A long chain of writes (new job, wizard, old company, message, old job): same limit as the other admin actions that do several steps. */
export const maxDuration = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const contactId = req.nextUrl.searchParams.get('contact_id') ?? ''
  if (!UUID.test(contactId)) return NextResponse.json({ error: 'Missing or invalid contact_id.' }, { status: 400 })
  try {
    return NextResponse.json(await previewStartNewCompany(contactId))
  } catch (e) {
    return NextResponse.json({ error: `Could not read this company: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'The request could not be read.' }, { status: 400 })
  }
  const contactId = String(body.contact_id ?? '')
  const deliveryId = String(body.replace_delivery_id ?? '')
  const message = typeof body.message === 'string' ? body.message : ''
  if (!UUID.test(contactId) || !UUID.test(deliveryId)) {
    return NextResponse.json({ error: 'Missing or invalid contact_id / replace_delivery_id.' }, { status: 400 })
  }

  let actorLabel = 'crm-admin'
  let actorUserId = ''
  try {
    const { data: { user } } = await createClient().auth.getUser()
    if (user) {
      actorUserId = user.id
      actorLabel = user.email ?? actorLabel
    }
  } catch {
    /* handled below: no login id, no send */
  }
  if (!actorUserId) return NextResponse.json({ error: 'Your login could not be read. Sign in again.' }, { status: 401 })

  try {
    const result = await startNewCompany({ contactId, replaceDeliveryId: deliveryId, message, actorLabel, actorUserId })
    if (!result.success) return NextResponse.json({ error: result.error ?? 'Nothing was changed.' }, { status: 409 })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: `Something went wrong: ${e instanceof Error ? e.message : String(e)}. Check the contact page before pressing again.` }, { status: 500 })
  }
}
