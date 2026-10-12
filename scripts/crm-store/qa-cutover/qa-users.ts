/* eslint-disable no-console -- a QA script prints its results */
/**
 * Phase 3 sandbox QA (dev job ad09ea91): creates three throw-away SANDBOX logins with generated passwords — a staff admin,
 * a client of Uxio Test LLC (switched) and a client of Test Company LLC (still on Drive). Passwords are written to a
 * private scratch file (mode 600), never printed. Refuses to run against production.
 * Run: npx tsx scripts/crm-store/qa-cutover/qa-users.ts
 */
import { config } from "dotenv"
import { randomBytes } from "crypto"
import { writeFileSync, chmodSync, existsSync, readFileSync } from "fs"
config({ path: ".env.local" })

export const CREDS_FILE = "/private/tmp/claude-501/scratch/qa-creds.json"
const UXIO_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"
const TC_CONTACT = "963ee27f-7531-4fe4-9a4d-60a4fc6c36cc"

const USERS = [
  { key: "staff", email: "qa-cutover-staff@sandbox.tonydurante.us", app_metadata: { role: "admin", mfa_exempt: true } },
  { key: "clientUx", email: "qa-cutover-client-ux@sandbox.td", app_metadata: { role: "client", contact_id: UXIO_CONTACT, portal_tier: "active" } },
  { key: "clientTc", email: "qa-cutover-client-tc@sandbox.td", app_metadata: { role: "client", contact_id: TC_CONTACT, portal_tier: "active" } },
] as const

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const creds: Record<string, { email: string; password: string }> = existsSync(CREDS_FILE) ? JSON.parse(readFileSync(CREDS_FILE, "utf8")) : {}
  for (const u of USERS) {
    const password = creds[u.key]?.password ?? randomBytes(18).toString("base64url")
    // find an existing user (paginated: the sandbox has far more than one page of users)
    let existing: { id: string } | null = null
    for (let page = 1; page <= 20 && !existing; page++) {
      const { data } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 })
      existing = data.users.find((x) => x.email === u.email) ?? null
      if (data.users.length < 200) break
    }
    if (existing) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(existing.id, { password, app_metadata: u.app_metadata, email_confirm: true })
      if (error) throw error
    } else {
      const { error } = await supabaseAdmin.auth.admin.createUser({ email: u.email, password, email_confirm: true, app_metadata: u.app_metadata })
      if (error) throw error
    }
    creds[u.key] = { email: u.email, password }
    console.log(`${u.key}: ready (${u.email})`)
  }
  writeFileSync(CREDS_FILE, JSON.stringify(creds))
  chmodSync(CREDS_FILE, 0o600)
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1) })
