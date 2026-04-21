#!/usr/bin/env node
/**
 * Sandbox seed step 3 — create Supabase Auth users for test contacts
 *
 * For each contact in the sandbox `contacts` table, creates a Supabase Auth
 * user (via Admin Auth API) so Antonio can log in as that client in the
 * sandbox portal.
 *
 * Password: uniform "TDsandbox-2026!" for every test user (sandbox-only,
 * no security implications).
 *
 * user_metadata.contact_id is set so `getClientContactId(user)` in the app
 * resolves the portal view correctly.
 *
 * Idempotent: if a user with the same email exists, skip.
 */

const fs = require('fs')
const path = require('path')

const sbEnv = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const SB_URL = sbEnv.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)[1]
const SB_KEY = sbEnv.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)[1]

const SANDBOX_PASSWORD = 'TDsandbox-2026!'

function headers(extra = {}) {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function listContactsWithEmail() {
  const res = await fetch(`${SB_URL}/rest/v1/contacts?select=id,full_name,email,language,phone&email=not.is.null`, {
    headers: headers(),
  })
  if (!res.ok) throw new Error(`read contacts: ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * Pre-load every auth user once, keyed by lowercase email.
 *
 * Why: Supabase's `/auth/v1/admin/users?email=X` endpoint IGNORES the `email`
 * query parameter and returns the first page (default 50 users). The previous
 * idempotency check (one call per contact, trusting the filter) silently
 * failed for any user not in the first page of results, producing spurious
 * 422 "email_exists" errors during re-runs.
 *
 * This loader paginates through every page (per_page=200) once up-front, so
 * the main loop is an O(1) Map lookup.
 */
async function loadAllAuthUsersByEmail() {
  const byEmail = new Map()
  const perPage = 200
  let page = 1
  for (;;) {
    const res = await fetch(`${SB_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: headers(),
    })
    if (!res.ok) throw new Error(`list users page ${page}: ${res.status} ${await res.text()}`)
    const body = await res.json()
    const users = body.users || []
    for (const u of users) {
      if (u.email) byEmail.set(u.email.toLowerCase(), u)
    }
    if (users.length < perPage) break
    page++
  }
  return byEmail
}

async function createAuthUser(email, fullName, contactId) {
  const res = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      email,
      password: SANDBOX_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        contact_id: contactId,
        portal_language: 'en',
      },
      app_metadata: {
        contact_id: contactId,
        portal_tier: 'active',
        role: 'client', // REQUIRED by /portal/login page check — without it login returns "This account does not have portal access"
      },
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`create auth user ${email}: ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json()
}

async function main() {
  console.log('SANDBOX:', SB_URL)
  console.log('Password for all test users:', SANDBOX_PASSWORD)
  console.log('')

  const contacts = await listContactsWithEmail()
  console.log(`Found ${contacts.length} contacts with emails`)

  const existingByEmail = await loadAllAuthUsersByEmail()
  console.log(`Pre-loaded ${existingByEmail.size} existing auth users`)

  let created = 0
  let skipped = 0
  let errors = 0

  for (const c of contacts) {
    try {
      const existing = existingByEmail.get(c.email.toLowerCase())
      if (existing) {
        skipped++
        console.log(`  SKIP ${c.email} (already exists: ${existing.id.slice(0, 8)})`)
        continue
      }
      const user = await createAuthUser(c.email, c.full_name || 'Test User', c.id)
      created++
      // Track locally so a duplicate contact email later in the list doesn't
      // try to re-create and fail.
      if (user?.id) existingByEmail.set(c.email.toLowerCase(), user)
      console.log(`  OK   ${c.email} (user: ${user.id?.slice(0, 8) || '?'}, contact: ${c.id.slice(0, 8)})`)
    } catch (e) {
      errors++
      console.log(`  ERR  ${c.email}: ${e.message}`)
    }
  }

  console.log(`\nSummary: ${created} created, ${skipped} skipped (existed), ${errors} errors`)
  console.log(`Log in to sandbox portal at: https://td-operations-sandbox.vercel.app/portal/login`)
  console.log(`Or: https://td-operations-git-sandbox-tony-durantes-projects.vercel.app/portal/login`)
}

main().catch(e => { console.error(e); process.exit(1) })
