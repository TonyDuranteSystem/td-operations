#!/usr/bin/env node
/**
 * t62 — re-homing a file freezes its legal hold BEFORE it drops the links that did not follow it
 * (migration 20261026-0900-storage-rehome-freeze-hold), proven against the SANDBOX database.
 * Refuses to run against production. Usage: node scripts/crm-store/qa-cutover/t62-rehome-freeze-hold.js
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

async function main() {
  const db = new Client({ connectionString: url })
  await db.connect()
  const q = async (text, params) => (await db.query(text, params)).rows
  const call = async (fn, p) => (await q(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)]))[0].r
  const hold = async (id) => (await q(`select public.store_file_purge_hold($1) as h`, [id]))[0].h
  const row = async (id) => (await q(`select held_slug, held_basis_year from public.store_files where id = $1`, [id]))[0]
  const links = async (id) => (await q(`select count(*)::int as n from public.store_record_links where file_id = $1`, [id]))[0].n

  const [folder] = await q(`select f.id, f.owner_id from public.store_folders f join public.store_owners o on o.id = f.owner_id
                             where o.kind = 'company' and o.account_id is not null and f.trashed_at is null and f.kind = 'custom' limit 1`)
  const [A] = await q(`select id, account_id from public.store_owners where id = $1`, [folder.owner_id])
  const [B] = await q(`select id, account_id from public.store_owners where kind = 'company' and account_id is not null and id <> $1 limit 1`, [A.id])
  const [sd] = await q(`insert into public.service_deliveries (account_id, service_name, service_type) values ($1, 'ZZ QA t62 ITIN', 'ITIN') returning id`, [A.account_id])
  const actor = crypto.randomUUID()
  let n = 0
  const mk = (name, type) => call('store_write', {
    owner_id: A.id, folder_id: folder.id, bucket: 'crm-store', mime: 'application/pdf', actor, caller_key: `qa-rehome:${TS}:${++n}`,
    name: `ZZ QA rehome ${TS} ${name}.pdf`, sha256: sha(name + TS), path: `qa-rehome/${TS}/${n}`, size: 10, document_type: type,
  })
  const reconcile = (id, from, to) => q(`select public.store_rehome_reconcile($1::uuid[], $2, $3, $4)`, [[id], from, to, actor])
  say('t62 — re-home freezes the hold (sandbox)')

  // 1. a passport held ONLY by an ITIN service-case link
  const p = (await mk('passport', 'passport')).file_id
  await q(`update public.store_files set document_type = 'passport' where id = $1`, [p])
  await q(`insert into public.store_record_links (file_id, link_kind, record_id) values ($1, 'service_case', $2)`, [p, sd.id])
  check('the passport is held through the ITIN link', (await hold(p)) === 'itin_identity', await hold(p))
  check('…and nothing is frozen on it yet', (await row(p)).held_slug === null)
  await reconcile(p, A.id, B.id)
  const rp = await row(p)
  check('the ITIN link did not follow the file', (await links(p)) === 0)
  check('the hold is written on the file', rp.held_slug === 'itin_identity' && rp.held_basis_year > 1989, rp)
  check('the file is STILL held after the link is gone', (await hold(p)) === 'itin_identity')

  // 2. an ordinary file with a link that does not follow: no hold invented
  const r = (await mk('plain', 'other_document')).file_id
  await q(`insert into public.store_record_links (file_id, link_kind, record_id) values ($1, 'service_case', $2)`, [r, sd.id])
  await reconcile(r, A.id, B.id)
  check('an ordinary file: link dropped, no frozen hold', (await links(r)) === 0 && (await row(r)).held_slug === null, await row(r))

  // 3. a passport whose link DOES belong (same owner): untouched
  const s = (await mk('passport-keep', 'passport')).file_id
  await q(`update public.store_files set document_type = 'passport' where id = $1`, [s])
  await q(`insert into public.store_record_links (file_id, link_kind, record_id) values ($1, 'service_case', $2)`, [s, sd.id])
  await reconcile(s, B.id, A.id)
  check('a link that still belongs is kept and nothing is frozen', (await links(s)) === 1 && (await row(s)).held_slug === null, await row(s))

  // 4. running it again is harmless
  const before = await row(p)
  await reconcile(p, A.id, B.id)
  const after = await row(p)
  check('a second run changes nothing', JSON.stringify(before) === JSON.stringify(after), { before, after })

  await q(`delete from public.store_record_links where record_id = $1`, [sd.id])
  await q(`delete from public.service_deliveries where id = $1`, [sd.id]).catch(() => say('  (note: temp ITIN delivery left behind)'))
  say(`\n${pass} passed, ${fail} failed`)
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
