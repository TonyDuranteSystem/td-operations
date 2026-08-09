/**
 * PAYER LEARNING — lifecycle proof against the real sandbox database.
 *
 * Pins the soft-delete / re-teach edge cases the architect required (dev jobs ae8b8bb1 /
 * c0a61e44). These cannot be unit-tested honestly: the whole question is whether a PARTIAL
 * unique index lets a re-teach past a tombstoned row, and only a real Postgres answers that.
 *
 *   (a) a removed mapping never matches a lookup
 *   (b) re-teaching the same payer→client pair AFTER removal succeeds rather than colliding
 *       with the invisible tombstone  ← the one that bites in production
 *   (c) removal then re-teach leaves EXACTLY ONE live mapping
 *   (d) removal never touches transaction history
 *   plus: idempotent re-click, and the rail guard re-applied at LOOKUP for a mapping taught
 *   before the rail was listed.
 *
 * Creates its own throwaway fixtures and deletes them at the end.
 */
import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("xjcxlmlpeywtwkhstjlw")) {
  console.error("REFUSING: this script writes rows and must only ever run against sandbox.")
  process.exit(1)
}

const { supabaseAdmin } = await import("@/lib/supabase-admin")
const {
  teachPayerClient,
  removePayerMapping,
  listMappingsForKey,
  lookupTaughtClientsForFeed,
  listSameOwnerCompanies,
} = await import("@/lib/finance/payer-learning")
const { isClientInvoicePayment } = await import("@/lib/finance/owner-ledger-projection")
const { buildTaughtPayerIndex } = await import("@/lib/finance/payer-learning-rules")
const { resolvePayerKey } = await import("@/lib/finance/payer-learning-rules")

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
const db = supabaseAdmin as any

let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const FIXTURE_EMAIL = `payer-learning-qa-${Date.now()}@example.invalid`
const FEED = {
  id: "fixture-feed",
  source: "airwallex_api",
  sender_name: "Fixture Payer Alpha Bravo",
  status: "unmatched" as string | null,
  raw_data: {},
}
const KEY = resolvePayerKey(FEED)!

// ── fixtures ────────────────────────────────────────────────────────────────
const { data: contact, error: cErr } = await db
  .from("contacts")
  .insert({ full_name: "Payer Learning QA Fixture", email: FIXTURE_EMAIL, status: "active" })
  .select("id")
  .single()
if (cErr || !contact) {
  console.error("Could not create the fixture contact:", cErr?.message)
  process.exit(1)
}
const contactId = contact.id as string
console.log(`fixture contact ${contactId}\n`)

const cleanup = async () => {
  await db.from("payer_client_map").delete().eq("contact_id", contactId)
  await db.from("payer_client_map").delete().eq("key_value", "wise us inc")
  await db.from("contacts").delete().eq("id", contactId)
}

try {
  // ── teach ─────────────────────────────────────────────────────────────────
  const first = await teachPayerClient({
    feed: FEED,
    subject: { contactId },
    taughtBy: "qa:lifecycle",
    taughtVia: "sandbox lifecycle proof",
  })
  check("teach succeeds", first.ok && first.created === true, first.detail ?? "")

  const second = await teachPayerClient({ feed: FEED, subject: { contactId }, taughtBy: "qa:lifecycle" })
  check("a second identical click is idempotent (no duplicate row)", second.ok && second.created === false)
  check(
    "exactly one live mapping after two clicks",
    (await listMappingsForKey(FEED.source, KEY)).length === 1,
  )

  const beforeRemoval = await lookupTaughtClientsForFeed(FEED)
  check("lookup finds the taught client", beforeRemoval.mappings.length === 1)

  // ── (d) removal must not touch transaction history ────────────────────────
  const { data: feedsBefore } = await db
    .from("td_bank_feeds")
    .select("id, updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
  const historyBefore = JSON.stringify(feedsBefore ?? [])

  // ── (a) removed mapping never matches ─────────────────────────────────────
  const removal = await removePayerMapping(first.mappingId!, "qa:lifecycle")
  check("removal reports success", removal.ok && removal.removed)

  const afterRemoval = await lookupTaughtClientsForFeed(FEED)
  check("(a) a removed mapping NEVER matches a lookup", afterRemoval.mappings.length === 0)
  check("(a) and it is gone from the live list too", (await listMappingsForKey(FEED.source, KEY)).length === 0)

  const secondRemoval = await removePayerMapping(first.mappingId!, "qa:lifecycle")
  check("removing twice is safe and reports nothing removed", secondRemoval.ok && !secondRemoval.removed)

  const { data: feedsAfter } = await db
    .from("td_bank_feeds")
    .select("id, updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
  check("(d) removal left transaction history untouched", JSON.stringify(feedsAfter ?? []) === historyBefore)

  // ── (b) + (c) THE ONE THAT BITES: re-teach past the invisible tombstone ───
  const reTeach = await teachPayerClient({
    feed: FEED,
    subject: { contactId },
    taughtBy: "qa:lifecycle",
    taughtVia: "correction after removal",
  })
  check(
    "(b) re-teaching after removal SUCCEEDS (no collision with the tombstone)",
    reTeach.ok && reTeach.created === true,
    reTeach.detail ?? "",
  )
  const live = await listMappingsForKey(FEED.source, KEY)
  check("(c) exactly ONE live mapping after remove-then-reteach", live.length === 1, `found ${live.length}`)
  check("(c) and it is the NEW row, not the revived tombstone", live[0]?.id !== first.mappingId)

  const { count: totalRows } = await db
    .from("payer_client_map")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
  check("the tombstone is preserved for audit (2 rows total, 1 live)", totalRows === 2, `rows=${totalRows}`)

  // ── the rail guard, re-applied at LOOKUP ──────────────────────────────────
  // Simulates a mapping taught BEFORE its payer was recognised as a payment rail: inserted
  // directly, because the teach path would (correctly) refuse it today.
  const railFeed = { ...FEED, sender_name: "WISE US INC" }
  const railKey = resolvePayerKey(railFeed)!
  await db.from("payer_client_map").insert({
    source: railFeed.source,
    key_type: railKey.key_type,
    key_value: railKey.key_value,
    display_payer: railKey.display_payer,
    contact_id: contactId,
    taught_by: "qa:lifecycle-legacy",
    updated_at: new Date().toISOString(),
  })
  const railLookup = await lookupTaughtClientsForFeed(railFeed)
  check(
    "a mapping on a payment rail is IGNORED at lookup even though the row is live",
    railLookup.mappings.length === 0 && railLookup.suppressedAsProcessor === true,
  )
  check(
    "...and the suppression is reported, not swallowed",
    railLookup.suppressedAsProcessor === true,
  )

  const railTeach = await teachPayerClient({ feed: railFeed, subject: { contactId }, taughtBy: "qa:lifecycle" })
  check("teaching a payment rail is refused with an explanation", !railTeach.ok && railTeach.refusal === "processor_only")

  // ── the ROUTER honours a real taught row (not a hand-built index) ─────────
  // Before: nothing identifies this payer, so it would be filed as the owner's money.
  check(
    "router files an unrecognised payer as owner money BEFORE teaching",
    isClientInvoicePayment(FEED as never, []) === false,
  )
  const liveMappings = await listMappingsForKey(FEED.source, KEY)
  const liveIndex = buildTaughtPayerIndex(liveMappings as never)
  check(
    "router keeps it in Finance once a REAL taught row exists",
    isClientInvoicePayment(FEED as never, [], { taught: liveIndex }) === true,
    `mappings=${liveMappings.length}`,
  )

  // ── same-owner extension, against real account_contacts rows ──────────────
  const { data: acctA } = await db
    .from("accounts")
    .insert({ company_name: "Payer QA Alpha LLC", account_type: "Client", status: "Active" })
    .select("id").single()
  const { data: acctB } = await db
    .from("accounts")
    .insert({ company_name: "Payer QA Beta LLC", account_type: "Client", status: "Active" })
    .select("id").single()
  const { data: acctDead } = await db
    .from("accounts")
    .insert({ company_name: "Payer QA Closed LLC", account_type: "Client", status: "Cancelled" })
    .select("id").single()
  // Deliberately MIXED CASE roles — the ADWise incident class.
  await db.from("account_contacts").insert([
    { account_id: acctA.id, contact_id: contactId, role: "Owner" },
    { account_id: acctB.id, contact_id: contactId, role: "owner" },
    { account_id: acctDead.id, contact_id: contactId, role: "Sole Member" },
  ])

  const siblings = await listSameOwnerCompanies({ accountId: acctA.id, source: FEED.source, key: KEY })
  check(
    "same-owner extension finds the owner's OTHER live company across mixed-case roles",
    siblings.length === 1 && siblings[0].companyName === "Payer QA Beta LLC",
    `found ${siblings.map((s) => s.companyName).join(", ") || "none"}`,
  )
  check("...and excludes the company it was asked about", !siblings.some((s) => s.accountId === acctA.id))
  check("...and excludes a cancelled company", !siblings.some((s) => s.companyName.includes("Closed")))

  await teachPayerClient({ feed: FEED, subject: { accountId: acctB.id }, taughtBy: "qa:lifecycle" })
  const siblings2 = await listSameOwnerCompanies({ accountId: acctA.id, source: FEED.source, key: KEY })
  check("an already-taught company is marked as done rather than offered again", siblings2[0]?.alreadyTaught === true)

  // ── AN INDIVIDUAL CLIENT (a contacts row with NO company at all) ─────────
  // First-class in this system, not an edge case: 34 clients pay with no company — standalone
  // tax returns, ITINs and paid strategy calls. Wen-Ting's paid call and Domenico before his
  // formation are both this shape, so if any of this assumed a company id the path would be
  // broken for exactly the clients paid calls create.
  const soloFeed = { ...FEED, sender_name: "Solo Individual Payer Fixture" }
  const soloKey = resolvePayerKey(soloFeed)!
  const soloTeach = await teachPayerClient({ feed: soloFeed, subject: { contactId }, taughtBy: "qa:lifecycle" })
  check("an INDIVIDUAL client (no company) can be taught", soloTeach.ok && soloTeach.created === true, soloTeach.detail ?? "")
  const soloLookup = await lookupTaughtClientsForFeed(soloFeed)
  check(
    "...and the lookup returns them, keyed to the person and not a company",
    soloLookup.mappings.length === 1 && soloLookup.mappings[0].contact_id === contactId && soloLookup.mappings[0].account_id === null,
  )
  check(
    "...and the router keeps their payment in Finance",
    isClientInvoicePayment(soloFeed as never, [], { taught: buildTaughtPayerIndex(soloLookup.mappings as never) }) === true,
  )
  const soloSiblings = await listSameOwnerCompanies({ accountId: "", source: soloFeed.source, key: soloKey }).catch(() => "THREW")
  check(
    "same-owner extension is a NO-OP for an individual, not an error",
    Array.isArray(soloSiblings) && soloSiblings.length === 0,
    soloSiblings === "THREW" ? "it threw" : `returned ${Array.isArray(soloSiblings) ? soloSiblings.length : "?"}`,
  )

  await db.from("payer_client_map").delete().in("account_id", [acctA.id, acctB.id, acctDead.id])
  await db.from("account_contacts").delete().in("account_id", [acctA.id, acctB.id, acctDead.id])
  await db.from("accounts").delete().in("id", [acctA.id, acctB.id, acctDead.id])
} finally {
  await cleanup()
  const { count: leftover } = await db
    .from("payer_client_map")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
  check("fixtures cleaned up", (leftover ?? 0) === 0, `leftover=${leftover}`)
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
