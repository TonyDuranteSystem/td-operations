import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { logAction } from '@/lib/mcp/action-log'

/**
 * POST /api/portal/admin/transition
 *
 * Runs the portal transition for a legacy client. Pass any account_id —
 * resolves the contact, finds ALL their active accounts, and for each:
 *   - Sets portal_visible on documents
 *   - Sets portal_account=true, portal_tier=active
 *   - Creates auth user with full metadata (once)
 *
 * Does NOT: scan Drive (too slow for HTTP), create OA/Lease/MSA (use MCP tool for full setup),
 * or send email. This is the "quick setup" version for the CRM button.
 *
 * Returns warnings if blockers are found (no email, no Drive folder, etc.)
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json()
  const { account_id } = body

  if (!account_id) {
    return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  }

  // 1. Resolve contact from account
  const { data: contactLinks } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id, contact:contacts(id, full_name, email, language, itin_number)')
    .eq('account_id', account_id)

  if (!contactLinks?.length) {
    return NextResponse.json({ error: 'No contact linked to this account' }, { status: 400 })
  }

  const contact = contactLinks[0].contact as unknown as {
    id: string; full_name: string; email: string; language: string | null; itin_number: string | null
  }

  if (!contact?.email) {
    return NextResponse.json({ error: `Contact ${contact?.full_name || 'unknown'} has no email. Cannot create portal account.` }, { status: 400 })
  }

  // 2. Find ALL active accounts for this contact
  const { data: allLinks } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contact.id)

  const allAccountIds = (allLinks ?? []).map(l => l.account_id)

  const { data: allAccounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, status, physical_address, drive_folder_id, portal_account, portal_tier, account_type, notes')
    .in('id', allAccountIds)
    .eq('status', 'Active')

  const activeAccounts = allAccounts ?? []

  if (activeAccounts.length === 0) {
    return NextResponse.json({ error: 'No active accounts found for this contact' }, { status: 400 })
  }

  // 3. Pre-flight checks — collect warnings but don't block
  const warnings: string[] = []
  const reportLines: string[] = []

  for (const acct of activeAccounts) {
    if (acct.portal_account) {
      reportLines.push(`${acct.company_name}: already transitioned (skipped)`)
      continue
    }

    if (!acct.drive_folder_id) {
      warnings.push(`${acct.company_name}: no Google Drive folder linked`)
    }

    // Set portal_visible on existing documents
    const { data: docs } = await supabaseAdmin
      .from('documents')
      .select('id, document_type_name, category')
      .eq('account_id', acct.id)

    const PORTAL_VISIBLE_DOC_TYPES = [
      'Form SS-4', 'Articles of Organization', 'Office Lease', 'Lease Agreement',
      'Operating Agreement', 'EIN Letter (IRS)', 'Form 8832', 'ITIN Letter', 'Signed Contract',
    ]
    const PORTAL_VISIBLE_CATEGORIES = [3, 5]
    const seenTypes = new Set<string>()
    const allowedIds: string[] = []
    const hiddenIds: string[] = []

    for (const doc of docs ?? []) {
      const typeName = doc.document_type_name ?? ''
      const cat = doc.category as number | null
      const visByType = PORTAL_VISIBLE_DOC_TYPES.includes(typeName) && !seenTypes.has(typeName)
      const visByCat = cat != null && PORTAL_VISIBLE_CATEGORIES.includes(cat)
      if (visByType || visByCat) {
        if (visByType) seenTypes.add(typeName)
        allowedIds.push(doc.id)
      } else {
        hiddenIds.push(doc.id)
      }
    }

    if (allowedIds.length > 0) await supabaseAdmin.from('documents').update({ portal_visible: true }).in('id', allowedIds)
    if (hiddenIds.length > 0) await supabaseAdmin.from('documents').update({ portal_visible: false }).in('id', hiddenIds)

    // Set account flags
    await supabaseAdmin.from('accounts').update({
      portal_account: true,
      portal_tier: 'active',
      portal_created_date: new Date().toISOString().split('T')[0],
      notes: (acct.notes || '') + `\n${new Date().toISOString().split('T')[0]}: Portal transition (CRM button). [PORTAL_TRANSITION]`,
    }).eq('id', acct.id)

    reportLines.push(`${acct.company_name}: ${allowedIds.length} docs visible, portal_account=true`)

    logAction({
      actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
      action_type: 'update',
      table_name: 'accounts',
      record_id: acct.id,
      account_id: acct.id,
      summary: `Portal transition (CRM button): ${acct.company_name}`,
    })
  }

  // 4. Create or repair auth user (once)
  const { data: authList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const existingAuth = (authList?.users ?? []).find(u => u.email === contact.email)
  const accountIds = activeAccounts.map(a => a.id)

  if (!existingAuth) {
    const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`
    const { error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: contact.email,
      password: tempPassword,
      email_confirm: true,
      app_metadata: {
        role: 'client',
        contact_id: contact.id,
        portal_tier: 'active',
        account_ids: accountIds,
      },
      user_metadata: {
        full_name: contact.full_name,
        must_change_password: true,
      },
    })
    if (createError) {
      warnings.push(`Auth user creation failed: ${createError.message}`)
    } else {
      reportLines.push(`Auth user: CREATED (${contact.email})`)
    }
  } else {
    // Repair metadata
    await supabaseAdmin.auth.admin.updateUserById(existingAuth.id, {
      app_metadata: {
        ...existingAuth.app_metadata,
        role: 'client',
        contact_id: contact.id,
        portal_tier: 'active',
        account_ids: accountIds,
      },
    })
    reportLines.push(`Auth user: already existed — metadata repaired (${contact.email})`)
  }

  // 5. Update contact
  await supabaseAdmin.from('contacts').update({
    portal_tier: 'active',
  }).eq('id', contact.id)

  const processedCount = activeAccounts.filter(a => !a.portal_account).length

  return NextResponse.json({
    success: true,
    accounts_processed: processedCount,
    contact_email: contact.email,
    contact_name: contact.full_name,
    report: reportLines.join('\n'),
    warnings,
    message: `Portal transition complete for ${contact.full_name}. ${processedCount} account(s) processed. Email NOT sent.`,
  })
}
