/**
 * Admin endpoint — read/write the `renewal_banner_min_year` app setting.
 *
 * Controls the portal renewal-MSA banner gate. The banner only renders for
 * agreements whose `agreement_year >= renewal_banner_min_year`. Default is
 * 2027 (hides 2026 banners during legacy-payment purgatory year).
 *
 * GET  → returns { value }
 * POST → body { value: number }, returns { ok: true, value }
 *
 * Admin-session auth (matches /api/admin/airwallex-backfill pattern).
 */
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { getRenewalBannerMinYear, setAppSetting } from '@/lib/settings'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const value = await getRenewalBannerMinYear()
  return NextResponse.json({ value })
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({})) as { value?: unknown }
  const n = Number(body.value)
  if (!Number.isFinite(n) || n < 2025 || n > 2100) {
    return NextResponse.json({ error: 'value must be a year between 2025 and 2100' }, { status: 400 })
  }
  await setAppSetting('renewal_banner_min_year', Math.floor(n))
  return NextResponse.json({ ok: true, value: Math.floor(n) })
}
