#!/usr/bin/env node
/* eslint-disable */
/**
 * Change Name, Track S2/S3 — SANDBOX proofs for store_apply_name_change / store_undo_name_change and the two *_for_account
 * wrappers (migrations 20261019-1400 + 20261019-1500).
 *
 * Every scenario runs inside its own  BEGIN … ROLLBACK  on a SEEDED fixture company shaped like the pilot company
 * (top folder + the five standard folders + a 2025 tax-year folder with files) — never real client data. The one
 * scenario that needs two live connections (concurrency) commits a "ZZ Proof" test company and says so.
 *
 *   node scripts/crm-store/name-change-proofs.js            (refuses to run against production)
 */
require('dotenv').config({ path: '.env.local' })
const { Client } = require('pg')
const crypto = require('crypto')

const dbUrl = process.env.SUPABASE_DB_URL || ''
if (!dbUrl || dbUrl.includes('ydzipybqeebtpcvsbtvs') || (process.env.NEXT_PUBLIC_SUPABASE_URL || '').includes('ydzipybqeebtpcvsbtvs')) {
  console.error('REFUSED: SUPABASE_DB_URL missing or pointing at production'); process.exit(2)
}
if (!dbUrl.includes('xjcxlmlpeywtwkhstjlw') && !/127\.0\.0\.1|localhost/.test(dbUrl)) { console.error('REFUSED: not the sandbox'); process.exit(2) }

const TAG = Date.now().toString(36)
const results = []
const connect = async () => { const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } }); await c.connect(); return c }
const q = async (c, sql, params) => (await c.query(sql, params)).rows
const one = async (c, sql, params) => (await q(c, sql, params))[0]
const call = async (c, sql, params) => (await one(c, `SELECT ${sql} AS r`, params)).r
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg) }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}\n      got      ${JSON.stringify(a)}\n      expected ${JSON.stringify(b)}`)
const sha = () => crypto.randomBytes(32).toString('hex')

async function scenario(name, fn) {
  const c = await connect()
  try {
    await c.query('BEGIN')
    await fn(c)
    await c.query('ROLLBACK')
    results.push({ name, ok: true })
  } catch (e) {
    try { await c.query('ROLLBACK') } catch {}
    results.push({ name, ok: false, err: e.message })
  } finally { await c.end() }
}

/** Run a call that must be REFUSED; the savepoint puts the transaction back exactly as it was. */
async function refused(c, sql, params, pattern) {
  await c.query('SAVEPOINT sp_refused')
  try { await c.query(sql, params) } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT sp_refused'); await c.query('RELEASE SAVEPOINT sp_refused')
    assert(pattern.test(e.message), `refusal text ${JSON.stringify(e.message)} does not match ${pattern}`)
    return e.message
  }
  throw new Error('ASSERT: the call was expected to be refused but succeeded')
}

// ───────────────────────────────────────────────────────────── the fixture: an IAA-shaped company, all test data
async function put(c, ownerId, folderId, name, key, extra = {}) {
  const r = await call(c, `store_write($1::jsonb)`, [JSON.stringify({
    owner_id: ownerId, folder_id: folderId, name, sha256: sha(), bucket: 'crm-store', path: `proof/${TAG}/${crypto.randomUUID()}`,
    size: 10, mime: 'application/pdf', caller_key: key, ...extra })])
  assert(['created', 'versioned', 'unchanged'].includes(r.status), `store_write gave ${JSON.stringify(r)}`)
  return r.file_id
}
async function seed(c, label, opts = {}) {
  const name = opts.name || `ZZ Proof ${label} ${TAG} LLC`
  const acct = await one(c, `INSERT INTO accounts (company_name, is_test) VALUES ($1, true) RETURNING id`, [name])
  const owner = await one(c, `INSERT INTO store_owners (kind, account_id) VALUES ('company', $1) RETURNING id`, [acct.id])
  await c.query(`SELECT store_apply_template($1, 'company_standard', $2, NULL)`, [owner.id, name])
  const f = {}
  for (const r of await q(c, `SELECT id, kind FROM store_folders WHERE owner_id = $1`, [owner.id])) f[r.kind] = r.id
  f.year2025 = (await one(c, `INSERT INTO store_folders (owner_id, parent_id, kind, name) VALUES ($1, $2, 'tax_year', '2025') RETURNING id`, [owner.id, f.tax])).id
  const files = {
    oa: await put(c, owner.id, f.company, 'Operating Agreement.pdf', `proof:${TAG}:${label}:oa`),
    ein: await put(c, owner.id, f.company, 'EIN Letter.pdf', `proof:${TAG}:${label}:ein`),
    welcome: await put(c, owner.id, f.correspondence, 'Welcome Letter.pdf', `proof:${TAG}:${label}:welcome`),
    ret: await put(c, owner.id, f.year2025, 'Form 1120 2025.pdf', `proof:${TAG}:${label}:ret`, { period_year: 2025 }),
    ext: await put(c, owner.id, f.year2025, 'Extension 7004.pdf', `proof:${TAG}:${label}:ext`, { period_year: 2025 }),
  }
  return { name, label, accountId: acct.id, ownerId: owner.id, f, files }
}
const snapshot = async (c, ownerId) => ({
  folders: await q(c, `SELECT id, parent_id, kind, name, template_slug, trashed_at IS NOT NULL AS trashed FROM store_folders WHERE owner_id = $1 ORDER BY id`, [ownerId]),
  files: await q(c, `SELECT id, folder_id, name, state, current_version_id, caller_key, document_type, period_year, published, owner_id FROM store_files WHERE owner_id = $1 ORDER BY id`, [ownerId]),
})
/** Same walk as effectiveKind() in lib/crm-store/structure.ts: the nearest folder above a file that is not "custom". */
const effectiveKinds = (c, ownerId) => q(c, `
  WITH RECURSIVE up(file_id, kind, parent_id, depth) AS (
    SELECT f.id, fo.kind, fo.parent_id, 0 FROM store_files f JOIN store_folders fo ON fo.id = f.folder_id WHERE f.owner_id = $1
    UNION ALL
    SELECT up.file_id, p.kind, p.parent_id, up.depth + 1 FROM up JOIN store_folders p ON p.id = up.parent_id WHERE up.kind = 'custom' AND up.depth < 50)
  SELECT DISTINCT ON (file_id) file_id, kind FROM up WHERE kind <> 'custom' ORDER BY file_id, depth`, [ownerId])
const apply = (c, fx, change, oldName, newName, actor = null) =>
  call(c, `store_apply_name_change($1, $2, $3, $4, $5, false)`, [fx.ownerId, change, oldName, newName, actor])
const MOVED = ['company', 'tax', 'banking', 'correspondence']
const kids = (snap, parentId) => snap.folders.filter((x) => x.parent_id === parentId)

// ───────────────────────────────────────────────────────────── scenarios
async function main() {
  console.log(`Name-change proofs on the sandbox (tag ${TAG})\n`)

  await scenario('1. dry run: says what it would do, writes nothing (no event, no folder, no lock needed)', async (c) => {
    const fx = await seed(c, 'dry')
    const before = await snapshot(c, fx.ownerId)
    const ev = (await one(c, `SELECT count(*)::int AS n FROM store_events WHERE owner_id = $1`, [fx.ownerId])).n
    const r = await call(c, `store_apply_name_change($1, $2, $3, $4, NULL, true)`, [fx.ownerId, crypto.randomUUID(), fx.name, 'ZZ Proof New LLC'])
    assert(r.status === 'dry_run' && r.ok === true, JSON.stringify(r))
    eq(r.would_move, MOVED, 'would_move'); eq(r.old_root_name, fx.name, 'old root'); eq(r.new_root_name, 'ZZ Proof New LLC', 'new root'); assert(r.archive_root_exists === false, 'no archive yet')
    eq(await snapshot(c, fx.ownerId), before, 'nothing changed')
    eq((await one(c, `SELECT count(*)::int AS n FROM store_events WHERE owner_id = $1`, [fx.ownerId])).n, ev, 'no event written')
  })

  await scenario('2. apply: root renamed in place, 4 folders moved whole into Previous names › old name, fresh set made, contacts left, NO file row touched', async (c) => {
    const fx = await seed(c, 'apply')
    const before = await snapshot(c, fx.ownerId)
    const kindsBefore = await effectiveKinds(c, fx.ownerId)
    const change = crypto.randomUUID(); const NEW = `ZZ Proof Renamed ${TAG} LLC`
    const r = await apply(c, fx, change, fx.name, NEW)
    assert(r.status === 'applied', JSON.stringify(r))
    const after = await snapshot(c, fx.ownerId)
    eq(after.files, before.files, 'every file row is byte-identical (same folder_id, version, caller_key …)')
    const root = after.folders.find((x) => x.parent_id === null)
    assert(root.id === fx.f.root && root.name === NEW, `root kept its id and got the new name (${root.name})`)
    const prev = kids(after, root.id).find((x) => x.name === 'Previous names')
    assert(prev && prev.kind === 'custom' && prev.template_slug === 'name_change_archive' && !prev.trashed, 'Previous names exists and is LOCKED (has a template slug)')
    const child = kids(after, prev.id)
    assert(child.length === 1 && child[0].name === fx.name && child[0].template_slug === 'name_change_archive', 'one archive child named with the OLD name, locked')
    const inArchive = kids(after, child[0].id)
    eq(inArchive.map((x) => x.id).sort(), MOVED.map((k) => fx.f[k]).sort(), 'the four moved folders are the SAME ids')
    for (const x of inArchive) assert(x.template_slug === 'company_standard', 'moved folders keep their own (locked) template slug')
    assert(after.folders.find((x) => x.id === fx.f.year2025).parent_id === fx.f.tax, 'the 2025 tax-year folder is still inside the (moved) Tax folder')
    assert(after.folders.find((x) => x.id === fx.f.contacts).parent_id === root.id, '2. Contacts stayed under the top folder')
    const fresh = kids(after, root.id).filter((x) => MOVED.includes(x.kind))
    eq(fresh.map((x) => x.kind).sort(), [...MOVED].sort(), 'four fresh standard folders under the top folder')
    for (const x of fresh) { assert(!MOVED.some((k) => fx.f[k] === x.id), 'fresh ids are new'); assert(x.template_slug === 'company_standard', 'fresh are standard locked folders') }
    assert(after.folders.length === before.folders.length + 6, `folder count +6 (archive root, archive child, 4 fresh): ${before.folders.length} -> ${after.folders.length}`)
    eq((await effectiveKinds(c, fx.ownerId)), kindsBefore, 'every file keeps its category (effective kind) — portal Documents/category counts unchanged')
    const ev = await q(c, `SELECT details FROM store_events WHERE owner_id = $1 AND event = 'name_change_applied'`, [fx.ownerId])
    assert(ev.length === 1 && ev[0].details.change_id === change && ev[0].details.old_root_name === fx.name && ev[0].details.new_root_name === NEW, 'one applied marker with change_id + names')
    eq(Object.keys(ev[0].details.moved).sort(), [...MOVED].sort(), 'marker records moved ids'); eq(Object.keys(ev[0].details.created).sort(), [...MOVED].sort(), 'marker records created ids')
    assert((await one(c, `SELECT count(*)::int AS n FROM store_events WHERE owner_id = $1 AND event = 'folder_renamed'`, [fx.ownerId])).n === 1, 'the root rename was logged (store_rename_root)')
  })

  await scenario('3. re-run with the SAME change id: already_applied, nothing moves, no second archive', async (c) => {
    const fx = await seed(c, 'rerun'); const change = crypto.randomUUID()
    const r1 = await apply(c, fx, change, fx.name, 'ZZ Proof Two LLC'); assert(r1.status === 'applied', 'first apply')
    const mid = await snapshot(c, fx.ownerId)
    const r2 = await apply(c, fx, change, fx.name, 'ZZ Proof Two LLC')
    assert(r2.status === 'already_applied' && r2.change_id === change, JSON.stringify(r2))
    eq(await snapshot(c, fx.ownerId), mid, 'identical tree after the retry')
    // even with a new file saved into the fresh Tax folder in between
    const freshTax = r1.created.tax
    await put(c, fx.ownerId, freshTax, 'New Tax Letter.pdf', `proof:${TAG}:rerun:newtax`)
    const mid2 = await snapshot(c, fx.ownerId)
    const r3 = await apply(c, fx, change, fx.name, 'ZZ Proof Two LLC'); assert(r3.status === 'already_applied', 'third call')
    eq(await snapshot(c, fx.ownerId), mid2, 'the new file stays in the fresh Tax folder (not swept into an archive)')
    assert((await one(c, `SELECT count(*)::int AS n FROM store_events WHERE owner_id = $1 AND event = 'name_change_applied'`, [fx.ownerId])).n === 1, 'still one marker')
  })

  await scenario('4. A -> B -> C: one "Previous names", one child per old name, no collision, latest set is the live one', async (c) => {
    const fx = await seed(c, 'abc'); const A = fx.name, B = `ZZ Proof B ${TAG} LLC`, C = `ZZ Proof C ${TAG} LLC`
    const r1 = await apply(c, fx, crypto.randomUUID(), A, B); const r2 = await apply(c, fx, crypto.randomUUID(), B, C)
    assert(r1.status === 'applied' && r2.status === 'applied', 'both applied')
    const s = await snapshot(c, fx.ownerId)
    const prevs = kids(s, fx.f.root).filter((x) => x.name === 'Previous names'); assert(prevs.length === 1, 'exactly one Previous names')
    eq(kids(s, prevs[0].id).map((x) => x.name).sort(), [A, B].sort(), 'archive children = the two old names')
    const bChild = kids(s, prevs[0].id).find((x) => x.name === B)
    eq(kids(s, bChild.id).map((x) => x.id).sort(), Object.values(r1.created).sort(), 'the first change\'s fresh folders are what got archived under B')
    const live = kids(s, fx.f.root).filter((x) => MOVED.includes(x.kind)).map((x) => x.id).sort()
    eq(live, Object.values(r2.created).sort(), 'the live set is the second change\'s fresh set')
    assert(s.folders.find((x) => x.parent_id === null).name === C, 'root is C')
  })

  await scenario('5. A -> B -> A -> C: the second "A" archive is suffixed (A (2)) — no collision', async (c) => {
    const fx = await seed(c, 'aba'); const A = fx.name, B = `ZZ Proof B ${TAG} LLC`, C = `ZZ Proof C ${TAG} LLC`
    await apply(c, fx, crypto.randomUUID(), A, B); await apply(c, fx, crypto.randomUUID(), B, A); const r3 = await apply(c, fx, crypto.randomUUID(), A, C)
    assert(r3.status === 'applied', JSON.stringify(r3))
    const s = await snapshot(c, fx.ownerId); const prev = kids(s, fx.f.root).find((x) => x.name === 'Previous names')
    eq(kids(s, prev.id).map((x) => x.name).sort(), [A, `${A} (2)`, B].sort(), 'archive children A, B, A (2)')
  })

  await scenario('6. case-only / spacing-only / same name: REFUSED, nothing changes; dry run reports it', async (c) => {
    const fx = await seed(c, 'case'); const before = await snapshot(c, fx.ownerId)
    for (const bad of [fx.name.toUpperCase(), `  ${fx.name}  `, fx.name.replace(/ /g, '  '), fx.name]) {
      const msg = await refused(c, `SELECT store_apply_name_change($1, $2, $3, $4, NULL, false)`, [fx.ownerId, crypto.randomUUID(), fx.name, bad], /name change refused/)
      assert(/capital letters or spacing/.test(msg), msg)
    }
    eq(await snapshot(c, fx.ownerId), before, 'tree untouched after four refusals')
    const d = await call(c, `store_apply_name_change($1, $2, $3, $4, NULL, true)`, [fx.ownerId, crypto.randomUUID(), fx.name, fx.name.toUpperCase()])
    assert(d.status === 'dry_run' && d.ok === false && /capital letters/.test(d.problem), JSON.stringify(d))
    const w = await refused(c, `SELECT store_apply_name_change_for_account($1, $2, $3, $4, NULL, false)`, [fx.accountId, crypto.randomUUID(), fx.name.toUpperCase(), fx.name], /name change refused/)
    assert(!!w, 'wrapper refuses too')
  })

  await scenario('7. a bad name / a failure half-way changes NOTHING (whole move is one transaction)', async (c) => {
    const fx = await seed(c, 'bad'); const before = await snapshot(c, fx.ownerId)
    await refused(c, `SELECT store_apply_name_change($1, $2, $3, $4, NULL, false)`, [fx.ownerId, crypto.randomUUID(), fx.name, '   '], /needs the new name/)
    // force a failure AFTER the archive was made, the folders moved and the root renamed: the template step cannot find its template
    await c.query(`UPDATE catalog_entries SET status = 'deprecated' WHERE catalog_id = 'storage_folder_templates' AND slug = 'company_standard'`)
    await refused(c, `SELECT store_apply_name_change($1, $2, $3, $4, NULL, false)`, [fx.ownerId, crypto.randomUUID(), fx.name, 'ZZ Proof Half Way LLC'], /unknown or inactive folder template|template/)
    await c.query(`UPDATE catalog_entries SET status = 'active' WHERE catalog_id = 'storage_folder_templates' AND slug = 'company_standard'`)
    eq(await snapshot(c, fx.ownerId), before, 'root name, archive, moved folders: all exactly as before')
    assert((await one(c, `SELECT count(*)::int AS n FROM store_events WHERE owner_id = $1 AND event IN ('name_change_applied','folder_renamed')`, [fx.ownerId])).n === 0, 'no event written')
  })

  await scenario('8. a name with / \\ or control characters is made folder-safe (the folder-name CHECK would refuse it)', async (c) => {
    const fx = await seed(c, 'unsafe')
    const r = await apply(c, fx, crypto.randomUUID(), fx.name, 'A/B \\ C\tDeal  LLC')
    assert(r.status === 'applied' && r.new_root_name === 'A-B - C-Deal LLC', JSON.stringify(r))
    assert((await one(c, `SELECT name FROM store_folders WHERE id = $1`, [fx.f.root])).name === 'A-B - C-Deal LLC', 'root carries the safe name')
    assert((await call(c, `store_safe_folder_name($1)`, ['x'.repeat(300)])).length === 255, '255 characters at most')
    assert((await call(c, `store_safe_folder_name($1)`, ['    '])) === 'Company', 'never empty')
    assert((await call(c, `store_safe_folder_name($1)`, ['  \t '])) === '-', 'a tab is a control character: it becomes a dash (same as the code)')
  })

  await scenario('9. owners that must not move are SKIPPED (structured result, never an error): person, formation, business, study copy, no storage', async (c) => {
    for (const kind of ['person', 'formation', 'business', 'unfiled']) {
      const o = await one(c, `SELECT id FROM store_owners WHERE kind = $1 LIMIT 1`, [kind])
      if (!o) continue
      const before = (await one(c, `SELECT count(*)::int AS n FROM store_folders WHERE owner_id = $1`, [o.id])).n
      const r = await call(c, `store_apply_name_change($1, $2, 'x', 'ZZ New', NULL, false)`, [o.id, crypto.randomUUID()])
      assert(r.status === 'skipped' && r.reason === 'not_company', `${kind}: ${JSON.stringify(r)}`)
      assert((await one(c, `SELECT count(*)::int AS n FROM store_folders WHERE owner_id = $1`, [o.id])).n === before, `${kind}: untouched`)
    }
    const fx = await seed(c, 'study'); await c.query(`UPDATE store_owners SET study_only = true WHERE id = $1`, [fx.ownerId])
    const before = await snapshot(c, fx.ownerId)
    const r = await apply(c, fx, crypto.randomUUID(), fx.name, 'ZZ Study Renamed LLC'); assert(r.status === 'skipped' && r.reason === 'study_only', JSON.stringify(r))
    eq(await snapshot(c, fx.ownerId), before, 'study copy untouched')
    const none = await call(c, `store_apply_name_change('00000000-0000-0000-0000-0000000000aa', $1, 'x', 'ZZ New', NULL, false)`, [crypto.randomUUID()])
    assert(none.status === 'skipped' && none.reason === 'no_storage', JSON.stringify(none))
    // through the wrapper: the ACCOUNT still changes name (a company on Drive, or a study copy), the storage part reports "skipped"
    const w = await call(c, `store_apply_name_change_for_account($1, $2, 'ZZ Study Account New LLC', $3, NULL, false)`, [fx.accountId, crypto.randomUUID(), fx.name])
    assert(w.status === 'applied' && w.storage.status === 'skipped' && w.storage.reason === 'study_only', JSON.stringify(w))
    const a2 = await one(c, `INSERT INTO accounts (company_name, is_test) VALUES ($1, true) RETURNING id`, [`ZZ Drive Only ${TAG} LLC`])
    const w2 = await call(c, `store_apply_name_change_for_account($1, $2, 'ZZ Drive Only New LLC', $3, NULL, false)`, [a2.id, crypto.randomUUID(), `ZZ Drive Only ${TAG} LLC`])
    assert(w2.status === 'applied' && w2.storage.reason === 'no_storage', JSON.stringify(w2))
    const acct = await one(c, `SELECT company_name, previous_name, jsonb_array_length(name_history)::int AS n FROM accounts WHERE id = $1`, [a2.id])
    assert(acct.company_name === 'ZZ Drive Only New LLC' && acct.previous_name === `ZZ Drive Only ${TAG} LLC` && acct.n === 1, JSON.stringify(acct))
  })

  await scenario('10. unexpected shape is REFUSED: an extra folder under the top folder, a missing standard folder, an upload in progress', async (c) => {
    let fx = await seed(c, 'extra')
    await c.query(`INSERT INTO store_folders (owner_id, parent_id, kind, name) VALUES ($1, $2, 'custom', 'Loose stuff')`, [fx.ownerId, fx.f.root])
    let before = await snapshot(c, fx.ownerId)
    const m = await refused(c, `SELECT store_apply_name_change($1, $2, $3, 'ZZ Extra New LLC', NULL, false)`, [fx.ownerId, crypto.randomUUID(), fx.name], /unexpected folder/)
    assert(/Loose stuff/.test(m), m); eq(await snapshot(c, fx.ownerId), before, 'untouched')
    fx = await seed(c, 'missing')
    await c.query(`SELECT set_config('store.privileged', 'on', true)`); await c.query(`DELETE FROM store_folders WHERE id = $1`, [fx.f.banking]); await c.query(`SELECT set_config('store.privileged', 'off', true)`)
    before = await snapshot(c, fx.ownerId)
    await refused(c, `SELECT store_apply_name_change($1, $2, $3, 'ZZ Missing New LLC', NULL, false)`, [fx.ownerId, crypto.randomUUID(), fx.name], /expected exactly one "banking"/)
    eq(await snapshot(c, fx.ownerId), before, 'untouched')
    fx = await seed(c, 'upload')
    await c.query(`INSERT INTO store_upload_intents (owner_id, folder_id, created_by, file_name, staging_path, expires_at) VALUES ($1, $2, $3, 'x.pdf', $4, now() + interval '10 minutes')`, [fx.ownerId, fx.f.tax, crypto.randomUUID(), `proof/${TAG}/${crypto.randomUUID()}`])
    await refused(c, `SELECT store_apply_name_change($1, $2, $3, 'ZZ Upload New LLC', NULL, false)`, [fx.ownerId, crypto.randomUUID(), fx.name], /upload\(s\) to this storage are still in progress/)
    const d = await call(c, `store_apply_name_change($1, $2, $3, 'ZZ Upload New LLC', NULL, true)`, [fx.ownerId, crypto.randomUUID(), fx.name])
    assert(d.status === 'dry_run' && d.ok === false, JSON.stringify(d))
    // the company's Drive -> storage move still running (touched just now): refused; one left half-way long ago does not block
    fx = await seed(c, 'moving')
    await c.query(`INSERT INTO store_import_runs (account_id, owner_id, status, mode) VALUES ($1, $2, 'moving', 'move')`, [fx.accountId, fx.ownerId])
    await refused(c, `SELECT store_apply_name_change($1, $2, $3, 'ZZ Moving New LLC', NULL, false)`, [fx.ownerId, crypto.randomUUID(), fx.name], /still running/)
    await c.query(`UPDATE store_import_runs SET updated_at = now() - interval '2 hours' WHERE account_id = $1`, [fx.accountId])
    assert((await apply(c, fx, crypto.randomUUID(), fx.name, 'ZZ Moving New LLC')).status === 'applied', 'a half-finished old run does not block')
  })

  await scenario('11. the account wrapper: account + storage in ONE call — previous_name, append-only history, compare-and-set, retry, A->B->C', async (c) => {
    const fx = await seed(c, 'wrap'); const A = fx.name, B = `ZZ Proof B ${TAG} LLC`, C = `ZZ Proof C ${TAG} LLC`
    const c1 = crypto.randomUUID(), c2 = crypto.randomUUID()
    const stale = await call(c, `store_apply_name_change_for_account($1, $2, $3, 'Not the current name', NULL, false)`, [fx.accountId, c1, B])
    assert(stale.status === 'conflict' && stale.current_name === A, JSON.stringify(stale))
    assert((await one(c, `SELECT company_name FROM accounts WHERE id = $1`, [fx.accountId])).company_name === A, 'compare-and-set: nothing written')
    const r1 = await call(c, `store_apply_name_change_for_account($1, $2, $3, $4, NULL, false)`, [fx.accountId, c1, B, A])
    assert(r1.status === 'applied' && r1.storage.status === 'applied', JSON.stringify(r1))
    let a = await one(c, `SELECT company_name, previous_name, name_history FROM accounts WHERE id = $1`, [fx.accountId])
    assert(a.company_name === B && a.previous_name === A && a.name_history.length === 1 && a.name_history[0].type === 'change' && a.name_history[0].change_id === c1, JSON.stringify(a))
    assert((await one(c, `SELECT name FROM store_folders WHERE id = $1`, [fx.f.root])).name === B, 'storage root follows')
    const again = await call(c, `store_apply_name_change_for_account($1, $2, $3, $4, NULL, false)`, [fx.accountId, c1, B, A])
    assert(again.status === 'already_applied', 'retry of the same change id: ' + JSON.stringify(again))
    const r2 = await call(c, `store_apply_name_change_for_account($1, $2, $3, $4, NULL, false)`, [fx.accountId, c2, C, B]); assert(r2.status === 'applied', JSON.stringify(r2))
    a = await one(c, `SELECT company_name, previous_name, name_history FROM accounts WHERE id = $1`, [fx.accountId])
    assert(a.company_name === C && a.previous_name === B && a.name_history.length === 2 && a.name_history[1].previous_name_before === A, 'A->B->C: previous_name is B, history keeps both: ' + JSON.stringify(a.name_history.map((h) => [h.old_name, h.new_name])))
    // dry run through the wrapper writes nothing
    const dr = await call(c, `store_apply_name_change_for_account($1, $2, 'ZZ Dry LLC', $3, NULL, true)`, [fx.accountId, crypto.randomUUID(), C]); assert(dr.status === 'dry_run' && dr.storage.ok === true, JSON.stringify(dr))
    assert((await one(c, `SELECT jsonb_array_length(name_history)::int AS n FROM accounts WHERE id = $1`, [fx.accountId])).n === 2, 'dry run wrote no history')
    // the history is append-only: shrinking it, editing an entry, or emptying it is refused
    await refused(c, `UPDATE accounts SET name_history = '[]'::jsonb WHERE id = $1`, [fx.accountId], /append-only/)
    await refused(c, `UPDATE accounts SET name_history = jsonb_set(name_history, '{0,new_name}', '"Tampered"') WHERE id = $1`, [fx.accountId], /append-only/)
    await refused(c, `UPDATE accounts SET name_history = '{"a":1}'::jsonb WHERE id = $1`, [fx.accountId], /JSON array|check/)
    await c.query(`UPDATE accounts SET name_history = name_history || '[{"type":"note"}]'::jsonb WHERE id = $1`, [fx.accountId]) // appending is fine
  })

  await scenario('12. the wrapper is all-or-nothing: a refused storage move rolls the ACCOUNT back too', async (c) => {
    const fx = await seed(c, 'wrapfail')
    await c.query(`INSERT INTO store_folders (owner_id, parent_id, kind, name) VALUES ($1, $2, 'custom', 'Loose stuff')`, [fx.ownerId, fx.f.root])
    const before = await snapshot(c, fx.ownerId)
    await refused(c, `SELECT store_apply_name_change_for_account($1, $2, 'ZZ Wrap Fail New LLC', $3, NULL, false)`, [fx.accountId, crypto.randomUUID(), fx.name], /unexpected folder/)
    const a = await one(c, `SELECT company_name, previous_name, name_history FROM accounts WHERE id = $1`, [fx.accountId])
    assert(a.company_name === fx.name && a.previous_name === null && a.name_history.length === 0, 'account unchanged: ' + JSON.stringify(a))
    eq(await snapshot(c, fx.ownerId), before, 'storage unchanged')
  })

  await scenario('13. undo: back to EXACTLY the old tree (same ids, names, parents); twice = already_undone; account restored by the wrapper', async (c) => {
    const fx = await seed(c, 'undo'); const before = await snapshot(c, fx.ownerId); const kb = await effectiveKinds(c, fx.ownerId)
    const change = crypto.randomUUID()
    await apply(c, fx, change, fx.name, 'ZZ Proof Undo New LLC')
    const dr = await call(c, `store_undo_name_change($1, $2, NULL, true)`, [fx.ownerId, change]); assert(dr.status === 'dry_run' && dr.ok === true && dr.would_delete.length === 4, JSON.stringify(dr))
    const u = await call(c, `store_undo_name_change($1, $2, NULL, false)`, [fx.ownerId, change]); assert(u.status === 'undone', JSON.stringify(u))
    eq(await snapshot(c, fx.ownerId), before, 'the tree is exactly as before the change')
    eq(await effectiveKinds(c, fx.ownerId), kb, 'categories as before')
    const u2 = await call(c, `store_undo_name_change($1, $2, NULL, false)`, [fx.ownerId, change]); assert(u2.status === 'already_undone', JSON.stringify(u2))
    // through the wrapper
    const fy = await seed(c, 'undow'); const c1 = crypto.randomUUID(); const beforeY = await snapshot(c, fy.ownerId)
    await call(c, `store_apply_name_change_for_account($1, $2, 'ZZ Undo Wrap New LLC', $3, NULL, false)`, [fy.accountId, c1, fy.name])
    const uw = await call(c, `store_undo_name_change_for_account($1, $2, NULL, false)`, [fy.accountId, c1]); assert(uw.status === 'undone' && uw.storage.status === 'undone', JSON.stringify(uw))
    const a = await one(c, `SELECT company_name, previous_name, name_history FROM accounts WHERE id = $1`, [fy.accountId])
    assert(a.company_name === fy.name && a.previous_name === null && a.name_history.length === 2 && a.name_history[1].type === 'undo', 'account back to the old name, history keeps both entries: ' + JSON.stringify(a))
    eq(await snapshot(c, fy.ownerId), beforeY, 'storage exactly as before')
    assert((await call(c, `store_undo_name_change_for_account($1, $2, NULL, false)`, [fy.accountId, c1])).status === 'already_undone', 'wrapper: second undo is a no-op')
  })

  await scenario('14. undo is BOUNDED: refused when the new folders hold a file / a folder, when it is not the latest change; allowed after the later one is undone', async (c) => {
    const fx = await seed(c, 'bound'); const before = await snapshot(c, fx.ownerId)
    const c1 = crypto.randomUUID(), c2 = crypto.randomUUID(), B = `ZZ Proof B ${TAG} LLC`, C = `ZZ Proof C ${TAG} LLC`
    const r1 = await apply(c, fx, c1, fx.name, B)
    await put(c, fx.ownerId, r1.created.tax, 'New Tax Letter.pdf', `proof:${TAG}:bound:new`)
    await refused(c, `SELECT store_undo_name_change($1, $2, NULL, false)`, [fx.ownerId, c1], /already hold files or folders/)
    const d = await call(c, `store_undo_name_change($1, $2, NULL, true)`, [fx.ownerId, c1]); assert(d.status === 'dry_run' && d.ok === false, JSON.stringify(d))
    // a fresh folder with only a sub-folder also blocks
    const fy = await seed(c, 'bound2'); const r = await apply(c, fy, crypto.randomUUID(), fy.name, B + 'x')
    await c.query(`INSERT INTO store_folders (owner_id, parent_id, kind, name) VALUES ($1, $2, 'custom', 'Sub')`, [fy.ownerId, r.created.banking])
    await refused(c, `SELECT store_undo_name_change($1, $2, NULL, false)`, [fy.ownerId, r.change_id], /already hold files or folders/)
    // stack order
    const fz = await seed(c, 'bound3'); const b0 = await snapshot(c, fz.ownerId); const x1 = crypto.randomUUID(), x2 = crypto.randomUUID()
    await apply(c, fz, x1, fz.name, B + 'y'); await apply(c, fz, x2, B + 'y', C + 'y')
    await refused(c, `SELECT store_undo_name_change($1, $2, NULL, false)`, [fz.ownerId, x1], /only the latest name change can be undone/)
    await refused(c, `SELECT store_undo_name_change($1, $2, NULL, false)`, [fz.ownerId, crypto.randomUUID()], /only the latest name change can be undone/)
    assert((await call(c, `store_undo_name_change($1, $2, NULL, false)`, [fz.ownerId, x2])).status === 'undone', 'undo the latest')
    assert((await call(c, `store_undo_name_change($1, $2, NULL, false)`, [fz.ownerId, x1])).status === 'undone', 'now the earlier one')
    eq(await snapshot(c, fz.ownerId), b0, 'two undos restore the original tree exactly')
    await refused(c, `SELECT store_undo_name_change($1, $2, NULL, false)`, [fx.ownerId, crypto.randomUUID()], /only the latest name change can be undone/)
    void before
  })

  await scenario('15. undo, then apply again — with the SAME change id and with a new one', async (c) => {
    const fx = await seed(c, 'reapply'); const before = await snapshot(c, fx.ownerId); const c1 = crypto.randomUUID()
    const r1 = await apply(c, fx, c1, fx.name, 'ZZ Reapply New LLC'); await call(c, `store_undo_name_change($1, $2, NULL, false)`, [fx.ownerId, c1])
    eq(await snapshot(c, fx.ownerId), before, 'back to the start')
    const r2 = await apply(c, fx, c1, fx.name, 'ZZ Reapply New LLC'); assert(r2.status === 'applied', 'same change id applies again after an undo: ' + JSON.stringify(r2))
    assert(JSON.stringify(Object.values(r2.created).sort()) !== JSON.stringify(Object.values(r1.created).sort()), 'new fresh folders')
    assert((await apply(c, fx, c1, fx.name, 'ZZ Reapply New LLC')).status === 'already_applied', 'and idempotent again')
    const s = await snapshot(c, fx.ownerId); assert(kids(s, fx.f.root).filter((x) => x.name === 'Previous names').length === 1, 'one Previous names')
    assert(kids(s, kids(s, fx.f.root).find((x) => x.name === 'Previous names').id).length === 1, 'one archive child (the undone one was deleted)')
  })

  await scenario('16. the public web roles cannot call any of it (anon / authenticated denied, service role allowed)', async (c) => {
    const fx = await seed(c, 'roles'); const id = crypto.randomUUID()
    const calls = [
      [`SELECT store_apply_name_change($1, $2, 'a', 'b', NULL, true)`, [fx.ownerId, id]],
      [`SELECT store_undo_name_change($1, $2, NULL, true)`, [fx.ownerId, id]],
      [`SELECT store_apply_name_change_for_account($1, $2, 'b', 'a', NULL, true)`, [fx.accountId, id]],
      [`SELECT store_undo_name_change_for_account($1, $2, NULL, true)`, [fx.accountId, id]],
      [`SELECT store_safe_folder_name('x')`, []],
    ]
    for (const role of ['anon', 'authenticated']) for (const [sql, params] of calls) {
      await c.query('SAVEPOINT sp_role'); await c.query(`SET LOCAL ROLE ${role}`)
      let denied = false
      try { await c.query(sql, params) } catch (e) { denied = /permission denied/i.test(e.message) }
      await c.query('ROLLBACK TO SAVEPOINT sp_role'); await c.query('RELEASE SAVEPOINT sp_role')
      assert(denied, `${role} was not denied: ${sql}`)
    }
    for (const [sql, params] of calls) {   // the connecting (service-level) role is allowed: any answer or business error is fine, a PERMISSION error is not
      await c.query('SAVEPOINT sp_ok')
      try { await c.query(sql, params) } catch (e) { assert(!/permission denied/i.test(e.message), `service-level role denied: ${sql}`) }
      await c.query('ROLLBACK TO SAVEPOINT sp_ok'); await c.query('RELEASE SAVEPOINT sp_ok')
    }
  })

  await scenario('17. a re-save of an OLD caller key after the move: the writer ignores the folder it is given and versions the archived file; a new key lands in the fresh folder', async (c) => {
    const fx = await seed(c, 'ckey'); const r = await apply(c, fx, crypto.randomUUID(), fx.name, 'ZZ Ckey New LLC')
    const old = await call(c, `store_write($1::jsonb)`, [JSON.stringify({ owner_id: fx.ownerId, folder_id: r.created.company, name: 'Operating Agreement.pdf', sha256: sha(), bucket: 'crm-store', path: `proof/${TAG}/${crypto.randomUUID()}`, size: 11, mime: 'application/pdf', caller_key: `proof:${TAG}:ckey:oa` })])
    assert(old.status === 'versioned' && old.file_id === fx.files.oa, 'same file, new version: ' + JSON.stringify(old))
    assert((await one(c, `SELECT folder_id FROM store_files WHERE id = $1`, [fx.files.oa])).folder_id === fx.f.company, 'it stays in the ARCHIVED Company folder (callers that need the new structure must use a new caller key)')
    const fresh = await call(c, `store_write($1::jsonb)`, [JSON.stringify({ owner_id: fx.ownerId, folder_id: r.created.company, name: 'Operating Agreement v2.pdf', sha256: sha(), bucket: 'crm-store', path: `proof/${TAG}/${crypto.randomUUID()}`, size: 12, mime: 'application/pdf', caller_key: `proof:${TAG}:ckey:oa2` })])
    assert(fresh.status === 'created' && (await one(c, `SELECT folder_id FROM store_files WHERE id = $1`, [fresh.file_id])).folder_id === r.created.company, 'a new key is filed in the fresh Company folder')
  })

  await scenario('18. other store functions after the move: store_apply_template is a no-op, the CRM pointers store:<file id> still resolve, nothing in documents is touched', async (c) => {
    const fx = await seed(c, 'other'); const doc = await one(c, `SELECT count(*)::int AS n, md5(string_agg(id::text, ',' ORDER BY id)) AS h FROM documents WHERE drive_file_id LIKE 'store:%'`)
    await apply(c, fx, crypto.randomUUID(), fx.name, 'ZZ Other New LLC')
    const n0 = (await one(c, `SELECT count(*)::int AS n FROM store_folders WHERE owner_id = $1`, [fx.ownerId])).n
    await c.query(`SELECT store_apply_template($1, 'company_standard', 'whatever', NULL)`, [fx.ownerId])
    assert((await one(c, `SELECT count(*)::int AS n FROM store_folders WHERE owner_id = $1`, [fx.ownerId])).n === n0, 'the template adds nothing (and does not rename the root)')
    assert((await one(c, `SELECT name FROM store_folders WHERE id = $1`, [fx.f.root])).name === 'ZZ Other New LLC', 'root name kept')
    for (const id of Object.values(fx.files)) assert((await one(c, `SELECT count(*)::int AS n FROM store_files WHERE id = $1 AND state = 'live'`, [id])).n === 1, 'file ' + id + ' is still there with its id')
    const doc2 = await one(c, `SELECT count(*)::int AS n, md5(string_agg(id::text, ',' ORDER BY id)) AS h FROM documents WHERE drive_file_id LIKE 'store:%'`)
    eq(doc2, doc, 'documents rows with store pointers: identical')
  })

  // ───────────────────────────────────────────────────────── concurrency (two live connections, COMMITS a ZZ test company)
  {
    const name = 'two concurrent applies of the SAME change id: the second waits for the first, then answers already_applied (exactly one archive, one marker)'
    const c0 = await connect(); const a = await connect(); const b = await connect()
    try {
      await c0.query('BEGIN'); const fx = await seed(c0, 'conc'); await c0.query('COMMIT')
      const change = crypto.randomUUID(); const NEW = `ZZ Proof Concurrent New ${TAG} LLC`
      await a.query('BEGIN')
      const ra = await call(a, `store_apply_name_change($1, $2, $3, $4, NULL, false)`, [fx.ownerId, change, fx.name, NEW])   // holds the owner lock
      let bDone = false
      const pb = call(b, `store_apply_name_change($1, $2, $3, $4, NULL, false)`, [fx.ownerId, change, fx.name, NEW]).then((x) => { bDone = true; return x })
      await new Promise((r) => setTimeout(r, 1500))
      assert(ra.status === 'applied', 'A applied'); assert(!bDone, 'B is waiting on A\'s lock, not racing it')
      await a.query('COMMIT')
      const rb = await pb
      assert(rb.status === 'already_applied', 'B: ' + JSON.stringify(rb))
      const s = await snapshot(b, fx.ownerId)
      assert(kids(s, fx.f.root).filter((x) => x.name === 'Previous names').length === 1, 'one archive')
      assert(kids(s, kids(s, kids(s, fx.f.root).find((x) => x.name === 'Previous names').id)[0].id).length === 4, 'exactly one set of four archived folders (not swept twice)')
      assert((await one(b, `SELECT count(*)::int AS n FROM store_events WHERE owner_id = $1 AND event = 'name_change_applied'`, [fx.ownerId])).n === 1, 'one marker')
      // two DIFFERENT changes racing on the same company through the wrapper: one applies, the other sees a changed name -> conflict
      await c0.query('BEGIN'); const fy = await seed(c0, 'conc2'); await c0.query('COMMIT')
      const ca = crypto.randomUUID(), cb = crypto.randomUUID()
      await a.query('BEGIN')
      const wa = await call(a, `store_apply_name_change_for_account($1, $2, 'ZZ Race Winner LLC', $3, NULL, false)`, [fy.accountId, ca, fy.name])
      const pw = call(b, `store_apply_name_change_for_account($1, $2, 'ZZ Race Loser LLC', $3, NULL, false)`, [fy.accountId, cb, fy.name])
      await new Promise((r) => setTimeout(r, 1000)); await a.query('COMMIT')
      const wb = await pw
      assert(wa.status === 'applied' && wb.status === 'conflict' && wb.current_name === 'ZZ Race Winner LLC', JSON.stringify([wa.status, wb]))
      results.push({ name, ok: true })
    } catch (e) { try { await a.query('ROLLBACK') } catch {}; results.push({ name, ok: false, err: e.message }) }
    finally { await c0.end(); await a.end(); await b.end() }
  }

  // ───────────────────────────────────────────────────────── report
  console.log('')
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '\n      ' + r.err}`)
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} scenarios passed`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
