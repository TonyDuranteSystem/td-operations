#!/usr/bin/env node
/*
 * copy-storage.cjs — copy Supabase Storage buckets + FILE BYTES from the cloud SANDBOX
 * into a LOCAL stack. The DB clone (refresh-clone.sh) brings storage METADATA rows via the
 * normal schema copy, but the actual file bytes live in object storage, not Postgres — this
 * fills that gap so document/preview QA works in an isolated env.
 *
 * Env: SRC_URL, SRC_KEY (sandbox), DST_URL, DST_KEY (local). Refuses prod source / non-local dest.
 * Best-effort + non-fatal by design: env-up treats failure as a warning, never a blocker.
 * Run standalone:  SRC_URL=… SRC_KEY=… DST_URL=… DST_KEY=… node scripts/copy-storage.cjs
 */
const PROD_REF = 'ydzipybqeebtpcvsbtvs'
for (const k of ['SRC_URL', 'SRC_KEY', 'DST_URL', 'DST_KEY']) {
  if (!process.env[k]) { console.error('missing env ' + k); process.exit(2) }
}
if (process.env.SRC_URL.includes(PROD_REF)) { console.error('⛔ SRC is PRODUCTION — refusing'); process.exit(2) }
if (!/127\.0\.0\.1|localhost/.test(process.env.DST_URL)) { console.error('⛔ DST is not local — refusing'); process.exit(2) }

let createClient
try { ({ createClient } = require('@supabase/supabase-js')) }
catch (e) { console.error('⚠️  @supabase/supabase-js not resolvable here — storage copy SKIPPED (' + e.message + ')'); process.exit(3) }

const opts = { auth: { persistSession: false } }
const src = createClient(process.env.SRC_URL, process.env.SRC_KEY, opts)
const dst = createClient(process.env.DST_URL, process.env.DST_KEY, opts)

// Recursively list every object path in a bucket (folders have id === null).
async function listAll(client, bucket, prefix = '') {
  const out = []
  const page = 100
  let offset = 0
  for (;;) {
    const { data, error } = await client.storage.from(bucket).list(prefix, { limit: page, offset })
    if (error) throw error
    if (!data || data.length === 0) break
    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name
      if (item.id) out.push(path)               // a file
      else out.push(...await listAll(client, bucket, path)) // a folder → recurse
    }
    if (data.length < page) break
    offset += page
  }
  return out
}

;(async () => {
  const { data: buckets, error } = await src.storage.listBuckets()
  if (error) throw error
  let files = 0, bytes = 0
  for (const b of buckets) {
    await dst.storage.createBucket(b.id, { public: b.public }).catch(() => {}) // idempotent
    const paths = await listAll(src, b.id)
    let n = 0
    for (const p of paths) {
      const { data: blob, error: dlErr } = await src.storage.from(b.id).download(p)
      if (dlErr) { console.error(`   ! download ${b.id}/${p}: ${dlErr.message}`); continue }
      const buf = Buffer.from(await blob.arrayBuffer())
      const { error: upErr } = await dst.storage.from(b.id)
        .upload(p, buf, { upsert: true, contentType: blob.type || 'application/octet-stream' })
      if (upErr) { console.error(`   ! upload ${b.id}/${p}: ${upErr.message}`); continue }
      n++; files++; bytes += buf.length
    }
    console.log(`   ✓ ${b.id}: ${n}/${paths.length} files`)
  }
  console.log(`✅ storage copy: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`)
})().catch((e) => { console.error('storage copy error: ' + e.message); process.exit(1) })
