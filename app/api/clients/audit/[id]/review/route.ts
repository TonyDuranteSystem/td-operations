import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

/* eslint-disable no-restricted-syntax */

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { services, reviewed_by, audit_sections } = await req.json()

  const { error } = await supabaseAdmin
    .from('accounts')
    .update({
      audit_reviewed_at: new Date().toISOString(),
      audit_reviewed_by: reviewed_by ?? null,
      audit_flag: false,
      audit_sections: audit_sections ?? {},
    })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const servicesSummary = Object.entries(services ?? {})
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')

  await supabaseAdmin.from('action_log').insert({
    account_id: params.id,
    action_type: 'audit_reviewed',
    table_name: 'accounts',
    summary: `Client audit confirmed by ${reviewed_by ?? 'unknown'}. Services: ${servicesSummary}`,
  })

  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { section, confirmed, audit_sections } = await req.json()

  const { error } = await supabaseAdmin
    .from('accounts')
    .update({ audit_sections: audit_sections ?? {} })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, section, confirmed })
}
/* eslint-enable no-restricted-syntax */
