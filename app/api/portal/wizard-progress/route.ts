/**
 * POST /api/portal/wizard-progress — Save wizard progress (auto-save + manual save)
 * Creates or updates wizard_progress row. Used by portal wizard for save & resume.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isClient } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { wizard_type, current_step, data, account_id, contact_id, progress_id } = body

  if (!wizard_type) {
    return NextResponse.json({ error: 'wizard_type is required' }, { status: 400 })
  }

  try {
    if (progress_id) {
      // Update existing progress
      const { error } = await supabaseAdmin
        .from('wizard_progress')
        .update({
          current_step: current_step ?? 0,
          data: data || {},
          updated_at: new Date().toISOString(),
        })
        .eq('id', progress_id)

      if (error) throw error
      return NextResponse.json({ id: progress_id, updated: true })
    } else {
      // Create new progress
      const { data: created, error } = await supabaseAdmin
        .from('wizard_progress')
        .insert({
          wizard_type,
          current_step: current_step ?? 0,
          data: data || {},
          account_id: account_id || null,
          contact_id: contact_id || null,
          status: 'in_progress',
        })
        .select('id')
        .single()

      if (error) throw error
      return NextResponse.json({ id: created.id, created: true })
    }
  } catch (err) {
    console.error('[wizard-progress] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Save failed' },
      { status: 500 }
    )
  }
}
