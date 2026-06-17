/**
 * Portal ITIN shipping tracking — the client submits the courier + tracking
 * number for the signed ITIN package they mailed to the TD office.
 *
 * GET  → { success, shipping: { courier, tracking_number, submitted_at } | null }
 * POST → { courier, tracking_number } → saves to the SD, returns the saved value.
 *
 * [id] = service_delivery_id. Auth: the signed-in portal user must own the SD —
 * either the SD's contact (contact-scoped ITIN) or a user with 'documents'
 * access to the SD's account. Default-deny.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { isCourier } from '@/lib/flows/courier'
import { setServiceDeliveryShipping } from '@/lib/operations/service-delivery'

const MAX_TRACKING_LEN = 100

/** Load the SD's ownership + shipping fields (untyped: shipping_* not in types). */
async function loadSd(id: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from('service_deliveries')
    .select('id, account_id, contact_id, shipping_courier, shipping_tracking_number, shipping_submitted_at')
    .eq('id', id)
    .maybeSingle()
  return data as {
    id: string
    account_id: string | null
    contact_id: string | null
    shipping_courier: string | null
    shipping_tracking_number: string | null
    shipping_submitted_at: string | null
  } | null
}

/** Default-deny ownership check, mirroring /api/portal/documents/[id]. */
async function assertAccess(
  user: Parameters<typeof getClientContactId>[0],
  sd: { account_id: string | null; contact_id: string | null },
): Promise<boolean> {
  const contactId = getClientContactId(user)
  const hasAccountAccess = sd.account_id ? await canAccessAccount(user, sd.account_id, 'documents') : false
  const hasContactAccess = !sd.account_id && !!contactId && sd.contact_id === contactId
  return hasAccountAccess || hasContactAccess
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const sd = await loadSd(params.id)
  if (!sd) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!(await assertAccess(user, sd))) {
    return NextResponse.json({ success: false, error: 'Access denied' }, { status: 403 })
  }

  const shipping = sd.shipping_courier
    ? { courier: sd.shipping_courier, tracking_number: sd.shipping_tracking_number, submitted_at: sd.shipping_submitted_at }
    : null
  return NextResponse.json({ success: true, shipping })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const sd = await loadSd(params.id)
  if (!sd) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!(await assertAccess(user, sd))) {
    return NextResponse.json({ success: false, error: 'Access denied' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const courier = typeof body.courier === 'string' ? body.courier.trim() : ''
  const trackingNumber = typeof body.tracking_number === 'string' ? body.tracking_number.trim() : ''

  if (!isCourier(courier)) {
    return NextResponse.json({ success: false, error: 'Please choose a valid courier.' }, { status: 400 })
  }
  if (!trackingNumber) {
    return NextResponse.json({ success: false, error: 'Please enter a tracking number.' }, { status: 400 })
  }
  if (trackingNumber.length > MAX_TRACKING_LEN) {
    return NextResponse.json(
      { success: false, error: `Tracking number is too long (max ${MAX_TRACKING_LEN} characters).` },
      { status: 400 },
    )
  }

  try {
    await setServiceDeliveryShipping(params.id, { courier, trackingNumber })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Could not save shipping info.' },
      { status: 500 },
    )
  }

  return NextResponse.json({
    success: true,
    shipping: { courier, tracking_number: trackingNumber, submitted_at: new Date().toISOString() },
  })
}
