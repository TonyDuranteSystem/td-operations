/* eslint-disable no-console */
/* sandbox only: gives a QA new-client contact a portal login and prints the cookie-setting JS */
import { config } from "dotenv"
import { createClient } from "@supabase/supabase-js"
config({ path: ".env.local" })
async function main() {
  const email = process.argv[2]; const contactId = process.argv[3]
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } })
  const password = `Qa-${Date.now()}-x!`
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const existing = (users?.users as Array<{ id: string; email?: string }> | undefined)?.find((u) => u.email === email)
  if (existing) await admin.auth.admin.updateUserById(existing.id, { password, app_metadata: { role: "client", contact_id: contactId }, email_confirm: true })
  else { const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: "client", contact_id: contactId } }); if (error) throw error }
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`login: ${error?.message}`)
  const ref = new URL(url).hostname.split(".")[0]
  const value = "base64-" + Buffer.from(JSON.stringify(data.session)).toString("base64url")
  const CHUNK = 3180; const parts: string[] = []
  if (value.length <= CHUNK) parts.push(`sb-${ref}-auth-token=${value}`)
  else for (let i = 0, n = 0; i < value.length; i += CHUNK, n++) parts.push(`sb-${ref}-auth-token.${n}=${value.slice(i, i + CHUNK)}`)
  console.log(parts.map((p) => `document.cookie=${JSON.stringify(p + "; path=/; SameSite=Lax")};`).join("\n"))
}
main().catch((e) => { console.error(e); process.exit(1) })
