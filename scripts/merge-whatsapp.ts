/**
 * WhatsApp Export → CRM SMART MERGE
 *
 * Unlike import-whatsapp.ts (clean import into an empty inbox), this reconciles the
 * WA_Export files against an inbox that ALREADY contains threads (e.g. the legacy
 * Periskope-synced groups in `<digits>@c.us` format).
 *
 * Per-file decision (phone-named files only; group-chat / name-titled files are skipped):
 *   • EXISTING thread for that phone  → ENRICH ONLY: link contact/lead + set a real
 *     name if the thread is currently unlinked / number-named. Messages are NOT touched
 *     (the two sources store timestamps differently — merging risks dup/dropped messages).
 *   • NO existing thread              → CREATE the thread (native `<digits>@c.us` key)
 *     and insert the full parsed message history.
 *
 * Threads are matched to existing groups by EXACT phone digits (country-code included).
 *
 * Modes:
 *   DRY_RUN=1  → compute and print the plan, write nothing.
 *   (default)  → apply the plan.
 *
 * Run: DRY_RUN=1 npx tsx scripts/merge-whatsapp.ts   (preview)
 *      npx tsx scripts/merge-whatsapp.ts              (apply, sandbox only)
 */

/* eslint-disable no-console */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'
import { SignJWT, importPKCS8 } from 'jose'
import { parseExport, digitsOnly, phonesMatch, personName } from './whatsapp-parse'

// ─── Load .env.local ─────────────────────────────────────
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) {
    console.error('⚠️  .env.local not found — run from the project root')
    process.exit(1)
  }
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

// ─── Safety gate ─────────────────────────────────────────
const PROD_REF = 'ydzipybqeebtpcvsbtvs'
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
// Writing to production is never allowed from this script. A production run goes
// through the MCP apply path with a reviewed dry-run plan (see ops doc).
if (supabaseUrl.includes(PROD_REF) && !DRY_RUN) {
  console.error('⛔ PRODUCTION DETECTED — this script only WRITES to sandbox. Use DRY_RUN=1 to preview against prod, then apply via the reviewed MCP path.')
  process.exit(1)
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey)

// ─── Google Drive Auth ───────────────────────────────────
let cachedDriveToken: { token: string; expiresAt: number } | null = null
function getDriveCredentials(): { client_email: string; private_key: string; token_uri: string } {
  const b64 = process.env.GOOGLE_SA_KEY
  if (!b64) throw new Error('GOOGLE_SA_KEY not configured')
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'))
}
async function getDriveToken(): Promise<string> {
  if (cachedDriveToken && Date.now() < cachedDriveToken.expiresAt - 5 * 60 * 1000) return cachedDriveToken.token
  const creds = getDriveCredentials()
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL ?? 'support@tonydurante.us'
  const now = Math.floor(Date.now() / 1000)
  const privateKey = await importPKCS8(creds.private_key, 'RS256')
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/drive', sub: impersonate })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(creds.client_email)
    .setAudience(creds.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey)
  const res = await fetch(creds.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!res.ok) throw new Error(`Google auth failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedDriveToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return data.access_token
}
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const SHARED_DRIVE_ID = process.env.GOOGLE_SHARED_DRIVE_ID || '0AOLZHXSfKUMHUk9PVA'
async function driveGet(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const token = await getDriveToken()
  const url = new URL(`${DRIVE_API}${endpoint}`)
  url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('includeItemsFromAllDrives', 'true')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`)
  return res.json()
}
async function driveDownloadText(fileId: string): Promise<string> {
  const token = await getDriveToken()
  const url = new URL(`${DRIVE_API}/files/${fileId}`)
  url.searchParams.set('alt', 'media')
  url.searchParams.set('supportsAllDrives', 'true')
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Drive download ${res.status}: ${await res.text()}`)
  return res.text()
}

// A group_name counts as "just a number" (improvable) when it's empty or all digits.
function isNumberName(name: string | null | undefined): boolean {
  if (!name) return true
  return digitsOnly(name) === name.replace(/\s/g, '')
}

interface Plan {
  enriched: Array<{ digits: string; group_id: string; name: string; linked: 'contact' | 'lead' }>
  created: Array<{ digits: string; name: string; messages: number; linked: 'contact' | 'lead' | 'none' }>
  skippedNoDigits: string[]
  skippedNoChange: string[]
  errors: Array<{ file: string; error: string }>
}

async function main() {
  console.log(`🔧 WhatsApp smart-merge — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'} — DB ${supabaseUrl.includes(PROD_REF) ? 'PROD' : 'sandbox'}`)

  // Active WhatsApp channel + firm number
  const { data: channels } = await supabase
    .from('messaging_channels')
    .select('id, phone_number, is_active, channel_name')
    .eq('platform', 'whatsapp')
    .order('is_active', { ascending: false })
    .order('created_at', { ascending: true })
  const channel = channels?.[0] ?? null
  if (!channel) { console.error('❌ No WhatsApp channel found'); process.exit(1) }
  const channelId: string = channel.id
  const firmDigits = digitsOnly(channel.phone_number ?? '')
  if (!firmDigits) { console.error('❌ WhatsApp channel has no phone_number'); process.exit(1) }
  console.log(`📡 Channel: ${channel.channel_name} (${channel.phone_number})`)

  // Existing groups on this channel, indexed by exact phone digits
  const { data: groupRows, error: grpErr } = await supabase
    .from('messaging_groups')
    .select('id, external_group_id, group_name, contact_id, lead_id, account_id')
    .eq('channel_id', channelId)
  if (grpErr) { console.error(`❌ Failed to load existing groups: ${grpErr.message}`); process.exit(1) }
  const existingByDigits = new Map<string, NonNullable<typeof groupRows>[number]>()
  for (const g of groupRows ?? []) {
    const d = digitsOnly(g.external_group_id ?? '')
    if (d) existingByDigits.set(d, g)
  }
  console.log(`📇 Existing groups on channel: ${groupRows?.length ?? 0} (${existingByDigits.size} with a phone)`)

  // CRM contacts + leads for matching
  const { data: contactRows, error: cErr } = await supabase
    .from('contacts').select('id, first_name, last_name, full_name, phone, phone_2, primary_company_id')
  if (cErr) { console.error(`❌ Failed to load contacts: ${cErr.message}`); process.exit(1) }
  const { data: leadRows, error: lErr } = await supabase
    .from('leads').select('id, first_name, last_name, full_name, phone')
  if (lErr) { console.error(`❌ Failed to load leads: ${lErr.message}`); process.exit(1) }
  const contacts = contactRows ?? []
  const leads = leadRows ?? []

  // Drive files
  const folderResult = (await driveGet('/files', {
    q: `name = 'WA_Export' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    driveId: SHARED_DRIVE_ID, corpora: 'drive', fields: 'files(id,name)', pageSize: '1',
  })) as { files: Array<{ id: string; name: string }> }
  if (!folderResult.files?.length) { console.error('❌ WA_Export folder not found'); process.exit(1) }
  const filesResult = (await driveGet('/files', {
    q: `'${folderResult.files[0].id}' in parents and mimeType = 'text/plain' and trashed = false`,
    driveId: SHARED_DRIVE_ID, corpora: 'drive', fields: 'files(id,name)', pageSize: '500',
  })) as { files: Array<{ id: string; name: string }> }
  const txtFiles = filesResult.files ?? []
  console.log(`📂 ${txtFiles.length} export files\n`)

  const plan: Plan = { enriched: [], created: [], skippedNoDigits: [], skippedNoChange: [], errors: [] }

  for (const file of txtFiles) {
    const rawPhone = file.name.replace(/\.txt$/i, '').trim()
    const fileDigits = digitsOnly(rawPhone)

    // Skip group-chat / saved-name files (no phone in the filename)
    if (!fileDigits) { plan.skippedNoDigits.push(file.name); continue }

    const matchedContact = contacts.find(c => phonesMatch(c.phone, fileDigits) || phonesMatch(c.phone_2, fileDigits))
    const matchedLead = !matchedContact ? leads.find(l => phonesMatch(l.phone, fileDigits)) : null
    const matchName = matchedContact ? personName(matchedContact) : matchedLead ? personName(matchedLead) : ''
    const contactId = matchedContact?.id ?? null
    const leadId = matchedLead?.id ?? null
    const accountId = matchedContact?.primary_company_id ?? null

    const existing = existingByDigits.get(fileDigits)

    if (existing) {
      // ENRICH ONLY — never touch messages.
      const patch: Record<string, unknown> = {}
      if (!existing.contact_id && contactId) { patch.contact_id = contactId; if (accountId && !existing.account_id) patch.account_id = accountId }
      if (!existing.contact_id && !existing.lead_id && !contactId && leadId) patch.lead_id = leadId
      if (matchName && isNumberName(existing.group_name)) patch.group_name = matchName
      if (Object.keys(patch).length === 0) { plan.skippedNoChange.push(rawPhone); continue }
      if (!DRY_RUN) {
        const { error } = await supabase.from('messaging_groups').update(patch).eq('id', existing.id)
        if (error) { plan.errors.push({ file: file.name, error: `enrich: ${error.message}` }); continue }
      }
      plan.enriched.push({ digits: fileDigits, group_id: existing.id, name: (patch.group_name as string) ?? existing.group_name ?? rawPhone, linked: contactId ? 'contact' : 'lead' })
      continue
    }

    // CREATE — new thread + full history
    let messages
    try {
      const text = await driveDownloadText(file.id)
      messages = parseExport(text, fileDigits, firmDigits)
    } catch (err) {
      plan.errors.push({ file: file.name, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    const groupName = matchName || rawPhone
    const externalGroupId = `${fileDigits}@c.us` // native format, consistent with existing threads
    const lastMessage = messages.at(-1)

    if (!DRY_RUN) {
      const { data: groupData, error: groupErr } = await supabase
        .from('messaging_groups')
        .upsert({
          channel_id: channelId, external_group_id: externalGroupId, group_name: groupName,
          group_type: 'direct', is_active: true, account_id: accountId, contact_id: contactId, lead_id: leadId,
          last_message_at: lastMessage?.timestamp.toISOString() ?? null, unread_count: 0,
        }, { onConflict: 'channel_id,external_group_id' })
        .select('id').single()
      if (groupErr || !groupData) { plan.errors.push({ file: file.name, error: `create group: ${groupErr?.message ?? 'no row'}` }); continue }

      const rows = messages.map(m => ({
        group_id: groupData.id, channel_id: channelId,
        external_message_id: `waexport_${fileDigits}_${Math.floor(m.timestamp.getTime() / 1000)}`,
        direction: m.direction, sender_phone: m.senderPhone,
        sender_name: m.direction === 'outbound' ? 'Antonio' : (matchName || m.senderPhone),
        content_text: m.content, content_type: m.contentType,
        created_at: m.timestamp.toISOString(), status: 'received',
      }))
      for (let i = 0; i < rows.length; i += 200) {
        const { error: insErr } = await supabase.from('messages').insert(rows.slice(i, i + 200))
        if (insErr) plan.errors.push({ file: file.name, error: `insert messages: ${insErr.message}` })
      }
    }
    plan.created.push({ digits: fileDigits, name: groupName, messages: messages.length, linked: contactId ? 'contact' : leadId ? 'lead' : 'none' })
  }

  // Report
  console.log('─'.repeat(56))
  console.log(`📊 Smart-merge plan ${DRY_RUN ? '(DRY RUN)' : '(APPLIED)'}`)
  console.log(`   Enriched existing threads : ${plan.enriched.length}`)
  console.log(`   Created new threads       : ${plan.created.length} (${plan.created.reduce((s, c) => s + c.messages, 0)} messages)`)
  console.log(`   Skipped (group/name file) : ${plan.skippedNoDigits.length}`)
  console.log(`   Skipped (no change needed): ${plan.skippedNoChange.length}`)
  console.log(`   Errors                    : ${plan.errors.length}`)
  const reportPath = path.resolve(process.cwd(), 'merge-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(plan, null, 2), 'utf-8')
  console.log(`\n📄 Full plan → merge-report.json`)
  if (plan.errors.length) console.log(plan.errors.slice(0, 5))
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1) })
