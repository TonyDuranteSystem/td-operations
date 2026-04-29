import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { syncTier } from '@/lib/operations/sync-tier'

export const dynamic = 'force-dynamic'

/**
 * POST /api/clients/audit/[id]/portal-access
 * Body: { action: 'activate' | 'deactivate', actor?: string }
 *
 * Activate  → sets account.portal_tier = 'active' via syncTier()
 *             (downstream: each linked contact's tier is recomputed
 *             as the highest across their accounts)
 * Deactivate → sets account.portal_tier = 'lead' via syncTier()
 *             (auth user is preserved — only the tier is downgraded;
 *             contacts who have other active accounts keep their access)
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { action, actor } = await req.json()

  if (action !== 'activate' && action !== 'deactivate') {
    return NextResponse.json({ error: 'action must be "activate" or "deactivate"' }, { status: 400 })
  }

  const newTier = action === 'activate' ? 'active' : 'lead'
  const reason = action === 'activate'
    ? 'Audit panel: portal access activated'
    : 'Audit panel: portal access deactivated (tier downgraded to lead)'

  const result = await syncTier({
    accountId: params.id,
    newTier,
    reason,
    actor: actor ?? 'audit-panel',
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? 'syncTier failed' }, { status: 500 })
  }

  await supabaseAdmin.from('action_log').insert({
    account_id: params.id,
    action_type: `audit_portal_${action}`,
    table_name: 'accounts',
    summary: `Audit: portal access ${action}d (${result.previousTier ?? 'null'} → ${newTier})`,
  })

  return NextResponse.json({
    ok: true,
    previousTier: result.previousTier,
    newTier: result.newTier,
    contactsUpdated: result.contactsUpdated,
  })
}
