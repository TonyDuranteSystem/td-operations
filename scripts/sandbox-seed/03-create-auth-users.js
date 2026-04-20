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

async function findAuthUserByEmail(email) {
  // Supabase Admin API — filter users by email
  const res = await fetch(`${SB_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    headers: headers(),
  })
  if (!res.ok) return null
  const body = await res.json()
  const users = body.users || []
  return users.find(u => u.email?.toLowerCase() === email.toLowerCase()) || null
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

  let created = 0
  let skipped = 0
  let errors = 0

  for (const c of contacts) {
    try {
      const existing = await findAuthUserByEmail(c.email)
      if (existing) {
        skipped++
        console.log(`  SKIP ${c.email} (already exists: ${existing.id.slice(0, 8)})`)
        continue
      }
      const user = await createAuthUser(c.email, c.full_name || 'Test User', c.id)
      created++
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
