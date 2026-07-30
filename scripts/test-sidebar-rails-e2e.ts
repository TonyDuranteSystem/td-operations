/* eslint-disable no-console -- dev-only QA driver, never shipped to runtime */
/**
 * End-to-end for the client send rails, against a REAL database.
 *
 * This exercises the ACTUAL function the sidebar calls — not a copy. Copying the query
 * into a test driver is precisely how the original bug hid: the earlier behaviour driver
 * reproduced the broken lookup and therefore agreed with it.
 *
 *   npx tsx scripts/test-sidebar-rails-e2e.ts
 */
import { config } from "dotenv"
config({ path: ".env.local" })
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
  console.error(`✋ Local stack only. Saw: ${url}`); process.exit(1)
}
import { buildSidebarSendRails } from "@/lib/ai-agent/sidebar-send-rails"
import { supabaseAdmin } from "@/lib/supabase-admin"
const db = supabaseAdmin as any
let failures = 0
const check = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) failures++ }

async function main() {
  const { data: link } = await db.from("account_contacts").select("account_id, contact_id").limit(1).maybeSingle()
  if (!link) { console.error("✋ no account_contacts rows locally"); process.exit(1) }
  const { data: acct } = await db.from("accounts").select("company_name").eq("id", link.account_id).maybeSingle()
  const { data: linkedContacts } = await db.from("account_contacts").select("contact_id").eq("account_id", link.account_id)
  const expectedIds = (linkedContacts ?? []).map((l: any) => l.contact_id)
  const { data: contacts } = await db.from("contacts").select("id, email").in("id", expectedIds)
  const expectedEmails = (contacts ?? []).map((c: any) => c.email).filter((e: any) => e && e.includes("@"))

  console.log(`Client on screen: ${acct?.company_name} (${expectedIds.length} people linked)\n`)

  // ── The account case — the one that was completely broken ──
  const rails = await buildSidebarSendRails(`account:${link.account_id}`)
  check("email sending is ENABLED for this client", rails.email.enableEmailSend === true)
  // The client's own addresses are the CONFIRM-EXEMPT set (2026-07-29): they send
  // straight out; any OTHER address is still reachable but freezes for a one-click
  // staff confirmation. So this asserts the client's addresses are all present —
  // NOT that they are the only reachable ones.
  check(
    "the client's real addresses are confirm-exempt",
    expectedEmails.every((e: string) => (rails.email.emailConfirmExempt ?? []).includes(e)) && expectedEmails.length > 0,
    `exempt=${(rails.email.emailConfirmExempt ?? []).length}, client addresses=${expectedEmails.length}`,
  )
  check(
    "our own mailboxes are exempt too, so 'forward this to Antonio' needs no confirm",
    (rails.email.emailConfirmExempt ?? []).some((a: string) => a.endsWith("@tonydurante.us")),
  )
  check(
    "the sending mailbox is forced to support@ (this surface cannot authorise antonio@)",
    rails.email.forceMailbox === "support",
  )
  // Email is ON whenever the rail is on — it no longer depends on the client
  // having an address on file, because staff can name any recipient.
  const canSendEmail = rails.email.enableEmailSend === true
  check("so the worker will be TOLD it can email", canSendEmail)

  check("the client boundary now includes the account's own people", 
    expectedIds.every((id: string) => rails.clientScope?.allowedIds.includes(id)),
    `allowed=${rails.clientScope?.allowedIds.length}`)
  check("the account itself is still in the boundary", Boolean(rails.clientScope?.allowedIds.includes(link.account_id)))
  check("the client is named for the worker", Boolean(rails.clientName), String(rails.clientName))
  check("portal sending is pinned to this account", (rails.portal as any)?.pinnedPortalRecipient?.account_id === link.account_id)

  // ── A DIFFERENT client's person must NOT be inside this boundary ──
  const { data: other } = await db.from("contacts").select("id").not("id", "in", `(${expectedIds.join(",")})`).limit(1).maybeSingle()
  if (other?.id) {
    check("a different client's person is NOT in the boundary", !rails.clientScope?.allowedIds.includes(other.id))
  }

  // ── The contact case still works ──
  const cRails = await buildSidebarSendRails(`contact:${expectedIds[0]}`)
  check("a person-pinned page still resolves that person", Boolean(cRails.clientScope?.allowedIds.includes(expectedIds[0])))

  // ── Off a client page: no rails at all ──
  const none = await buildSidebarSendRails(null)
  check("off a client page, sending stays OFF", none.email.enableEmailSend !== true && none.clientScope === null)

  // ── A junk key must not open anything ──
  const junk = await buildSidebarSendRails("account:00000000-0000-4000-8000-000000000000")
  check("an unknown client opens no rails", junk.email.enableEmailSend !== true && junk.clientScope === null)
}
main().then(() => {
  console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(e => { console.error("💥", e); process.exit(1) })
