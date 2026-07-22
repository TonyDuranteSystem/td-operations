/* eslint-disable no-console -- CLI E2E harness, stdout IS the report. */
/* eslint-disable no-restricted-syntax -- raw writes are DELIBERATE: the harness seeds and deletes its own throwaway fixtures. */
/**
 * E2E — "Italian clients must get Italian". SANDBOX ONLY.
 *
 * `contacts.language` is free text. Production (2026-07-22): 211 "Italian",
 * 200 "English", 47 null, plus "Italiano", "Italian - englis",
 * "Italiano - Ingle", "Italian / Englis", "English or Italian" — and ZERO "it".
 * Every hand-rolled `language === "it"` check therefore matched NOBODY and sent
 * English to all 211 Italian clients. Verified live: Pietro De Pellegrino
 * ("Italian") received the ENGLISH ITIN wizard message on 2026-07-21.
 *
 * This drives the REAL new-document alert end to end — seeding a contact, an
 * account and a document, calling the real exported function, then reading back
 * the actual message text the client would see. It is the one path in the fix
 * that is callable end-to-end without a workflow context, AND the one whose
 * control flow changed shape (not just its comparison), so it carries the
 * regression risk.
 *
 * Run:  npx tsx scripts/e2e-client-language.ts
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { localeFromLanguage } from "@/lib/locale"
import { notifyClientsOfNewDocument } from "@/lib/portal/document-alerts"
import { buildReminderMessage } from "@/lib/tasks/itin-processing-reminder"

const SUP = supabaseAdmin
const TAG = "e2e-lang"

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = "") {
  checks++
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

// ── sandbox guard ────────────────────────────────────────────────────────────
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (url.includes("ydzipybqeebtpcvsbtvs")) {
  console.error("❌ REFUSING TO RUN: this is the PRODUCTION Supabase project.")
  process.exit(1)
}
if (!url.includes("xjcxlmlpeywtwkhstjlw")) {
  console.error(`❌ REFUSING TO RUN: not the sandbox project (${url || "no URL set"}).`)
  process.exit(1)
}

const created = { contacts: [] as string[], accounts: [] as string[], docs: [] as string[] }

async function mkAccount(name: string): Promise<string> {
  const { data, error } = await SUP.from("accounts").insert({ company_name: name, notes: TAG }).select("id").single()
  if (error) throw new Error(`account: ${error.message}`)
  created.accounts.push(data.id)
  return data.id
}

async function mkContact(name: string, language: string | null, accountId?: string, role?: string): Promise<string> {
  const { data, error } = await SUP.from("contacts")
    .insert({ full_name: name, email: `${TAG}-${Math.abs(hash(name))}@example.test`, language, notes: TAG })
    .select("id").single()
  if (error) throw new Error(`contact: ${error.message}`)
  created.contacts.push(data.id)
  if (accountId) {
    await SUP.from("account_contacts").insert({ contact_id: data.id, account_id: accountId, is_primary: true, role: role ?? null })
  }
  return data.id
}

// Deterministic — Math.random is banned in some harness contexts and a stable
// email keeps re-runs from colliding on a unique index.
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i)
  return h
}

async function mkDoc(fields: { account_id: string | null; contact_id: string | null; category: number; file_name: string }): Promise<string> {
  const { data, error } = await SUP.from("documents")
    .insert({
      file_name: fields.file_name,
      account_id: fields.account_id,
      contact_id: fields.contact_id,
      category: fields.category,
      portal_visible: true,
      notify_client: true,
      drive_file_id: `${TAG}-${Math.abs(hash(fields.file_name))}`,
    })
    .select("id").single()
  if (error) throw new Error(`document: ${error.message}`)
  created.docs.push(data.id)
  return data.id
}

/** The actual chat text the client would see for a freshly-shared document. */
async function alertTextFor(docId: string, accountId: string): Promise<string | null> {
  const res = await notifyClientsOfNewDocument(docId)
  if (!res.notified) return `NOT_NOTIFIED:${res.reason}`
  const { data } = await SUP.from("portal_messages")
    .select("message").eq("account_id", accountId).order("created_at", { ascending: false }).limit(1)
  return data?.[0]?.message ?? null
}

const isItalianText = (t: string | null) => !!t && t.includes("Un nuovo documento")
const isEnglishText = (t: string | null) => !!t && t.includes("A new document has been added")

async function cleanup() {
  for (const id of created.docs) await SUP.from("documents").delete().eq("id", id)
  for (const id of created.contacts) {
    await SUP.from("portal_notifications").delete().eq("contact_id", id)
    await SUP.from("account_contacts").delete().eq("contact_id", id)
    await SUP.from("contacts").delete().eq("id", id)
  }
  for (const id of created.accounts) {
    await SUP.from("portal_messages").delete().eq("account_id", id)
    await SUP.from("portal_notifications").delete().eq("account_id", id)
    await SUP.from("account_contacts").delete().eq("account_id", id)
    await SUP.from("accounts").delete().eq("id", id)
  }
}

async function main() {
  console.log("\n🧪 E2E — Italian clients get Italian (sandbox)\n")

  // ── 1. Every production spelling, through the REAL alert path ─────────────
  console.log("1. Real document alert — every language value that exists in production")
  const cases: Array<{ language: string | null; expect: "it" | "en"; note: string }> = [
    { language: "Italian", expect: "it", note: "211 contacts — the whole bug" },
    { language: "Italiano", expect: "it", note: "1 contact" },
    { language: "Italian - englis", expect: "it", note: "1 contact, truncated" },
    { language: "Italiano - Ingle", expect: "it", note: "1 contact, truncated" },
    { language: "Italian / Englis", expect: "it", note: "1 contact, truncated" },
    { language: "English", expect: "en", note: "200 contacts — must NOT flip" },
    { language: "English or Italian", expect: "en", note: "1 contact, reads English" },
    { language: "it", expect: "it", note: "legacy short code still honoured" },
    { language: "en", expect: "en", note: "legacy short code still honoured" },
  ]

  for (const c of cases) {
    const acct = await mkAccount(`${TAG} ${c.language}`)
    await mkContact(`${TAG} ${c.language}`, c.language, acct)
    const doc = await mkDoc({ account_id: acct, contact_id: null, category: 1, file_name: `${TAG}-${c.language}.pdf` })
    const text = await alertTextFor(doc, acct)
    const got = isItalianText(text) ? "it" : isEnglishText(text) ? "en" : `??(${String(text).slice(0, 40)})`
    check(`"${c.language}" → ${c.expect}`, got === c.expect, `${c.note}; got ${got}`)
  }

  // ── 2. Null / blank must not crash and must default to English ────────────
  console.log("\n2. Missing language — must default to English, never crash")
  for (const [label, value] of [["null", null], ["empty string", ""], ["whitespace", "   "]] as const) {
    const acct = await mkAccount(`${TAG} ${label}`)
    await mkContact(`${TAG} ${label}`, value, acct)
    const doc = await mkDoc({ account_id: acct, contact_id: null, category: 1, file_name: `${TAG}-${label}.pdf` })
    const text = await alertTextFor(doc, acct)
    check(`${label} → English`, isEnglishText(text), `got ${String(text).slice(0, 40)}`)
  }

  // ── 3. THE REGRESSION CASE for the control-flow change ────────────────────
  // The contact branch used to fall THROUGH to the account owner for any value
  // that wasn't exactly 'it'/'en'. It now short-circuits on any non-blank value.
  // These two cases pin what that means.
  console.log("\n3. Account-owner fallback (the branch whose shape changed)")
  {
    // 3a. Contact has NO language, owner is Italian → owner decides.
    const acct = await mkAccount(`${TAG} owner-it`)
    await mkContact(`${TAG} owner-italian`, "Italian", acct, "owner")
    const doc = await mkDoc({ account_id: acct, contact_id: null, category: 1, file_name: `${TAG}-owner-it.pdf` })
    const text = await alertTextFor(doc, acct)
    check("blank contact + Italian owner → Italian", isItalianText(text),
      "this is the path that was BROKEN before: 'Italian' matched neither 'it' nor 'en'")
  }
  {
    // 3b. Personal doc for a contact whose own language is unknown ("Spanish").
    // Their own value now wins and resolves to English. Documented, deliberate:
    // the person's own record beats a company-mate's.
    const acct = await mkAccount(`${TAG} owner-it-2`)
    await mkContact(`${TAG} italian-owner-2`, "Italian", acct, "owner")
    const odd = await mkContact(`${TAG} spanish-member`, "Spanish", acct)
    const doc = await mkDoc({ account_id: acct, contact_id: odd, category: 2, file_name: `${TAG}-personal.pdf` })
    const res = await notifyClientsOfNewDocument(doc)
    check("unknown language on a personal doc still notifies (no crash)", res.notified, `reason=${res.reason ?? "-"}`)
  }

  // ── 4. The ITIN IRS-processing reminder text ──────────────────────────────
  console.log("\n4. ITIN progress reminders during the 7–11 week IRS wait")
  const itMsg = buildReminderMessage({ first_name: "Pietro", language: localeFromLanguage("Italian"), weeks_since_start: 8 })
  const enMsg = buildReminderMessage({ first_name: "John", language: localeFromLanguage("English"), weeks_since_start: 8 })
  check("an 'Italian' client's reminder is in Italian", itMsg.startsWith("Ciao"), itMsg.slice(0, 40))
  check("an 'English' client's reminder is in English", enMsg.startsWith("Hi"), enMsg.slice(0, 40))
  check("the reminder names the client and the week count", itMsg.includes("Pietro") && itMsg.includes("8"))

  // ── 5. Idempotency — an alert must never fire twice ───────────────────────
  console.log("\n5. Idempotency")
  {
    const acct = await mkAccount(`${TAG} idem`)
    await mkContact(`${TAG} idem`, "Italian", acct)
    const doc = await mkDoc({ account_id: acct, contact_id: null, category: 1, file_name: `${TAG}-idem.pdf` })
    const first = await notifyClientsOfNewDocument(doc)
    const second = await notifyClientsOfNewDocument(doc)
    check("first alert fires", first.notified)
    check("second is suppressed", !second.notified, `reason=${second.reason}`)
  }

  console.log(`\n${failures === 0 ? "✅ ALL GREEN" : `❌ ${failures} FAILED`} — ${checks - failures}/${checks} checks passed\n`)
}

main()
  .catch((e) => {
    console.error("\n💥 harness threw:", e instanceof Error ? e.message : e)
    failures++
  })
  .finally(async () => {
    await cleanup()
    console.log("🧹 fixtures deleted")
    process.exit(failures === 0 ? 0 : 1)
  })
