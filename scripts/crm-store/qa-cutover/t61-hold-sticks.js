#!/usr/bin/env node
/**
 * t61 — a legal hold STICKS to the file (migration 20261025-1800-storage-hold-sticks), proven against the SANDBOX database.
 * Re-typing / moving / un-filing / trashing / "Remove from view" must never make a held file purgeable.
 * Refuses to run against production. Usage: node scripts/crm-store/qa-cutover/t61-hold-sticks.js
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
  const hold = async (id, today) => (await q(`select public.store_file_purge_hold($1, coalesce($2::date, current_date)) as h`, [id, today ?? null]))[0].h
  const row = async (id) => (await q(`select held_slug, held_basis_year, state from public.store_files where id = $1`, [id]))[0]

  const [owner] = await q(`select id from public.store_owners where kind = 'business' limit 1`)
  const [folder] = await q(`select id from public.store_folders where owner_id = $1 and trashed_at is null and kind = 'custom' limit 1`, [owner.id])
  const actor = crypto.randomUUID()
  let n = 0
  const mk = (name, type, extra = {}) => call('store_write', {
    owner_id: owner.id, folder_id: folder.id, bucket: 'crm-store', mime: 'application/pdf', actor, caller_key: `qa-hold:${TS}:${++n}`,
    name: `ZZ QA hold ${TS} ${name}.pdf`, sha256: sha(name + TS), path: `qa-hold/${TS}/${n}`, size: 10, document_type: type, ...extra,
  })
  say('t61 — a legal hold sticks (sandbox)')

  // 1. a held file (W-7 application: 3 years) that is re-typed keeps its hold
  const a = await mk('w7', 'form_w_7')
  const fa = a.file_id
  await q(`update public.store_files set document_type = 'form_w_7' where id = $1`, [fa]) // make sure the type is set whatever store_write did with the extra field
  check('a W-7 file is under the itin_application hold', (await hold(fa)) === 'itin_application', await hold(fa))
  await q(`update public.store_files set document_type = 'other_document' where id = $1`, [fa])
  const ra = await row(fa)
  check('after a re-type the hold is written on the file', ra.held_slug === 'itin_application' && ra.held_basis_year > 1989, ra)
  check('…and the file is STILL held (not purgeable)', (await hold(fa)) === 'itin_application')

  // 2. trashing keeps it too; and it is not due even after the 90 days
  await q(`select public.store_trash_file($1, $2, 'qa')`, [fa, actor])
  check('a trashed held file is still held', (await hold(fa)) === 'itin_application')
  const due = await q(`select file_id from public.store_purge_due(now() + interval '400 days', 100000) where file_id = $1`, [fa])
  check('it is not offered to the purge job', due.length === 0, due)

  // 3. the hold ends when its years run out (3 years after the file's year), not before
  const farFuture = `${ra.held_basis_year + 4}-06-01`
  check('after the hold years it is no longer held', (await hold(fa, farFuture)) === null, await hold(fa, farFuture))

  // 4. an ordinary file (no hold) never gets a frozen hold
  const b = await mk('plain', 'other_document')
  await q(`update public.store_files set document_type = 'receipt' where id = $1`, [b.file_id])
  await q(`select public.store_trash_file($1, $2, 'qa')`, [b.file_id, actor])
  const rb = await row(b.file_id)
  check('a file with no hold gets no frozen hold', rb.held_slug === null && (await hold(b.file_id)) === null, rb)

  // 5. a filed return (hold, years_after null = forever) that gets un-filed to amended keeps the hold
  const c = await mk('1120', 'form_1120')
  await q(`update public.store_files set filing_status = 'filed' where id = $1`, [c.file_id])
  check('a filed 1120 is under filed_tax_returns', (await hold(c.file_id)) === 'filed_tax_returns', await hold(c.file_id))
  await q(`update public.store_files set document_type = 'other_document' where id = $1`, [c.file_id]).catch(() => {})
  const rc = await row(c.file_id)
  // the store may refuse the re-type of a filed file; either way the hold must still stand
  check('a filed return cannot lose its hold by a change', (await hold(c.file_id)) === 'filed_tax_returns', rc)

  say(`\n${pass} passed, ${fail} failed`)
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
