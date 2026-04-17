import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { updateAccount } from '@/lib/operations/account'
import { collectFilesRecursive, processFile } from '@/lib/mcp/tools/doc'
import { sendPortalWelcomeEmail } from '@/lib/portal/auto-create'

export const maxDuration = 60 // Vercel Pro: 60s

// Document types visible to clients in the portal
const PORTAL_VISIBLE_DOC_TYPES = [
  'Form SS-4', 'Articles of Organization', 'Office Lease', 'Lease Agreement',
  'Operating Agreement', 'EIN Letter (IRS)', 'Form 8832', 'ITIN Letter', 'Signed Contract',
]
const PORTAL_VISIBLE_CATEGORIES = [3, 5] // Tax, Correspondence

const TD_ADDRESS_PATTERNS = ['ulmerton', 'gulf blvd', 'indian shores', 'park blvd']
function isTDAddress(addr: string | null): boolean {
  if (!addr) return false
  const l = addr.toLowerCase()
  return TD_ADDRESS_PATTERNS.some(p => l.includes(p))
}

/**
 * POST /api/portal/admin/transition
 *
 * Full portal transition for a legacy client. Pass any account_id —
 * resolves the contact, finds ALL their active accounts, and for each:
 *   1. Scans Google Drive + processes new files (OCR + classify)
 *   2. Sets portal_visible on documents
 *   3. Auto-creates OA, Lease, Renewal MSA if missing (Client accounts)
 *   4. Auto-creates service deliveries (Formation, EIN, ITIN, Annual Renewal, CMRA)
 *   5. Auto-creates deadlines (Annual Report, RA Renewal)
 *   6. Sets portal_account=true, portal_tier=active
 *   7. Creates auth user with full metadata (once)
 *
 * Does NOT send email — admin sends credentials separately.
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

  // ── 1. Resolve contact ──
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
    return NextResponse.json({ error: `Contact ${contact?.full_name || 'unknown'} has no email` }, { status: 400 })
  }

  // ── 2. Find ALL active accounts ──
  const { data: allLinks } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contact.id)

  const allAccountIds = (allLinks ?? []).map(l => l.account_id)

  const { data: allAccounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, drive_folder_id, portal_account, portal_tier, services_bundle, account_type, installment_1_amount, installment_2_amount, notes')
    .in('id', allAccountIds)
    .eq('status', 'Active')

  const activeAccounts = allAccounts ?? []
  if (activeAccounts.length === 0) {
    return NextResponse.json({ error: 'No active accounts found for this contact' }, { status: 400 })
  }

  const lang = contact.language?.toLowerCase()?.startsWith('it') || contact.language === 'Italian' ? 'it' : 'en'
  const warnings: string[] = []
  const reportLines: string[] = []

  // ── 3. Process each account ──
  for (const acct of activeAccounts) {
    const acctLines: string[] = [`── ${acct.company_name} ──`]
    const isOneTime = acct.account_type === 'One-Time'

    if (acct.portal_account) {
      acctLines.push('Already transitioned (skipped)')
      reportLines.push(...acctLines, '')
      continue
    }

    // Pre-flight: TD address (Client accounts only)
    if (!isOneTime && !isTDAddress(acct.physical_address)) {
      warnings.push(`${acct.company_name}: Non-TD address (${acct.physical_address || 'NULL'})`)
    }

    // ── DRIVE SCAN ──
    let driveProcessed = 0
    let driveSkipped = 0
    if (acct.drive_folder_id) {
      try {
        const allFiles = await collectFilesRecursive(acct.drive_folder_id, 3)
        if (allFiles.length > 0) {
          const fileIds = allFiles.map(f => f.id)
          const existingIds = new Set<string>()
          for (let i = 0; i < fileIds.length; i += 50) {
            const chunk = fileIds.slice(i, i + 50)
            const { data: existing } = await supabaseAdmin
              .from('documents').select('drive_file_id').in('drive_file_id', chunk)
            existing?.forEach(e => existingIds.add(e.drive_file_id))
          }
          const toProcess = allFiles.filter(f => !existingIds.has(f.id))
          driveSkipped = allFiles.length - toProcess.length
          // Process all files (maxDuration=60s allows ~20 files with OCR)
          const startTime = Date.now()
          for (const file of toProcess) {
            // Safety: stop 8s before Vercel timeout
            if (Date.now() - startTime > 52_000) {
              const remaining = toProcess.length - driveProcessed
              warnings.push(`${acct.company_name}: ${remaining} Drive files remaining (timeout safety)`)
              break
            }
            const r = await processFile(file.id, acct.id, acct.company_name)
            if (r.success) driveProcessed++
          }
        }
      } catch (driveErr) {
        warnings.push(`${acct.company_name}: Drive scan error: ${driveErr instanceof Error ? driveErr.message : 'unknown'}`)
      }
      acctLines.push(`Drive: ${driveProcessed} processed, ${driveSkipped} already in system`)
    } else {
      warnings.push(`${acct.company_name}: no Drive folder linked`)
    }

    // ── SET PORTAL_VISIBLE ──
    const { data: docs } = await supabaseAdmin.from('documents')
      .select('id, document_type_name, category, drive_link')
      .eq('account_id', acct.id)
      .order('processed_at', { ascending: false })

    const allDocs = docs ?? []
    const allowedIds: string[] = []
    const hiddenIds: string[] = []
    const seenTypes = new Set<string>()

    for (const doc of allDocs) {
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
    const { updateDocumentsBulk } = await import('@/lib/operations/document')
    if (allowedIds.length > 0) {
      await updateDocumentsBulk({
        ids: allowedIds,
        patch: { portal_visible: true },
        actor: 'crm-admin:transition',
        summary: `Portal transition — ${allowedIds.length} docs set visible`,
        account_id: acct.id,
      })
    }
    if (hiddenIds.length > 0) {
      await updateDocumentsBulk({
        ids: hiddenIds,
        patch: { portal_visible: false },
        actor: 'crm-admin:transition',
        summary: `Portal transition — ${hiddenIds.length} docs hidden`,
        account_id: acct.id,
      })
    }
    acctLines.push(`Docs: ${allowedIds.length} visible, ${hiddenIds.length} hidden`)

    // ── AUTO-CREATE OA, LEASE, MSA (Client accounts only) ──
    if (!isOneTime) {
      // OA
      const { data: existingOA } = await supabaseAdmin.from('oa_agreements')
        .select('id, status').eq('account_id', acct.id).maybeSingle()
      if (!existingOA) {
        const entityType = acct.entity_type?.toLowerCase().includes('multi') ? 'MMLLC' : 'SMLLC'
        const slug = acct.company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const today = new Date().toISOString().slice(0, 10)
        const { data: newOa } = await supabaseAdmin.from('oa_agreements').insert({
          token: `${slug}-oa-${new Date().getFullYear()}`,
          account_id: acct.id, contact_id: contact.id,
          company_name: acct.company_name,
          state_of_formation: acct.state_of_formation || 'Wyoming',
          formation_date: acct.formation_date || today,
          ein_number: acct.ein_number || null,
          entity_type: entityType, manager_name: contact.full_name,
          member_name: contact.full_name, member_email: contact.email,
          effective_date: today,
          business_purpose: 'any and all lawful business activities',
          initial_contribution: '$0.00', fiscal_year_end: 'December 31',
          accounting_method: 'Cash', duration: 'Perpetual',
          principal_address: '10225 Ulmerton Rd, Suite 3D, Largo, FL 33771',
          language: 'en', status: 'draft',
        }).select('id').single()
        acctLines.push(newOa ? 'OA: auto-created (draft)' : 'OA: creation failed')
      } else {
        acctLines.push(`OA: exists (${existingOA.status})`)
      }

      // Lease
      const { data: existingLease } = await supabaseAdmin.from('lease_agreements')
        .select('id, status, suite_number').eq('account_id', acct.id).maybeSingle()
      const hasLeaseDriveDoc = allDocs.find(d => d.document_type_name === 'Office Lease' && d.drive_link)
      if (!existingLease && !hasLeaseDriveDoc) {
        // Auto-assign suite
        const { data: lastLeases } = await supabaseAdmin.from('lease_agreements')
          .select('suite_number').order('suite_number', { ascending: false }).limit(1)
        let suite = '3D-101'
        if (lastLeases?.length) {
          const lastNum = parseInt(lastLeases[0].suite_number.replace('3D-', ''), 10)
          if (!isNaN(lastNum)) suite = `3D-${(lastNum + 1).toString().padStart(3, '0')}`
        }
        const year = new Date().getFullYear()
        const slug = acct.company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const today = new Date().toISOString().slice(0, 10)
        const { data: newLease } = await supabaseAdmin.from('lease_agreements').insert({
          token: `${slug}-${year}`, account_id: acct.id, contact_id: contact.id,
          tenant_company: acct.company_name, tenant_contact_name: contact.full_name,
          tenant_email: contact.email, suite_number: suite,
          premises_address: '10225 Ulmerton Rd, Largo, FL 33771',
          effective_date: today, term_start_date: today, term_end_date: `${year}-12-31`,
          contract_year: year, term_months: 12, monthly_rent: 100, yearly_rent: 1200,
          security_deposit: 150, square_feet: 120, status: 'draft', language: 'en',
        }).select('id, suite_number').single()
        acctLines.push(newLease ? `Lease: auto-created (draft, Suite ${newLease.suite_number})` : 'Lease: creation failed')
      } else if (existingLease) {
        acctLines.push(`Lease: exists (${existingLease.status}, Suite ${existingLease.suite_number})`)
      } else {
        acctLines.push('Lease: signed (detected from Drive)')
      }

      // Renewal MSA
      const { data: existingMSA } = await supabaseAdmin.from('offers')
        .select('id, token, status').eq('account_id', acct.id).eq('contract_type', 'renewal').maybeSingle()
      if (!existingMSA && acct.installment_1_amount) {
        const slug = acct.company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const year = new Date().getFullYear()
        const today = new Date().toISOString().slice(0, 10)
        const { data: newMSA } = await supabaseAdmin.from('offers').insert({
          token: `renewal-${slug}-${year}`, account_id: acct.id,
          client_name: contact.full_name, client_email: contact.email,
          language: lang, contract_type: 'renewal',
          payment_type: 'bank_transfer', status: 'draft', offer_date: today,
          effective_date: `${year}-01-01`,
          bundled_pipelines: ['CMRA Mailing Address', 'State RA Renewal', 'State Annual Report', 'Tax Return'],
          services: [{ name: 'Annual LLC Management', price: (acct.installment_1_amount || 0) + (acct.installment_2_amount || 0), description: 'Annual management including RA, Annual Report, CMRA, Tax Return, Client Portal' }],
          cost_summary: [
            { label: 'First Installment (January)', items: [{ name: 'Annual Management', price: `$${acct.installment_1_amount?.toLocaleString() || '1,000'}` }], total: `$${acct.installment_1_amount?.toLocaleString() || '1,000'}` },
            { label: 'Second Installment (June)', items: [{ name: 'Annual Management', price: `$${acct.installment_2_amount?.toLocaleString() || '1,000'}` }], total: `$${acct.installment_2_amount?.toLocaleString() || '1,000'}` },
          ],
        }).select('id, token').single()
        acctLines.push(newMSA ? `MSA: auto-created (draft, ${newMSA.token})` : 'MSA: creation failed')
      } else if (existingMSA) {
        acctLines.push(`MSA: exists (${existingMSA.status})`)
      } else if (!acct.installment_1_amount) {
        warnings.push(`${acct.company_name}: no installment amounts — MSA skipped`)
      }
    } else {
      acctLines.push('OA/Lease/MSA: skipped (One-Time)')
    }

    // ── SERVICE DELIVERIES ──
    const { data: existingSDs } = await supabaseAdmin.from('service_deliveries')
      .select('id, service_type').eq('account_id', acct.id)
    const sdTypes = new Set((existingSDs ?? []).map(s => s.service_type))
    const createdSDs: string[] = []

    if (acct.formation_date && !sdTypes.has('Company Formation')) {
      // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
      await supabaseAdmin.from('service_deliveries').insert({
        account_id: acct.id, service_type: 'Company Formation', pipeline: 'Company Formation',
        service_name: `Company Formation -- ${acct.company_name}`,
        stage: 'Closing', stage_order: 6, status: 'completed',
        start_date: acct.formation_date, assigned_to: 'Luca', notes: 'Legacy onboard',
        stage_history: [{ to_stage: 'Closing', to_order: 6, notes: 'Legacy', advanced_at: new Date().toISOString() }],
      })
      createdSDs.push('Formation')
    }
    if (acct.ein_number && !sdTypes.has('EIN')) {
      // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
      await supabaseAdmin.from('service_deliveries').insert({
        account_id: acct.id, service_type: 'EIN', pipeline: 'EIN',
        service_name: `EIN -- ${acct.company_name}`,
        stage: 'EIN Received', stage_order: 4, status: 'completed',
        start_date: acct.formation_date || new Date().toISOString().slice(0, 10), assigned_to: 'Luca',
        notes: `Legacy onboard - EIN ${acct.ein_number}`,
        stage_history: [{ to_stage: 'EIN Received', to_order: 4, notes: 'Legacy', advanced_at: new Date().toISOString() }],
      })
      createdSDs.push('EIN')
    }
    if (contact.itin_number && !sdTypes.has('ITIN')) {
      // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
      await supabaseAdmin.from('service_deliveries').insert({
        account_id: acct.id, service_type: 'ITIN',
        service_name: `ITIN -- ${acct.company_name}`,
        status: 'completed', start_date: new Date().toISOString().slice(0, 10), assigned_to: 'Luca',
        notes: `Legacy onboard - ITIN ${contact.itin_number}`,
      })
      createdSDs.push('ITIN')
    }
    if (!isOneTime && !sdTypes.has('Annual Renewal')) {
      // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
      await supabaseAdmin.from('service_deliveries').insert({
        account_id: acct.id, service_type: 'Annual Renewal',
        service_name: `Annual Renewal -- ${acct.company_name}`,
        status: 'active', start_date: new Date().toISOString().slice(0, 10), assigned_to: 'Luca', notes: 'Legacy onboard',
      })
      createdSDs.push('Annual Renewal')
    }
    if (!isOneTime && !sdTypes.has('CMRA Mailing Address') && isTDAddress(acct.physical_address)) {
      // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
      await supabaseAdmin.from('service_deliveries').insert({
        account_id: acct.id, service_type: 'CMRA Mailing Address',
        service_name: `CMRA -- ${acct.company_name}`,
        status: 'active', start_date: new Date().toISOString().slice(0, 10), assigned_to: 'Luca',
        notes: `Legacy onboard - ${acct.physical_address}`,
      })
      createdSDs.push('CMRA')
    }
    if (createdSDs.length > 0) acctLines.push(`SDs: ${createdSDs.join(', ')}`)

    // ── DEADLINES (Client only) ──
    if (!isOneTime && acct.formation_date && acct.state_of_formation) {
      const { data: existingDL } = await supabaseAdmin.from('deadlines')
        .select('deadline_type').eq('account_id', acct.id)
      const dlTypes = new Set((existingDL ?? []).map(d => d.deadline_type))
      const formDate = new Date(acct.formation_date)
      const formMonth = formDate.getMonth()
      const formDay = formDate.getDate()
      const nextYear = new Date().getFullYear() + 1
      const state = acct.state_of_formation
      const llcType = acct.entity_type?.toLowerCase().includes('multi') ? 'MMLLC' : 'SMLLC'
      const createdDL: string[] = []

      if (!dlTypes.has('Annual Report')) {
        let arDue: string | null = null
        if (state === 'Wyoming') arDue = `${nextYear}-${String(formMonth + 1).padStart(2, '0')}-01`
        else if (state === 'Florida') arDue = `${nextYear}-05-01`
        else if (state === 'Delaware') arDue = `${nextYear}-06-01`
        if (arDue) {
          await supabaseAdmin.from('deadlines').insert({
            account_id: acct.id, deadline_type: 'Annual Report', due_date: arDue,
            status: 'Pending', state, year: nextYear, llc_type: llcType, assigned_to: 'Luca',
            deadline_record: `${acct.company_name} - Annual Report ${nextYear}`, notes: 'Legacy onboard',
          })
          createdDL.push(`Annual Report ${arDue}`)
        }
      }
      if (!dlTypes.has('RA Renewal')) {
        const raDue = `${nextYear}-${String(formMonth + 1).padStart(2, '0')}-${String(formDay).padStart(2, '0')}`
        await supabaseAdmin.from('deadlines').insert({
          account_id: acct.id, deadline_type: 'RA Renewal', due_date: raDue,
          status: 'Pending', state, year: nextYear, llc_type: llcType, assigned_to: 'Luca',
          deadline_record: `${acct.company_name} - RA Renewal ${nextYear}`, notes: 'Legacy onboard',
        })
        createdDL.push(`RA Renewal ${raDue}`)
      }
      if (createdDL.length > 0) acctLines.push(`Deadlines: ${createdDL.join(', ')}`)
    }

    // ── Tax return check ──
    if (acct.formation_date && acct.formation_date < '2026-01-01') {
      const { data: tr } = await supabaseAdmin.from('tax_returns')
        .select('id').eq('company_name', acct.company_name).eq('tax_year', 2025).maybeSingle()
      if (!tr) warnings.push(`${acct.company_name}: no 2025 tax return record`)
    }

    // ── SET ACCOUNT FLAGS ──
    await updateAccount({
      id: acct.id,
      patch: {
        portal_account: true,
        portal_tier: 'active',
        portal_created_date: new Date().toISOString().split('T')[0],
        notes: (acct.notes || '') + `\n${new Date().toISOString().split('T')[0]}: Portal transition (CRM button). [PORTAL_TRANSITION]`,
      },
      actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
      summary: `Portal transition (CRM): ${acct.company_name}`,
    })

    acctLines.push('portal_account = true')
    reportLines.push(...acctLines, '')
  }

  // ── 4. Create or repair auth user (once) ──
  const existingAuth = contact.email ? await findAuthUserByEmail(contact.email) : null
  const accountIds = activeAccounts.map(a => a.id)

  let emailSent = false
  if (!existingAuth) {
    const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`
    const { error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: contact.email, password: tempPassword, email_confirm: true,
      app_metadata: { role: 'client', contact_id: contact.id, portal_tier: 'active', account_ids: accountIds },
      user_metadata: { full_name: contact.full_name, must_change_password: true },
    })
    if (createError) {
      warnings.push(`Auth user creation failed: ${createError.message}`)
    } else {
      // Send welcome email with credentials
      const emailResult = await sendPortalWelcomeEmail({
        email: contact.email,
        fullName: contact.full_name,
        tempPassword,
        language: lang === 'it' ? 'it' : 'en',
      })
      emailSent = emailResult.success
      if (!emailResult.success) {
        warnings.push(`Welcome email failed: ${emailResult.error || 'unknown'}`)
      }
      reportLines.push(`Auth user: CREATED (${contact.email})`)
      reportLines.push(emailSent ? 'Welcome email: SENT' : 'Welcome email: FAILED (send manually)')
    }
  } else {
    // Existing user — reset password and send new credentials
    const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`
    await supabaseAdmin.auth.admin.updateUserById(existingAuth.id, {
      password: tempPassword,
      app_metadata: { ...existingAuth.app_metadata, role: 'client', contact_id: contact.id, portal_tier: 'active', account_ids: accountIds },
    })
    const emailResult = await sendPortalWelcomeEmail({
      email: contact.email,
      fullName: contact.full_name,
      tempPassword,
      language: lang === 'it' ? 'it' : 'en',
    })
    emailSent = emailResult.success
    if (!emailResult.success) {
      warnings.push(`Welcome email failed: ${emailResult.error || 'unknown'}`)
    }
    reportLines.push(`Auth user: existed — password reset + metadata repaired (${contact.email})`)
    reportLines.push(emailSent ? 'Welcome email: SENT' : 'Welcome email: FAILED (send manually)')
  }

  // ── 5. Update contact ──
  // eslint-disable-next-line no-restricted-syntax -- dev_task 7ebb1e0c: migrate to lib/operations/
  await supabaseAdmin.from('contacts').update({ portal_tier: 'active' }).eq('id', contact.id)

  const processedCount = activeAccounts.filter(a => !a.portal_account).length

  return NextResponse.json({
    success: true,
    accounts_processed: processedCount,
    contact_email: contact.email,
    contact_name: contact.full_name,
    report: reportLines.join('\n'),
    warnings,
    email_sent: emailSent,
    message: `Portal transition complete for ${contact.full_name}. ${processedCount} account(s) processed.${emailSent ? ' Welcome email sent.' : ' Welcome email NOT sent — send manually.'}`,
  })
}
