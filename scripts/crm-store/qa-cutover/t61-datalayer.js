#!/usr/bin/env node
/**
 * t61 — data-layer hardening (migration 20261025-1500-storage-datalayer-hardening.sql), proven against the SANDBOX database.
 *   · lock order: the OLD order (row lock, then owner lock) deadlocks against a writer; the NEW functions serialise instead
 *   · rehome drops links / people that do not belong to the new owner, and restores them when the file comes back
 *   · a slot with a queued register job is not "abandoned"
 *   · current_version_id must be a version of the same file
 *   · "2. Contacts" holds no files / folders
 * Refuses to run against production. Usage: node scripts/crm-store/qa-cutover/t61-datalayer.js
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
const path = () => `qa-datalayer/${TS}/${++n}-${crypto.randomUUID()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const newClient = async () => { const c = new Client({ connectionString: url }); await c.connect(); await c.query("set lock_timeout = '20s'; set deadlock_timeout = '300ms'"); return c }

async function main() {
  const db = await newClient()
  const q = async (text, params) => (await db.query(text, params)).rows
  const call = async (fn, p) => (await q(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)]))[0].r
  const errOf = async (text, params) => { try { await db.query(text, params); return null } catch (e) { return e } }

  // two company storages: o1 has an active member C and a custom folder; o2 is another company where C is NOT a member
  const [o1] = await q(`select o.id, o.account_id, ac.contact_id, (select f.id from store_folders f where f.owner_id = o.id and f.kind = 'custom' and f.trashed_at is null limit 1) as folder
                          from store_owners o join account_contacts ac on ac.account_id = o.account_id
                         where o.kind = 'company' and ac.ended_at is null
                           and exists (select 1 from store_folders f where f.owner_id = o.id and f.kind = 'custom' and f.trashed_at is null) limit 1`)
  const [o2] = await q(`select o.id, (select f.id from store_folders f where f.owner_id = o.id and f.kind = 'custom' and f.trashed_at is null limit 1) as folder
                          from store_owners o
                         where o.kind = 'company' and o.id <> $1
                           and not exists (select 1 from account_contacts ac where ac.account_id = o.account_id and ac.contact_id = $2)
                           and exists (select 1 from store_folders f where f.owner_id = o.id and f.kind = 'custom' and f.trashed_at is null) limit 1`, [o1.id, o1.contact_id])
  const actor = crypto.randomUUID()
  const base = (o) => ({ owner_id: o.id, folder_id: o.folder, bucket: 'crm-store', mime: 'application/pdf', actor })
  const write = (o, key, name, body, extra = {}) => call('store_write', { ...base(o), caller_key: key, name, sha256: sha(body), path: path(), size: body.length, ...extra })

  say('t61 — data-layer hardening (sandbox)')

  // ───────── 1. lock order
  // OLD order (what the functions did before): row lock first, then the owner lock → deadlocks against a writer that holds the owner lock
  const wOld = await write(o1, `qa-dl:${TS}:old`, `ZZ QA dl old order ${TS}.pdf`, 'old')
  {
    const A = await newClient(); const B = await newClient()
    await B.query('begin'); await B.query('select id from public.store_files where id = $1 for update', [wOld.file_id])
    await A.query('begin'); await A.query('select public.store_lock_owner($1)', [o1.id])
    const pa = A.query('update public.store_files set needs_review_reason = needs_review_reason where id = $1', [wOld.file_id]).then(() => null, (e) => e)
    await sleep(500)
    const pb = B.query('select public.store_lock_owner($1)', [o1.id]).then(() => null, (e) => e)
    const [ea, eb] = await Promise.all([pa, pb])
    const dead = [ea, eb].filter((e) => e && e.code === '40P01').length
    check('the OLD order (row lock, then owner lock) deadlocks against a writer — the bug', dead === 1, { ea: ea && ea.code, eb: eb && eb.code })
    await A.query('rollback').catch(() => {}); await B.query('rollback').catch(() => {})
    await A.end(); await B.end()
  }

  // NEW order: a writer holds the owner lock and then updates the file row; the function must WAIT, not deadlock
  async function pair(label, setup, fn) {
    let bad = 0
    for (let i = 0; i < 6; i++) {
      const ctx = await setup(i)
      const A = await newClient(); const B = await newClient()
      await A.query('begin'); await A.query('select public.store_lock_owner($1)', [o1.id])
      await A.query('update public.store_files set needs_review_reason = needs_review_reason where id = $1', [ctx.fileId])
      const pb = fn(B, ctx, i).then(() => null, (e) => e)
      await sleep(400)
      await A.query('commit')
      const eb = await pb
      if (eb && eb.code === '40P01') bad++
      await A.end(); await B.end()
    }
    check(`${label}: waits for the writer's owner lock instead of deadlocking (6 rounds)`, bad === 0, { bad })
  }
  await pair('store_set_published',
    async (i) => ({ fileId: (await write(o1, `qa-dl:${TS}:pub${i}`, `ZZ QA dl pub ${TS} ${i}.pdf`, 'p' + i)).file_id }),
    (B, ctx, i) => B.query('select public.store_set_published($1, $2, $3)', [ctx.fileId, i % 2 === 0, actor]))
  await pair('store_set_filing_status',
    async (i) => ({ fileId: (await write(o1, `qa-dl:${TS}:fs${i}`, `ZZ QA dl fs ${TS} ${i}.pdf`, 'f' + i)).file_id }),
    (B, ctx) => B.query('select public.store_set_filing_status($1, $2, $3)', [ctx.fileId, 'draft', actor]))
  await pair('store_remove_link',
    async (i) => {
      const w = await write(o1, `qa-dl:${TS}:rl${i}`, `ZZ QA dl rl ${TS} ${i}.pdf`, 'r' + i)
      const t = await write(o1, `qa-dl:${TS}:rlt${i}`, `ZZ QA dl rlt ${TS} ${i}.pdf`, 't' + i)
      await q(`insert into public.store_record_links (file_id, link_kind, record_id) values ($1, 'fax_transmission', $2)`, [w.file_id, t.file_id])
      return { fileId: w.file_id, target: t.file_id }
    },
    (B, ctx) => B.query('select public.store_remove_link($1, $2, $3, $4)', [ctx.fileId, 'fax_transmission', ctx.target, actor]))
  {
    const [fo] = await q(`select id, service_delivery_id from store_owners where kind = 'formation' and service_delivery_id is not null limit 1`)
    let bad = 0; let waited = 0
    for (let i = 0; i < 4; i++) {
      const A = await newClient(); const B = await newClient()
      await A.query('begin'); await A.query('select public.store_lock_owner($1)', [fo.id])
      await A.query('update public.store_owners set updated_at = updated_at where id = $1', [fo.id])
      const t0 = Date.now()
      const pb = B.query('select public.store_attach_formation($1, $2)', [fo.service_delivery_id, crypto.randomUUID()]).then(() => null, (e) => e)
      await sleep(400); await A.query('commit')
      const eb = await pb
      if (Date.now() - t0 >= 380) waited++
      if (eb && eb.code === '40P01') bad++
      await A.end(); await B.end()
    }
    check('store_attach_formation: waits for the writer instead of deadlocking (4 rounds, then refuses the unlinked company as before)', bad === 0 && waited === 4, { bad, waited })
    const nothing = await q(`select public.store_attach_formation($1, $2) as r`, [crypto.randomUUID(), crypto.randomUUID()])
    check('store_attach_formation: unknown service case → NULL (unchanged behaviour)', nothing[0].r === null)
  }
  { // two real concurrent writers + a toggler: no deadlock errors at all
    const w = await write(o1, `qa-dl:${TS}:mix`, `ZZ QA dl mix ${TS}.pdf`, 'mix')
    const clients = await Promise.all([1, 2, 3, 4].map(() => newClient()))
    const jobs = []
    for (let i = 0; i < 12; i++) {
      const c = clients[i % 4]
      const body = 'mix' + i
      jobs.push((i % 3 === 0
        ? c.query('select public.store_set_published($1, $2, $3)', [w.file_id, i % 2 === 0, actor])
        : c.query('select public.store_write($1::jsonb)', [JSON.stringify({ ...base(o1), caller_key: `qa-dl:${TS}:mix`, name: `ZZ QA dl mix ${TS}.pdf`, sha256: sha(body), path: path(), size: body.length })])
      ).then(() => null, (e) => e))
    }
    const errs = (await Promise.all(jobs)).filter((e) => e && e.code === '40P01')
    check('12 mixed concurrent saves + show/hide calls on one file: no "deadlock detected"', errs.length === 0, errs.map((e) => e.message))
    await Promise.all(clients.map((c) => c.end()))
  }

  // ───────── 2. rehome drops what does not belong, and restores it on the way back
  const f1 = await write(o1, `qa-dl:${TS}:rehome`, `ZZ QA dl rehome ${TS}.pdf`, 'rehome')
  const other = await write(o1, `qa-dl:${TS}:rehome-t`, `ZZ QA dl rehome target ${TS}.pdf`, 'rehome-t')
  await q(`insert into public.store_record_links (file_id, link_kind, record_id) values ($1, 'fax_transmission', $2)`, [f1.file_id, other.file_id])
  await q(`insert into public.store_file_subjects (file_id, subject_kind, contact_id, role) values ($1, 'person', $2, 'qa-dl')`, [f1.file_id, o1.contact_id])
  const counts = async () => (await q(`select (select count(*) from store_record_links where file_id = $1)::int as l, (select count(*) from store_file_subjects where file_id = $1)::int as s`, [f1.file_id]))[0]
  check('before the move the file has 1 link and 1 person', JSON.stringify(await counts()) === '{"l":1,"s":1}', await counts())
  await q(`select public.store_rehome_file($1, $2, $3, 'qa rehome')`, [f1.file_id, o2.folder, actor])
  const after = await counts()
  check('moved to another company: the link (to a file of the old owner) and the person (not in that company) are dropped', after.l === 0 && after.s === 0, after)
  const ev = await q(`select details from store_events where file_id = $1 and event = 'rehome_dropped' order by id desc limit 1`, [f1.file_id])
  check('one history row keeps what was dropped', ev.length === 1 && ev[0].details.links.length === 1 && ev[0].details.subjects.length === 1, ev)
  await q(`select public.store_rehome_file($1, $2, $3, 'qa rehome back')`, [f1.file_id, o1.folder, actor])
  const back = await counts()
  check('moved BACK to the first company: the link and the person are restored (undo is lossless)', back.l === 1 && back.s === 1, back)
  const ownerNow = (await q(`select owner_id from store_files where id = $1`, [f1.file_id]))[0].owner_id
  check('and the file is back with its first owner', ownerNow === o1.id)

  // ───────── 3. queued register job → not abandoned
  const [i1] = await q(`insert into public.store_upload_intents (owner_id, folder_id, created_by, file_name, staging_path, expires_at, dest_path)
                         values ($1, $2, $3, 'ZZ QA dl big.pdf', $4, now() - interval '3 hours', $5) returning id`, [o1.id, o1.folder, actor, `qa-dl/${TS}/stage-${crypto.randomUUID()}`, `${o1.id}/${crypto.randomUUID()}`])
  const listed = async () => (await q(`select id from public.store_abandoned_intents(1000)`)).some((r) => r.id === i1.id)
  check('an expired, unclaimed slot with no job IS abandoned (unchanged)', await listed() === true)
  const [job] = await q(`insert into public.job_queue (job_type, payload, status, related_entity_type, related_entity_id) values ('crm_store_register_upload', '{}'::jsonb, 'pending', 'store_upload_intent', $1) returning id`, [i1.id])
  check('the same slot with a PENDING register job is NOT abandoned (its staged bytes are kept)', await listed() === false)
  await q(`update public.job_queue set status = 'failed' where id = $1`, [job.id])
  check('once the job has failed the slot is abandoned again', await listed() === true)
  await q(`update public.store_upload_intents set consumed_at = now() where id = $1`, [i1.id])
  await q(`delete from public.job_queue where id = $1`, [job.id])

  // ───────── 4. purge sweep: bounded, same answer shape
  const pp = await q(`select count(*)::int as c from public.store_purge_pending_objects(5)`)
  check('store_purge_pending_objects(5) answers (at most 5 rows)', pp[0].c <= 5, pp[0])

  // ───────── 5. current version must belong to the file
  const e5 = await errOf(`update public.store_files set current_version_id = (select current_version_id from public.store_files where id = $2) where id = $1`, [f1.file_id, other.file_id])
  check('a file cannot point at another file\'s version', !!e5 && e5.code === '23503', e5 && e5.message)
  const e5b = await errOf(`select public.store_write($1::jsonb)`, [JSON.stringify({ ...base(o1), caller_key: `qa-dl:${TS}:ok`, name: `ZZ QA dl ok ${TS}.pdf`, sha256: sha('ok'), path: path(), size: 2 })])
  check('normal writes (file row first, version second, deferred check) still work', e5b === null, e5b && e5b.message)

  // ───────── 6. "2. Contacts" is a view
  const [cf] = await q(`select id, owner_id from store_folders where kind = 'contacts' and trashed_at is null limit 1`)
  if (cf) {
    const e6 = await errOf(`update public.store_files set folder_id = $2 where id = $1`, [f1.file_id, cf.id])
    check('a file cannot be moved into a "2. Contacts" folder (database refuses)', !!e6 && e6.code === '23514', e6 && e6.message)
    const e6b = await errOf(`insert into public.store_folders (owner_id, parent_id, kind, name) values ($1, $2, 'custom', 'ZZ QA dl sub')`, [cf.owner_id, cf.id])
    check('a folder cannot be created inside "2. Contacts" (database refuses)', !!e6b && e6b.code === '23514', e6b && e6b.message)
  } else check('a "2. Contacts" folder exists in the sandbox', false)

  // grants
  const g = await q(`select has_function_privilege('anon', 'public.store_rehome_reconcile(uuid[], uuid, uuid, uuid)', 'execute') as a, has_function_privilege('authenticated', 'public.store_subject_belongs(uuid, text, uuid, uuid)', 'execute') as b`)
  check('the new functions are closed to anon / signed-in users', g[0].a === false && g[0].b === false, g[0])

  await db.end()
  say(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { process.stderr.write(String(e && e.stack ? e.stack : e) + '\n'); process.exit(1) })
