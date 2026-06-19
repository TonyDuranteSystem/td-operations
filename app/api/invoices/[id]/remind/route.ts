import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { sendInvoiceReminder } from '@/lib/billing/invoice-reminder'

/**
 * POST /api/invoices/[id]/remind — Send payment reminder for a TD LLC invoice.
 *
 * Auth: cron secret (x-cron-secret) OR a logged-in dashboard user.
 * All reminder logic (recipient resolution, bilingual email, send, counter)
 * lives in the shared sendInvoiceReminder() — this route is a thin HTTP wrapper.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cronSecret = process.env.CRON_SECRET
  const cronHeader = _request.headers.get('x-cron-secret')
  const isCron = cronSecret && cronHeader === cronSecret

  if (!isCron) {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const result = await sendInvoiceReminder(id)

  if (!result.ok) {
    // "Invoice not found" → 404; everything else (bad status, no email) → 400.
    const status = result.error === 'Invoice not found' ? 404 : 400
    return NextResponse.json({ error: result.error ?? 'Failed to send reminder' }, { status })
  }

  return NextResponse.json({
    success: true,
    sent: result.sent,
    ...(result.alreadySent ? { message: 'Reminder already sent recently' } : {}),
    ...(result.reminderNumber ? { reminderNumber: result.reminderNumber } : {}),
  })
}
