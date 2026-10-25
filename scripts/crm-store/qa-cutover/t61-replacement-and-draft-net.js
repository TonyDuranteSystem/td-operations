#!/usr/bin/env node
/**
 * t61 — (1) the "replacement file" pattern for locked originals and (2) the store_write "draft never visible" safety net, proven
 * against the SANDBOX database (dev job bd21e833 follow-up). Calls store_write directly with the SAME payload shape
 * lib/crm-store/writer.ts sends (JSON nulls included). Refuses to run against production.
 * Usage: node scripts/crm-store/qa-cutover/t61-replacement-and-draft-net.js
 */
require('dotenv').config({ path: '.env.local' })
const { Client } = require('pg')
const crypto = require('crypto')

const url = process.env.SUPABASE_DB_URL
if (!url || url.includes('ydzipybqeebtpcvsbtvs') || !url.includes('xjcxlmlpeywtwkhstjlw')) {
  process.stderr.write('Refusing: SUPABASE_DB_URL must be the SANDBOX database.\n')
  process.exit(1)
}

let pass = 0
let fail = 0
const say = (s) => process.stdout.write(s + '\n')
function check(name, ok, detail) {
  if (ok) { pass++; say('  ok   ' + name) } else { fail++; say('  FAIL ' + name + (detail ? '  → ' + JSON.stringify(detail) : '')) }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const TS = Date.now()
let n = 0
const path = () => `qa-replacement/${TS}/${++n}-${crypto.randomUUID()}`

async function main() {
  const db = new Client({ connectionString: url })
  await db.connect()
  const q = async (text, params) => (await db.query(text, params)).rows
  const call = async (fn, p) => (await q(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)]))[0].r
  const callErr = async (fn, p) => { try { await call(fn, p); return null } catch (e) { return e } }

  const [owner] = await q(`select id from public.store_owners where kind = 'business' limit 1`)
  const [folder] = await q(`select id from public.store_folders where owner_id = $1 and trashed_at is null and kind = 'custom' limit 1`, [owner.id])
  const actor = crypto.randomUUID()
  // the payload the TypeScript writer sends: every optional field is present, as a JSON null when not stated
  const write = (key, name, body, extra = {}) => call('store_write', {
    owner_id: owner.id, folder_id: folder.id, caller_key: key, name, document_type: null, period_year: null, filing_status: null,
    published: null, supersedes_file_id: null, bucket: 'crm-store', path: path(), sha256: sha(body), size: body.length,
    mime: 'application/pdf', actor, content_changed: true, links: [], subjects: [], facts: [], ...extra,
  })
  const row = async (id) => (await q(`select filing_status, published, document_type, state, current_version_id from public.store_files where id = $1`, [id]))[0]
  const lock = async (id) => (await q(`select public.store_lock_class($1) as k`, [id]))[0].k

  say('t61 — replacement files + draft safety net (sandbox)')

  // ── 1. a passport re-scan with different bytes: refused by the lock, then saved as a replacement ──
  const key = `qa-passport:${TS}`
  const a = await write(key, `ZZ QA passport ${TS}.pdf`, 'SCAN-A', { document_type: 'passport' })
  check('first passport scan → created', a.status === 'created', a)
  const same = await write(key, `ZZ QA passport ${TS}.pdf`, 'SCAN-A', { document_type: 'passport' })
  check('the same scan again → unchanged (no lock error)', same.status === 'unchanged', same)
  const e1 = await callErr('store_write', {
    owner_id: owner.id, folder_id: folder.id, caller_key: key, name: 'x.pdf', document_type: 'passport', bucket: 'crm-store', path: path(),
    sha256: sha('SCAN-B'), size: 6, mime: 'application/pdf', actor, content_changed: true,
  })
  check('a different scan under the same key → check_violation with DETAIL lock:replace_only', !!e1 && e1.code === '23514' && /lock:replace_only/.test(e1.detail || ''), e1 && { code: e1.code, detail: e1.detail, message: e1.message })

  const b = await write(`${key}:${sha('SCAN-B').slice(0, 8)}`, `ZZ QA passport ${TS} (new copy).pdf`, 'SCAN-B', { document_type: 'passport', supersedes_file_id: a.file_id })
  check('the new scan is saved as a NEW file that replaces the old one', b.status === 'created' && b.file_id !== a.file_id, b)
  check('the old file is now "replaced" (kept, locked), the new one is current', (await lock(a.file_id)) === 'replaced' && (await row(a.file_id)).state === 'live')
  const bAgain = await write(`${key}:${sha('SCAN-B').slice(0, 8)}`, `ZZ QA passport ${TS} (new copy).pdf`, 'SCAN-B', { document_type: 'passport', supersedes_file_id: a.file_id })
  check('a retry of the replacement → unchanged', bAgain.status === 'unchanged' && bAgain.file_id === b.file_id, bAgain)
  const c = await write(`${key}:${sha('SCAN-C').slice(0, 8)}`, `ZZ QA passport ${TS} (new copy 2).pdf`, 'SCAN-C', { document_type: 'passport', supersedes_file_id: b.file_id })
  check('a third scan replaces the newest copy (chain A ← B ← C)', c.status === 'created', c)
  const eBad = await callErr('store_write', {
    owner_id: owner.id, folder_id: folder.id, caller_key: `${key}:zzzz`, name: 'y.pdf', document_type: 'passport', supersedes_file_id: a.file_id, bucket: 'crm-store', path: path(),
    sha256: sha('SCAN-D'), size: 6, mime: 'application/pdf', actor, content_changed: true,
  })
  check('replacing an already-replaced file is refused (so the code must always replace the NEWEST copy)', !!eBad && /already been amended/.test(eBad.message), eBad && eBad.message)

  // a different document type cannot be the replacement (so the code reuses the old file's type)
  const eType = await callErr('store_write', {
    owner_id: owner.id, folder_id: folder.id, caller_key: `${key}:type`, name: 'z.pdf', document_type: 'id_document', supersedes_file_id: c.file_id, bucket: 'crm-store', path: path(),
    sha256: sha('SCAN-E'), size: 6, mime: 'application/pdf', actor, content_changed: true,
  })
  check('a replacement of another document type is refused', !!eType && /same document type/.test(eType.message), eType && eType.message)

  // ── 2. a signed (prefix) lease: the same pattern ──
  const lk = `lease-signed:qa-${TS}`
  const l1 = await write(lk, `ZZ QA lease ${TS}.pdf`, 'LEASE-1', { document_type: 'office_lease' })
  check('signed lease → created and locked as signed', l1.status === 'created' && (await lock(l1.file_id)) === 'signed')
  const l2 = await write(`${lk}:${sha('LEASE-2').slice(0, 8)}`, `ZZ QA lease ${TS} (new copy).pdf`, 'LEASE-2', { document_type: 'office_lease', supersedes_file_id: l1.file_id })
  check('regenerated lease saved as a replacement of the signed original', l2.status === 'created' && (await lock(l1.file_id)) === 'replaced', l2)

  // ── 3. the draft safety net, as the TypeScript writer calls it (published: null, filing_status: null) ──
  const d1 = await write(`qa-draft:${TS}:1`, `ZZ QA return ${TS}.pdf`, 'R1', { document_type: 'form_1120' })
  const r1 = await row(d1.file_id)
  check('a prepared return with NO stated status/visibility (JSON nulls) starts as a hidden DRAFT', r1.filing_status === 'draft' && r1.published === false, r1)
  const d2 = await write(`qa-draft:${TS}:2`, `ZZ QA return ${TS} b.pdf`, 'R2', { document_type: 'form_1120', filing_status: 'filed' })
  const r2 = await row(d2.file_id)
  check('a stated status (filed) is kept', r2.filing_status === 'filed', r2)
  const d3 = await write(`qa-draft:${TS}:3`, `ZZ QA return ${TS} c.pdf`, 'R3', { document_type: 'form_1120', published: false })
  const r3 = await row(d3.file_id)
  check('a stated visibility (published false) is respected and no draft is forced', r3.filing_status === 'none' && r3.published === false, r3)
  const d4 = await write(`qa-draft:${TS}:4`, `ZZ QA doc ${TS}.pdf`, 'R4', { document_type: 'other_document' })
  const r4 = await row(d4.file_id)
  check('an ordinary type is untouched by the net (status none)', r4.filing_status === 'none', r4)
  const d5 = await call('store_write', {
    owner_id: owner.id, folder_id: folder.id, caller_key: `qa-draft:${TS}:5`, name: `ZZ QA return ${TS} e.pdf`, document_type: 'form_1120',
    bucket: 'crm-store', path: path(), sha256: sha('R5'), size: 2, mime: 'application/pdf', actor,
  })
  check('a SQL caller that leaves the keys out still gets the draft (as before)', (await row(d5.file_id)).filing_status === 'draft')

  await db.end()
  say(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { process.stderr.write(String(e && e.stack ? e.stack : e) + '\n'); process.exit(1) })
