import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureStaff, ensureAdmin } from '@/lib/td-communication/admin-auth'
import { getCommSettings, setCommSettings } from '@/lib/td-communication/comm-settings'
import type { TdCommSettings } from '@/lib/td-communication/types'

export const dynamic = 'force-dynamic'

/** GET /api/td-communication/admin/settings — current TD Communication settings. Staff only. */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = await ensureStaff(user)
  if (gate) return gate

  try {
    const settings = await getCommSettings()
    return NextResponse.json({ settings })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load settings.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** PATCH /api/td-communication/admin/settings — update settings. Admin only. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  let body: Partial<TdCommSettings>
  try {
    body = (await req.json()) as Partial<TdCommSettings>
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  try {
    // setCommSettings → mergeCommSettings sanitizes types and rejects bad values.
    const settings = await setCommSettings(body)
    return NextResponse.json({ settings })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save settings.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
