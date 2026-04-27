/**
 * PRODUCTION members table backfill.
 *
 * Reads existing MMLLC account_contacts → inserts one members row per
 * linked contact for every MMLLC account that currently has 0 members rows.
 *
 * Safety:
 *  - Dry-run by default. Pass --apply to write.
 *  - Refuses to run unless SUPABASE_URL contains the production ref ydzipybqeebtpcvsbtvs.
 *  - Idempotent: skips accounts that already have members rows.
 *  - Company members NOT backfilled (didn't exist before this build — add via CRM card).
 *
 * Usage:
 *   node scripts/33-prod-members-backfill.js          # dry-run
 *   node scripts/33-prod-members-backfill.js --apply  # write to production
 */

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const PROD_REF = 'ydzipybqeebtpcvsbtvs'
const APPLY = process.argv.includes('--apply')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/\\n/g, '').trim()

if (!SUPABASE_URL || !SUPABASE_URL.includes(PROD_REF)) {
  console.error(`❌ Safety check failed: NEXT_PUBLIC_SUPABASE_URL must contain "${PROD_REF}".`)
  console.error(`   Got: ${SUPABASE_URL}`)
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

;(async () => {
  console.log(APPLY ? '🚀 APPLY MODE — writing to production' : '🔍 DRY-RUN — no writes')
  console.log('=========================================================\n')

  // 1. All active MMLLC accounts
  const { data: accounts, error: acctErr } = await supabase
    .from('accounts')
    .select('id, company_name')
    .eq('entity_type', 'Multi Member LLC')
    .not('status', 'in', '("Cancelled","Closed")')
    .order('company_name')

  if (acctErr) { console.error('Failed to fetch accounts:', acctErr.message); process.exit(1) }
  console.log(`Found ${accounts.length} active MMLLC account(s)\n`)

  let totalInserted = 0
  let totalSkipped = 0
  let totalWarnings = 0

  for (const account of accounts) {
    // 2. Check existing members rows
    const { count } = await supabase
      .from('members')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', account.id)

    if (count > 0) {
      console.log(`  ⏭  ${account.company_name} — already has ${count} member(s), skipping`)
      totalSkipped++
      continue
    }

    // 3. Get linked contacts
    const { data: links } = await supabase
      .from('account_contacts')
      .select('contact_id, role, is_primary, ownership_pct')
      .eq('account_id', account.id)

    if (!links || links.length === 0) {
      console.log(`  ⚠️  ${account.company_name} — no account_contacts, skipping`)
      totalWarnings++
      continue
    }

    // 4. Get contact details
    const contactIds = links.map(l => l.contact_id)
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, full_name, email, phone')
      .in('id', contactIds)

    const contactMap = Object.fromEntries((contacts || []).map(c => [c.id, c]))

    // 5. Build insert rows
    const now = new Date().toISOString()
    const rows = links.map(link => {
      const c = contactMap[link.contact_id] || {}
      return {
        account_id: account.id,
        member_type: 'individual',
        full_name: c.full_name || null,
        email: c.email || null,
        phone: c.phone || null,
        ownership_pct: link.ownership_pct || null,
        is_primary: link.is_primary || false,
        is_signer: false,
        contact_id: link.contact_id,
        created_at: now,
        updated_at: now,
      }
    })

    console.log(`  ✅ ${account.company_name} — would insert ${rows.length} member(s):`)
    for (const r of rows) {
      console.log(`     • ${r.full_name || '(no name)'} — ${r.email || 'no email'} — ${r.ownership_pct != null ? r.ownership_pct + '%' : 'no %'}${r.is_primary ? ' [Primary]' : ''}`)
    }

    if (APPLY) {
      const { error: insertErr } = await supabase
        .from('members')
        .insert(rows)

      if (insertErr) {
        console.error(`     ❌ Insert failed: ${insertErr.message}`)
      } else {
        console.log(`     ✓ Inserted`)
        totalInserted += rows.length
      }
    } else {
      totalInserted += rows.length
    }
  }

  console.log('\n=========================================================')
  console.log(`Summary:`)
  console.log(`  Accounts skipped (already have members): ${totalSkipped}`)
  console.log(`  Accounts with no contacts (⚠️ manual review needed): ${totalWarnings}`)
  console.log(`  Members ${APPLY ? 'inserted' : 'would be inserted'}: ${totalInserted}`)
  if (!APPLY) console.log('\n▶ Run with --apply to write to production.')
})()
