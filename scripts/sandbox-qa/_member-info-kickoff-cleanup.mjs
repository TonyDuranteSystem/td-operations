import { config } from "dotenv"
config({ path: ".env.local" })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("xjcxlmlpeywtwkhstjlw")) {
  console.error("NOT SANDBOX — abort")
  process.exit(1)
}

// Removes the QA fixtures created by _member-info-kickoff-seed.mjs and the
// live E2E run against them (dev job ef529eaf / PR #497). Matches by the
// "QA E2E" contact-name prefix used by that seed script, so it also sweeps
// any partial fixture left behind by an earlier failed seed attempt.

const { supabaseAdmin } = await import("../../lib/supabase-admin")

const { data: contacts } = await supabaseAdmin
  .from("contacts")
  .select("id")
  .ilike("first_name", "QA E2E")
if (!contacts?.length) {
  console.log("Nothing to clean up.")
  process.exit(0)
}
const contactIds = contacts.map(c => c.id)

const { data: sds } = await supabaseAdmin
  .from("service_deliveries")
  .select("id, account_id")
  .in("contact_id", contactIds)
const accountIds = sds?.map(s => s.account_id).filter(Boolean) ?? []

for (const table of ["portal_messages", "member_info_requests"]) {
  if (accountIds.length) await supabaseAdmin.from(table).delete().in("account_id", accountIds)
}
if (accountIds.length) {
  await supabaseAdmin.from("account_contacts").delete().in("account_id", accountIds)
  await supabaseAdmin.from("members").delete().in("account_id", accountIds)
}
await supabaseAdmin.from("service_deliveries").delete().in("contact_id", contactIds)
await supabaseAdmin.from("wizard_progress").delete().in("contact_id", contactIds)
if (accountIds.length) await supabaseAdmin.from("accounts").delete().in("id", accountIds)
await supabaseAdmin.from("contacts").delete().in("id", contactIds)

console.log(`Cleaned up ${contactIds.length} contact(s), ${accountIds.length} account(s).`)
