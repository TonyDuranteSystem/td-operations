/**
 * One-off: emit INSERT SQL for the 79 NEW WhatsApp threads (smart-merge CREATE phase)
 * to apply to PRODUCTION via the MCP execute_sql path (no DB connection here).
 *
 * Reads Drive WA_Export, skips phones that already have a prod thread (EXISTING_DIGITS),
 * matches each to a prod contact/lead (MATCH_MAP, by last-10 digits), assigns a
 * client-side UUID per new thread, and writes statements (UUIDs + dollar-quoted text)
 * to OUT, one per line-block separated by the marker `-- §STMT§`.
 *
 * Run: TZ=UTC npx tsx scripts/emit-create-sql.ts
 */
/* eslint-disable no-console */
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { SignJWT, importPKCS8 } from 'jose'
import { parseExport, digitsOnly } from './whatsapp-parse'

const CHANNEL_ID = '4cb021ab-1731-49b8-9d27-6483d2dae4f1' // prod WhatsApp Lead
const FIRM_DIGITS = '17274521093'
const OUT = '/tmp/create-prod.sql'
const DOLLAR = '$wa$'

function loadEnv() {
  const p = path.resolve(process.cwd(), '.env.local')
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue
    const i = t.indexOf('='); if (i < 0) continue
    const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[k]) process.env[k] = v
  }
}
loadEnv()

let tok: { token: string; exp: number } | null = null
async function driveToken(): Promise<string> {
  if (tok && Date.now() < tok.exp - 3e5) return tok.token
  const creds = JSON.parse(Buffer.from(process.env.GOOGLE_SA_KEY!, 'base64').toString('utf-8'))
  const now = Math.floor(Date.now() / 1000)
  const pk = await importPKCS8(creds.private_key, 'RS256')
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/drive', sub: process.env.GOOGLE_IMPERSONATE_EMAIL ?? 'support@tonydurante.us' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(creds.client_email).setAudience(creds.token_uri)
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(pk)
  const res = await fetch(creds.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
  const d = await res.json() as { access_token: string; expires_in: number }
  tok = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 }
  return d.access_token
}
const SHARED = process.env.GOOGLE_SHARED_DRIVE_ID || '0AOLZHXSfKUMHUk9PVA'
async function driveGet(ep: string, params: Record<string, string>): Promise<any> {
  const u = new URL(`https://www.googleapis.com/drive/v3${ep}`)
  u.searchParams.set('supportsAllDrives', 'true'); u.searchParams.set('includeItemsFromAllDrives', 'true')
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${await driveToken()}` } })
  if (!r.ok) throw new Error(`Drive ${r.status}: ${await r.text()}`)
  return r.json()
}
async function driveText(id: string): Promise<string> {
  const u = new URL(`https://www.googleapis.com/drive/v3/files/${id}`)
  u.searchParams.set('alt', 'media'); u.searchParams.set('supportsAllDrives', 'true')
  const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${await driveToken()}` } })
  if (!r.ok) throw new Error(`Drive dl ${r.status}`)
  return r.text()
}

function dq(v: string | null): string {
  if (v === null || v === undefined) return 'NULL'
  if (v.includes(DOLLAR)) throw new Error(`content contains dollar tag: ${v.slice(0, 40)}`)
  return DOLLAR + v + DOLLAR
}
function uuidOrNull(v: string | null | undefined): string { return v ? `'${v}'::uuid` : 'NULL::uuid' }
const d10 = (x: string) => x.slice(-10)

async function main() {
  const existing = new Set(fs.readFileSync('/tmp/prod_digits.txt', 'utf-8').split('\n').map(s => s.trim()).filter(Boolean))
  const match: Record<string, { id: string; kind: string; name: string; account_id: string | null }> = JSON.parse(fs.readFileSync('/tmp/match_map.json', 'utf-8'))

  const folder = await driveGet('/files', { q: `name = 'WA_Export' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, driveId: SHARED, corpora: 'drive', fields: 'files(id,name)', pageSize: '1' })
  const files = (await driveGet('/files', { q: `'${folder.files[0].id}' in parents and mimeType = 'text/plain' and trashed = false`, driveId: SHARED, corpora: 'drive', fields: 'files(id,name)', pageSize: '500' })).files as Array<{ id: string; name: string }>

  const groupVals: string[] = []
  const msgVals: string[] = []
  let nGroups = 0, nMsgs = 0
  const summary: Array<{ digits: string; name: string; messages: number; link: string }> = []

  for (const f of files) {
    const raw = f.name.replace(/\.txt$/i, '').trim()
    const digits = digitsOnly(raw)
    if (!digits || existing.has(digits)) continue // skip group-files + already-existing (enrich handled separately)
    const m = match[d10(digits)] ?? null
    const text = await driveText(f.id)
    const msgs = parseExport(text, digits, FIRM_DIGITS)
    if (msgs.length === 0) continue
    const gid = randomUUID()
    const name = m?.name || raw
    const contactId = m?.kind === 'contact' ? m.id : null
    const leadId = m?.kind === 'lead' ? m.id : null
    const accountId = m?.kind === 'contact' ? (m.account_id ?? null) : null
    const last = msgs.at(-1)!.timestamp.toISOString()
    groupVals.push(`('${gid}'::uuid,'${CHANNEL_ID}'::uuid,${dq(`${digits}@c.us`)},${dq(name)},'lead_chat',true,${uuidOrNull(accountId)},${uuidOrNull(contactId)},${uuidOrNull(leadId)},'${last}'::timestamptz,0)`)
    for (const msg of msgs) {
      const sender = msg.direction === 'outbound' ? 'Antonio' : (m?.name || msg.senderPhone)
      msgVals.push(`('${gid}'::uuid,'${CHANNEL_ID}'::uuid,${dq(`waexport_${digits}_${Math.floor(msg.timestamp.getTime() / 1000)}_${nMsgs}`)},${dq(msg.direction)},${dq(msg.senderPhone)},${dq(sender)},${dq(msg.content)},${dq(msg.contentType === 'media' ? 'other' : msg.contentType)},'${msg.timestamp.toISOString()}'::timestamptz,'read')`)
      nMsgs++
    }
    nGroups++
    summary.push({ digits, name, messages: msgs.length, link: m?.kind ?? 'none' })
  }

  const stmts: string[] = []
  stmts.push(`INSERT INTO messaging_groups (id,channel_id,external_group_id,group_name,group_type,is_active,account_id,contact_id,lead_id,last_message_at,unread_count) VALUES\n${groupVals.join(',\n')}`)
  const cols = `INSERT INTO messages (group_id,channel_id,external_message_id,direction,sender_phone,sender_name,content_text,content_type,created_at,status) VALUES`
  for (let i = 0; i < msgVals.length; i += 100) {
    stmts.push(`${cols}\n${msgVals.slice(i, i + 100).join(',\n')}`)
  }
  fs.writeFileSync(OUT, stmts.join('\n-- §STMT§\n'))
  fs.writeFileSync('/tmp/create-summary.json', JSON.stringify(summary, null, 2))
  console.log(`groups=${nGroups} messages=${nMsgs} statements=${stmts.length} -> ${OUT}`)
}
main().catch(e => { console.error('Fatal:', e); process.exit(1) })
