/**
 * POST /api/invoices/run-dunning — run the dunning pass on demand (the
 * dashboard "Run reminders now" button). Admin-only. Marks overdue + sends
 * every due reminder (per-account timing, pause, and 2-reminder cap honored),
 * throttled to DUNNING_RUN_CAP sends. Returns a summary for the UI toast.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { runDunning } from '@/lib/billing/dunning'

export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Manual trigger always sends (autoSend: true) regardless of the schedule toggle.
  const summary = await runDunning({ autoSend: true })
  return NextResponse.json({ success: true, ...summary })
}
