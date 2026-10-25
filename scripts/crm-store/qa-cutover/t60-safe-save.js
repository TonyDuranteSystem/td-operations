#!/usr/bin/env node
/**
 * t60 — the ONE safe save (dev job bd21e833, master plan Part 54 step 1), proven against the SANDBOX database.
 * Calls store_write / store_append_version / the lock trigger directly. Refuses to run against production.
 * Usage: node scripts/crm-store/qa-cutover/t60-safe-save.js
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
const path = () => `qa-safe-save/${TS}/${++n}-${crypto.randomUUID()}`

async function main() {
  const db = new Client({ connectionString: url })
  await db.connect()
  const q = async (text, params) => (await db.query(text, params)).rows
  const call = async (fn, p) => (await q(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)]))[0].r
  const callErr = async (fn, p) => { try { await call(fn, p); return null } catch (e) { return e } }

  const [owner] = await q(`select id from public.store_owners where kind = 'business' limit 1`)
  const [folder] = await q(`select id from public.store_folders where owner_id = $1 and trashed_at is null and kind = 'custom' limit 1`, [owner.id])
  const actor = crypto.randomUUID()
  const other = crypto.randomUUID()
  const base = { owner_id: owner.id, folder_id: folder.id, bucket: 'crm-store', mime: 'application/pdf', actor }
  const write = (key, name, body, extra = {}) => call('store_write', { ...base, caller_key: key, name, sha256: sha(body), path: path(), size: body.length, ...extra })
  const append = (fileId, body, extra = {}) => call('store_append_version', { file_id: fileId, sha256: sha(body), bucket: 'crm-store', path: path(), size: body.length, mime: 'application/pdf', actor, source: 'web', ...extra })
  const versions = (fileId) => q(`select version_no, unmerged, sha256 from public.store_file_versions where file_id = $1 order by version_no`, [fileId])
  const cur = async (fileId) => (await q(`select v.version_no from public.store_files f join public.store_file_versions v on v.id = f.current_version_id where f.id = $1`, [fileId]))[0].version_no

  say('t60 — safe save (sandbox)')

  // ordinary file
  const k1 = `qa-safe:${TS}:1`
  const w1 = await write(k1, `ZZ QA safe save ${TS}.pdf`, 'A')
  check('a new file starts at version 1', w1.status === 'created' && (await cur(w1.file_id)) === 1, w1)
  const f1 = w1.file_id

  const a2 = await append(f1, 'B', { expected_version_no: 1 })
  check('append with the right base → versioned v2', a2.status === 'versioned' && a2.version_no === 2, a2)
  check('the file now points at v2', (await cur(f1)) === 2)

  const c3 = await append(f1, 'C', { expected_version_no: 1 })
  check('a stale base → conflict, nothing written', c3.status === 'conflict' && c3.current_version_no === 2 && (await versions(f1)).length === 2, c3)

  const retry = await append(f1, 'B', { expected_version_no: 1 })
  check('a retry of an already-applied save → unchanged (already applied), not a conflict', retry.status === 'unchanged' && retry.already_applied === true, retry)

  const stale = await append(f1, 'A', { expected_version_no: 1, actor: other })
  check('a stale editor whose bytes equal an OLD version still gets a conflict (conflict test is first)', stale.status === 'conflict', stale)

  const same = await append(f1, 'B', { expected_version_no: 2 })
  check('same bytes as the current version → unchanged', same.status === 'unchanged' && !same.already_applied, same)

  const um = await append(f1, 'D', { expected_version_no: 1, unmerged: true })
  check('a lost race kept as an "unmerged" hidden version (v3), current stays v2', um.status === 'unmerged' && um.version_no === 3 && (await cur(f1)) === 2, um)

  const a4 = await append(f1, 'E', { expected_version_no: 2 })
  check('the next save is max+1 (v4), not a collision with the unmerged v3', a4.status === 'versioned' && a4.version_no === 4, a4)

  const legacy = await write(k1, `ZZ QA safe save ${TS}.pdf`, 'F')
  check('the OLD save path (store_write by key) also takes max+1 (v5)', legacy.status === 'versioned' && (await cur(f1)) === 5, legacy)

  const ev = (await q(`select details from public.store_events where file_id = $1 and event = 'version_added' and details ? 'source' order by occurred_at desc limit 1`, [f1]))[0]
  check('the audit event of the new function keeps source and base version', ev && ev.details.source === 'web' && ev.details.base_version_no === 2 && ev.details.version_no === 4, ev)

  // no new current version: same-bytes + unknown file
  const nf = await append(crypto.randomUUID(), 'X', { expected_version_no: 1 })
  check('an unknown file → not_found', nf.status === 'not_found', nf)

  // signed (by filing key)
  const ks = `esign-signed:qa-${TS}`
  const ws = await write(ks, `ZZ QA signed ${TS}.pdf`, 'S1')
  const as = await append(ws.file_id, 'S2', { expected_version_no: 1 })
  check('a SIGNED file (by filing key) → locked, not versioned', as.status === 'locked' && as.kind === 'signed' && (await cur(ws.file_id)) === 1, as)
  const es = await callErr('store_write', { ...base, caller_key: ks, name: `ZZ QA signed ${TS}.pdf`, sha256: sha('S3'), path: path(), size: 2 })
  check('the OLD save path cannot change a signed file either (trigger)', es && /signed document/.test(es.message) && (await cur(ws.file_id)) === 1, es && es.message)
  const ss = await append(ws.file_id, 'S1', { expected_version_no: 1 })
  check('saving the same bytes to a signed file is harmless (unchanged)', ss.status === 'unchanged', ss)

  // passport (catalog replace_only)
  const kp = `qa-safe:${TS}:passport`
  const wp = await write(kp, `ZZ QA passport ${TS}.pdf`, 'P1', { document_type: 'passport' })
  const ap = await append(wp.file_id, 'P2', { expected_version_no: 1 })
  check('a PASSPORT (document type) → locked replace_only', ap.status === 'locked' && ap.kind === 'replace_only', ap)
  const ep = await callErr('store_write', { ...base, caller_key: kp, name: `ZZ QA passport ${TS}.pdf`, sha256: sha('P3'), path: path(), size: 2, document_type: 'passport' })
  check('the OLD save path cannot change a passport either', ep && /passport or ID/.test(ep.message), ep && ep.message)

  // amended
  const ka = `qa-safe:${TS}:amended`
  const wa = await write(ka, `ZZ QA amended ${TS}.pdf`, 'M1', { filing_status: 'amended' })
  const aa = await append(wa.file_id, 'M2', { expected_version_no: 1 })
  check('an AMENDED return → needs_confirmation, nothing written', aa.status === 'needs_confirmation' && (await cur(wa.file_id)) === 1, aa)
  const ea = await callErr('store_write', { ...base, caller_key: ka, name: `ZZ QA amended ${TS}.pdf`, sha256: sha('M3'), path: path(), size: 2 })
  check('the OLD save path cannot change an amended file (no confirmation possible there)', ea && /amended return/.test(ea.message), ea && ea.message)
  const ac = await append(wa.file_id, 'M2', { expected_version_no: 1, confirmed: true, reason: 'QA correction' })
  check('with the confirmation flag the amended file takes the version', ac.status === 'versioned' && (await cur(wa.file_id)) === 2, ac)
  const flag = (await q(`select current_setting('store.edit_confirmed', true) as v`))[0].v
  check('the confirmation flag does not leak past the transaction', flag === null || flag === '' || flag === 'off', flag)

  // filed
  const kf = `qa-safe:${TS}:filed`
  const wf = await write(kf, `ZZ QA filed ${TS}.pdf`, 'F1', { filing_status: 'filed' })
  const af = await append(wf.file_id, 'F2', { expected_version_no: 1 })
  check('a FILED return → frozen', af.status === 'frozen', af)

  // replaced by an amendment file
  const kr = `qa-safe:${TS}:orig`
  const wr = await write(kr, `ZZ QA original ${TS}.pdf`, 'R1')
  await write(`qa-safe:${TS}:amend`, `ZZ QA amendment ${TS}.pdf`, 'R2', { supersedes_file_id: wr.file_id })
  const ar = await append(wr.file_id, 'R3', { expected_version_no: 1 })
  check('a file replaced by a newer file → locked (replaced)', ar.status === 'locked' && ar.kind === 'replaced', ar)

  // two saves at the same moment
  const kc = `qa-safe:${TS}:race`
  const wc = await write(kc, `ZZ QA race ${TS}.pdf`, 'Z0')
  const [r1, r2] = await Promise.all([append(wc.file_id, 'Z1', { expected_version_no: 1 }), append(wc.file_id, 'Z2', { expected_version_no: 1, actor: other })])
  const statuses = [r1.status, r2.status].sort().join(',')
  check('two saves from the same base at the same moment: exactly one wins, the other is a conflict', statuses === 'conflict,versioned', { r1, r2 })
  check('the file has exactly 2 versions after the race', (await versions(wc.file_id)).length === 2)

  // grants
  const g = await q(`select has_function_privilege('anon', 'public.store_append_version(jsonb)', 'execute') as a, has_function_privilege('authenticated', 'public.store_append_version(jsonb)', 'execute') as b, has_function_privilege('anon', 'public.store_lock_class(uuid)', 'execute') as c`)
  check('the new functions are closed to anon / signed-in users', g[0].a === false && g[0].b === false && g[0].c === false, g[0])

  await db.end()
  say(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { process.stderr.write(String(e && e.stack ? e.stack : e) + '\n'); process.exit(1) })
