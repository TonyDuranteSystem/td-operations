/**
 * WhatsApp Export Importer
 *
 * Reads .txt export files from Google Drive folder `WA_Export` (in the shared drive),
 * parses WhatsApp conversation history, matches phone numbers to CRM contacts/leads,
 * upserts messaging_groups, inserts messages, and writes a report.
 *
 * Run: npm run import-whatsapp
 *
 * import-report.json schema:
 * {
 *   "summary": {
 *     "filesProcessed": number,
 *     "messagesImported": number,
 *     "matchedContacts": number,
 *     "matchedLeads": number,
 *     "unmatched": number,
 *     "errors": number
 *   },
 *   "contacts": [{ "name": string, "phone": string, "messages": number }],
 *   "leads": [{ "name": string, "phone": string, "messages": number }],
 *   "unmatched": [{ "phone": string, "messages": number }],
 *   "errors": [{ "file": string, "error": string }]
 * }
 */

/* eslint-disable no-console */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'
import { SignJWT, importPKCS8 } from 'jose'

// ─── Load .env.local ─────────────────────────────────────
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) {
    console.error('⚠️  .env.local not found — run from the project root')
    process.exit(1)
  }
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
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
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
if (supabaseUrl.includes(PROD_REF)) {
  console.error('⛔ PRODUCTION DETECTED — run only in sandbox!')
  process.exit(1)
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey)

// ─── Antonio's number (the firm) ─────────────────────────
const ANTONIO_PHONE_DIGITS = '17274521093'

// ─── Message line regex ──────────────────────────────────
// Format: 2025/01/15, 14:23:45 - 393332903858: text
const MSG_REGEX = /^(\d{4}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2}) - (\d+): (.+)$/
// Timestamp prefix (to detect system lines vs continuation)
const TS_PREFIX_REGEX = /^\d{4}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2} - /
// Media content patterns
const MEDIA_REGEX = /‎?(image|video|audio|sticker|document|GIF|contact card) omitted$/i

// ─── Google Drive Auth ───────────────────────────────────
interface SACredentials {
  client_email: string
  private_key: string
  token_uri: string
}

let cachedDriveToken: { token: string; expiresAt: number } | null = null

function getDriveCredentials(): SACredentials {
  const b64 = process.env.GOOGLE_SA_KEY
  if (!b64) throw new Error('GOOGLE_SA_KEY not configured')
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'))
}

async function getDriveToken(): Promise<string> {
  if (cachedDriveToken && Date.now() < cachedDriveToken.expiresAt - 5 * 60 * 1000) {
    return cachedDriveToken.token
  }
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
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  if (!res.ok) throw new Error(`Google auth failed: ${await res.text()}`)
  const data = await res.json() as { access_token: string; expires_in: number }
  cachedDriveToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return data.access_token
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const SHARED_DRIVE_ID = process.env.GOOGLE_SHARED_DRIVE_ID ?? '0AOLZHXSfKUMHUk9PVA'

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

// ─── Parse WhatsApp export ────────────────────────────────
interface ParsedMessage {
  timestamp: Date
  senderPhone: string
  content: string
  direction: 'inbound' | 'outbound'
  contentType: 'text' | 'media'
}

function parseExport(text: string, _filePhone: string): ParsedMessage[] {
  const lines = text.split('\n')
  const messages: ParsedMessage[] = []
  let current: ParsedMessage | null = null

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    const match = MSG_REGEX.exec(line)
    if (match) {
      // Flush previous message
      if (current) messages.push(current)

      const [, tsStr, senderDigits, content] = match
      // Parse timestamp: "2025/01/15, 14:23:45"
      const [datePart, timePart] = tsStr.split(', ')
      const [year, month, day] = datePart.split('/')
      const [hour, minute, second] = timePart.split(':')
      const ts = new Date(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        parseInt(hour), parseInt(minute), parseInt(second)
      )

      const isMedia = MEDIA_REGEX.test(content)
      current = {
        timestamp: ts,
        senderPhone: senderDigits,
        content,
        direction: senderDigits === ANTONIO_PHONE_DIGITS ? 'outbound' : 'inbound',
        contentType: isMedia ? 'media' : 'text',
      }
    } else if (TS_PREFIX_REGEX.test(line)) {
      // Has timestamp but no digit sender → system line, skip
      if (current) messages.push(current)
      current = null
    } else if (line.trim() && current) {
      // Continuation of previous message
      current.content += '\n' + line
    }
  }
  if (current) messages.push(current)
  return messages
}

// ─── Phone matching ───────────────────────────────────────
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}

// Strip to digits, try matching with and without leading country code
function phonesMatch(dbPhone: string | null, fileDigits: string): boolean {
  if (!dbPhone) return false
  const dbDigits = digitsOnly(dbPhone)
  if (!dbDigits) return false
  // Exact match
  if (dbDigits === fileDigits) return true
  // One is a suffix of the other (e.g. 3932903858 vs 393332903858 — unlikely, but handle)
  if (fileDigits.endsWith(dbDigits) || dbDigits.endsWith(fileDigits)) return true
  return false
}

// ─── Report types ─────────────────────────────────────────
interface Report {
  summary: {
    filesProcessed: number
    messagesImported: number
    matchedContacts: number
    matchedLeads: number
    unmatched: number
    errors: number
  }
  contacts: Array<{ name: string; phone: string; messages: number }>
  leads: Array<{ name: string; phone: string; messages: number }>
  unmatched: Array<{ phone: string; messages: number }>
  errors: Array<{ file: string; error: string }>
}

// ─── Main ─────────────────────────────────────────────────
async function main() {
  console.log('🔍 Finding WA_Export folder in Google Drive...')

  const folderResult = await driveGet('/files', {
    q: `name = 'WA_Export' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    driveId: SHARED_DRIVE_ID,
    corpora: 'drive',
    fields: 'files(id,name)',
    pageSize: '1',
  }) as { files: Array<{ id: string; name: string }> }

  if (!folderResult.files?.length) {
    console.error('❌ WA_Export folder not found in shared drive')
    process.exit(1)
  }
  const folderId = folderResult.files[0].id
  console.log(`✅ Found WA_Export folder: ${folderId}`)

  // List all .txt files
  const filesResult = await driveGet('/files', {
    q: `'${folderId}' in parents and mimeType = 'text/plain' and trashed = false`,
    driveId: SHARED_DRIVE_ID,
    corpora: 'drive',
    fields: 'files(id,name)',
    pageSize: '500',
  }) as { files: Array<{ id: string; name: string }> }

  const txtFiles = filesResult.files ?? []
  console.log(`📂 Found ${txtFiles.length} .txt files`)

  if (!txtFiles.length) {
    console.log('Nothing to import.')
    process.exit(0)
  }

  // Load WhatsApp channel ID
  const { data: channels } = await supabase
    .from('messaging_channels')
    .select('id')
    .eq('platform', 'whatsapp')
    .limit(1)

  const channelId: string | null = channels?.[0]?.id ?? null
  if (!channelId) {
    console.error('❌ No WhatsApp channel found in messaging_channels (platform = whatsapp)')
    process.exit(1)
  }
  console.log(`📡 Using WhatsApp channel: ${channelId}`)

  // Load CRM contacts and leads for matching
  const { data: contactRows } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, phone, account_id')
  const { data: leadRows } = await supabase
    .from('leads')
    .select('id, first_name, last_name, phone, company')

  const contacts = contactRows ?? []
  const leads = leadRows ?? []

  const report: Report = {
    summary: { filesProcessed: 0, messagesImported: 0, matchedContacts: 0, matchedLeads: 0, unmatched: 0, errors: 0 },
    contacts: [],
    leads: [],
    unmatched: [],
    errors: [],
  }

  for (const file of txtFiles) {
    const fileName = file.name
    // Strip .txt and extract phone: keep digits and leading +
    const rawPhone = fileName.replace(/\.txt$/i, '').trim()
    const filePhoneClean = rawPhone.startsWith('+') ? rawPhone : rawPhone
    const fileDigits = digitsOnly(filePhoneClean)

    console.log(`\n📄 Processing: ${fileName} (${fileDigits})`)

    let fileText: string
    try {
      fileText = await driveDownloadText(file.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ❌ Download failed: ${msg}`)
      report.errors.push({ file: fileName, error: msg })
      report.summary.errors++
      continue
    }

    let messages: ParsedMessage[]
    try {
      messages = parseExport(fileText, fileDigits)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ❌ Parse failed: ${msg}`)
      report.errors.push({ file: fileName, error: msg })
      report.summary.errors++
      continue
    }

    console.log(`  📩 Parsed ${messages.length} messages`)

    // Match to contact or lead
    const matchedContact = contacts.find(c => phonesMatch(c.phone, fileDigits))
    const matchedLead = !matchedContact
      ? leads.find(l => phonesMatch(l.phone, fileDigits))
      : null

    let groupName = rawPhone
    let contactId: string | null = null
    let leadId: string | null = null
    let accountId: string | null = null

    if (matchedContact) {
      contactId = matchedContact.id
      accountId = matchedContact.account_id ?? null
      groupName = [matchedContact.first_name, matchedContact.last_name].filter(Boolean).join(' ') || rawPhone
      console.log(`  ✅ Matched contact: ${groupName}`)
    } else if (matchedLead) {
      leadId = matchedLead.id
      groupName = [matchedLead.first_name, matchedLead.last_name].filter(Boolean).join(' ') || matchedLead.company || rawPhone
      console.log(`  ✅ Matched lead: ${groupName}`)
    } else {
      console.log(`  ⚠️  No CRM match found`)
    }

    const lastMessage = messages.at(-1)

    // Upsert messaging_group
    const { data: groupData, error: groupErr } = await supabase
      .from('messaging_groups')
      .upsert(
        {
          channel_id: channelId,
          external_group_id: rawPhone,
          group_name: groupName,
          group_type: 'direct',
          is_active: true,
          account_id: accountId,
          contact_id: contactId,
          lead_id: leadId,
          last_message_at: lastMessage?.timestamp.toISOString() ?? null,
          unread_count: 0,
        },
        { onConflict: 'external_group_id' }
      )
      .select('id')
      .single()

    if (groupErr || !groupData) {
      const msg = groupErr?.message ?? 'No group returned'
      console.error(`  ❌ Group upsert failed: ${msg}`)
      report.errors.push({ file: fileName, error: `Group upsert: ${msg}` })
      report.summary.errors++
      continue
    }

    const groupId = groupData.id

    // Load existing message IDs for dedup
    const { data: existingMsgs } = await supabase
      .from('messages')
      .select('external_message_id')
      .eq('group_id', groupId)

    const existingIds = new Set((existingMsgs ?? []).map(m => m.external_message_id))

    // Insert messages in batches
    let inserted = 0
    const BATCH = 200
    const toInsert = messages
      .map(msg => {
        const externalId = `${fileDigits}_${Math.floor(msg.timestamp.getTime() / 1000)}`
        if (existingIds.has(externalId)) return null
        const senderName = msg.direction === 'outbound'
          ? 'Antonio'
          : (matchedContact
              ? [matchedContact.first_name, matchedContact.last_name].filter(Boolean).join(' ')
              : matchedLead
                ? [matchedLead.first_name, matchedLead.last_name].filter(Boolean).join(' ') || matchedLead.company
                : msg.senderPhone)
        return {
          group_id: groupId,
          channel_id: channelId,
          external_message_id: externalId,
          direction: msg.direction,
          sender_phone: msg.senderPhone,
          sender_name: senderName,
          content_text: msg.content,
          content_type: msg.contentType,
          created_at: msg.timestamp.toISOString(),
          status: 'received',
        }
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)

    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH)
      const { error: insertErr } = await supabase.from('messages').insert(batch)
      if (insertErr) {
        console.error(`  ⚠️  Batch insert error: ${insertErr.message}`)
      } else {
        inserted += batch.length
      }
    }

    console.log(`  ✅ Inserted ${inserted}/${messages.length} messages (${messages.length - inserted} skipped/dupes)`)
    report.summary.messagesImported += inserted

    // Update report
    if (matchedContact) {
      report.summary.matchedContacts++
      report.contacts.push({ name: groupName, phone: rawPhone, messages: inserted })
    } else if (matchedLead) {
      report.summary.matchedLeads++
      report.leads.push({ name: groupName, phone: rawPhone, messages: inserted })
    } else {
      report.summary.unmatched++
      report.unmatched.push({ phone: rawPhone, messages: inserted })
    }
    report.summary.filesProcessed++
  }

  // Write report
  const reportPath = path.resolve(process.cwd(), 'import-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8')

  console.log('\n' + '─'.repeat(50))
  console.log('📊 Import Complete')
  console.log(`   Files processed:   ${report.summary.filesProcessed}`)
  console.log(`   Messages imported: ${report.summary.messagesImported}`)
  console.log(`   Matched contacts:  ${report.summary.matchedContacts}`)
  console.log(`   Matched leads:     ${report.summary.matchedLeads}`)
  console.log(`   Unmatched:         ${report.summary.unmatched}`)
  console.log(`   Errors:            ${report.summary.errors}`)
  console.log(`\n📄 Full report → import-report.json`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
