/* eslint-disable no-console -- CLI QA harness reports its results via stdout. */
/* eslint-disable no-restricted-syntax -- fixture seeding writes raw rows on purpose, mirroring
   the real state materializeFormationCompany expects to find (a signed formation offer, its
   Company Formation SD, a submitted formation wizard) — routing this through lib/operations
   would be circular for a test of lib/operations itself. */
/**
 * SANDBOX QA — formation installment/setup-fee auto-fill, end to end against a real database.
 *
 * Proves the fix for dev job 69917d53 (Luca's "Annual Installments" report): new formation
 * companies never got installment_1/2_amount + setup_fee_amount filled in automatically.
 * Also proves the two blockers the council review found on the first proposed fix:
 *   - Senior Engineer: a contact with TWO concurrent in-flight formations must not get one
 *     company's SD/offer cross-linked (and its dollar amounts) onto the other's account.
 *   - Bug Hunter: a stale/superseded pre-signing offer revision must not be the one selected.
 *
 * Scenarios:
 *   A. HAPPY PATH — one contact, one signed formation offer with clean recurring_costs.
 *      Expect: materializing the company fills installment_1/2_amount + setup_fee_amount
 *      exactly matching the offer, with the right currency.
 *   B. TWO CONCURRENT FORMATIONS, SAME CONTACT — a second, unrelated, still-unmaterialized
 *      formation (different offer, different price, different SD) exists for the SAME
 *      contact when company A materializes. Expect: company A gets ONLY its own offer's
 *      amounts; company B's SD keeps account_id NULL (not hijacked); company B's offer
 *      keeps account_id NULL (not cross-linked).
 *   C. SUPERSEDED OFFER — a contact whose formation SD carries no source_offer_token (the
 *      legacy fallback path), with an old superseded offer AND the final signed offer both
 *      sitting with account_id NULL. Expect: the SUPERSEDED offer's (wrong, pre-negotiation)
 *      price is never picked — only the signed offer's price lands on the account.
 *
 * Run:  npx tsx scripts/qa-formation-installment-fill.ts
 * Safe: refuses to run against production; cleans up every row it creates (even on failure).
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const PROD_REF = "ydzipybqeebtpcvsbtvs"
if (!SUPABASE_URL || SUPABASE_URL.includes(PROD_REF)) {
  console.error("REFUSING TO RUN: this points at production (or no URL is set).")
  process.exit(1)
}
console.log(`DB: ${SUPABASE_URL}\n`)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = createClient(SUPABASE_URL, SERVICE_KEY) as any

const TAG = `qatest-${Date.now()}`
const createdIds: { table: string; id: string }[] = []
const track = (table: string, id: string) => { createdIds.push({ table, id }); return id }

let failures = 0
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  OK   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`)
  }
}

async function makeContact(fullName: string) {
  const { data, error } = await db.from("contacts").insert({
    full_name: fullName,
    email: `${TAG}-${fullName.replace(/\s+/g, "").toLowerCase()}@example.test`,
    status: "active",
    is_test: true,
  }).select("id").single()
  if (error) throw new Error(`contacts insert: ${error.message}`)
  return track("contacts", data.id)
}

async function makeOffer(opts: {
  token: string
  contactId?: string
  leadId?: string | null
  status: string
  recurringCosts: unknown[]
  costSummary: unknown[]
  formationState?: string
}) {
  const { data, error } = await db.from("offers").insert({
    token: opts.token,
    client_name: TAG,
    language: "en",
    offer_date: new Date().toISOString().slice(0, 10),
    contract_type: "formation",
    status: opts.status,
    contact_id: opts.contactId ?? null,
    lead_id: opts.leadId ?? null,
    recurring_costs: opts.recurringCosts,
    cost_summary: opts.costSummary,
    formation_state: opts.formationState ?? "NM",
    account_id: null,
  }).select("id, token").single()
  if (error) throw new Error(`offers insert: ${error.message}`)
  track("offers", data.id)
  return data.token as string
}

async function makeSd(opts: { contactId: string; sourceOfferToken: string | null; serviceName: string }) {
  const { data, error } = await db.from("service_deliveries").insert({
    contact_id: opts.contactId,
    account_id: null,
    service_type: "Company Formation",
    service_name: opts.serviceName,
    status: "active",
    source_offer_token: opts.sourceOfferToken,
  }).select("id").single()
  if (error) throw new Error(`service_deliveries insert: ${error.message}`)
  return track("service_deliveries", data.id)
}

async function makeWizardProgress(opts: { contactId: string; leadId: string | null; chosenName: string }) {
  const { data, error } = await db.from("wizard_progress").insert({
    contact_id: opts.contactId,
    lead_id: opts.leadId,
    wizard_type: "formation",
    status: "submitted",
    data: { chosen_name_final: opts.chosenName, entity_type: "SMLLC" },
  }).select("id").single()
  if (error) throw new Error(`wizard_progress insert: ${error.message}`)
  return track("wizard_progress", data.id)
}

async function makeLead(fullName: string) {
  const { data, error } = await db.from("leads").insert({
    full_name: fullName,
    status: "Converted",
    is_test: true,
  }).select("id").single()
  if (error) throw new Error(`leads insert: ${error.message}`)
  return track("leads", data.id)
}

async function getAccount(id: string) {
  const { data, error } = await db.from("accounts").select(
    "id, company_name, installment_1_amount, installment_1_currency, installment_2_amount, installment_2_currency, setup_fee_amount, setup_fee_currency"
  ).eq("id", id).single()
  if (error) throw new Error(`accounts read: ${error.message}`)
  return data
}

async function cleanup() {
  // Reverse-insert order: accounts materialized during the run aren't tracked by id up
  // front, so sweep by is_test + our tag on company_name/notes as a second pass.
  const { data: accts } = await db.from("accounts").select("id").ilike("company_name", `%${TAG}%`)
  for (const a of accts ?? []) {
    await db.from("account_contacts").delete().eq("account_id", a.id)
    await db.from("service_deliveries").delete().eq("account_id", a.id)
    await db.from("offers").update({ account_id: null }).eq("account_id", a.id)
    await db.from("accounts").delete().eq("id", a.id)
  }
  for (const { table, id } of [...createdIds].reverse()) {
    await db.from(table).delete().eq("id", id)
  }
  console.log(`\nCleanup: removed ${createdIds.length} fixture rows + ${accts?.length ?? 0} materialized account(s).`)
}

async function main() {
  const { materializeFormationCompany } = await import("../lib/operations/formation-materialize")

  // ── Scenario A: happy path ────────────────────────────────────────────────
  console.log("Scenario A — happy path, one signed formation offer")
  {
    const contactId = await makeContact(`${TAG} Alpha`)
    const leadId = await makeLead(`${TAG} Alpha`)
    const token = await makeOffer({
      token: `${TAG}-alpha`,
      contactId,
      leadId,
      status: "signed",
      recurringCosts: [
        { label: "1st Installment (January)", price: "$1,250", currency: "USD" },
        { label: "2nd Installment (June)", price: "$1,250", currency: "USD" },
        { label: "Annual Total", price: "$2,500", currency: "USD" },
      ],
      costSummary: [{ label: "Setup Fee", total: "$3,000" }],
    })
    await makeSd({ contactId, sourceOfferToken: token, serviceName: `Company Formation - ${TAG} Alpha LLC` })
    await makeWizardProgress({ contactId, leadId, chosenName: `${TAG} Alpha LLC` })

    const result = await materializeFormationCompany({ contact_id: contactId, actor: "sandbox-qa" })
    check("materialization succeeded", result.success === true, JSON.stringify(result))
    if (result.success && result.account_id) {
      const acct = await getAccount(result.account_id)
      check("installment_1_amount = 1250 USD", acct.installment_1_amount === 1250 && acct.installment_1_currency === "USD", JSON.stringify(acct))
      check("installment_2_amount = 1250 USD", acct.installment_2_amount === 1250 && acct.installment_2_currency === "USD", JSON.stringify(acct))
      check("setup_fee_amount = 3000 USD", acct.setup_fee_amount === 3000 && acct.setup_fee_currency === "USD", JSON.stringify(acct))
      const sdLinkStep = result.steps.find(s => s.step === "sd_link")
      const finStep = result.steps.find(s => s.step === "formation_financial_fill")
      check("sd_link step reported ok", sdLinkStep?.status === "ok", JSON.stringify(sdLinkStep))
      check("formation_financial_fill step reported ok", finStep?.status === "ok", JSON.stringify(finStep))
    }
  }

  // ── Scenario B: two concurrent formations for the same contact ────────────
  console.log("\nScenario B — two concurrent in-flight formations, same contact (the council-flagged blocker)")
  {
    const contactId = await makeContact(`${TAG} Beta`)
    const leadA = await makeLead(`${TAG} Beta CoA`)
    const leadB = await makeLead(`${TAG} Beta CoB`)
    const tokenA = await makeOffer({
      token: `${TAG}-beta-a`, contactId, leadId: leadA, status: "signed",
      recurringCosts: [
        { label: "1st Installment (January)", price: "$500", currency: "USD" },
        { label: "2nd Installment (June)", price: "$500", currency: "USD" },
      ],
      costSummary: [{ label: "Setup Fee", total: "$1,500" }],
    })
    const tokenB = await makeOffer({
      token: `${TAG}-beta-b`, contactId, leadId: leadB, status: "signed",
      recurringCosts: [
        { label: "1st Installment (January)", price: "$800", currency: "USD" },
        { label: "2nd Installment (June)", price: "$800", currency: "USD" },
      ],
      costSummary: [{ label: "Setup Fee", total: "$2,400" }],
    })
    await makeSd({ contactId, sourceOfferToken: tokenA, serviceName: `Company Formation - ${TAG} Beta CoA LLC` })
    const sdBId = await makeSd({ contactId, sourceOfferToken: tokenB, serviceName: `Company Formation - ${TAG} Beta CoB LLC` })
    // Only Company A's wizard has been submitted/is being materialized right now —
    // Company B is still earlier in its own pipeline, its SD legitimately still active+unlinked.
    await makeWizardProgress({ contactId, leadId: leadA, chosenName: `${TAG} Beta CoA LLC` })

    const result = await materializeFormationCompany({ contact_id: contactId, actor: "sandbox-qa" })
    check("materialization of Company A succeeded", result.success === true, JSON.stringify(result))
    if (result.success && result.account_id) {
      const acctA = await getAccount(result.account_id)
      check("Company A got ITS OWN price ($500), not Company B's ($800)", acctA.installment_1_amount === 500, JSON.stringify(acctA))
      check("Company A account name is CoA", (acctA.company_name || "").includes("CoA"))
    }
    const { data: sdB } = await db.from("service_deliveries").select("account_id").eq("id", sdBId).single()
    check("Company B's SD was NOT hijacked (account_id still null)", sdB?.account_id === null, JSON.stringify(sdB))
    const { data: offerB } = await db.from("offers").select("account_id").eq("token", tokenB).single()
    check("Company B's OFFER was NOT cross-linked (account_id still null)", offerB?.account_id === null, JSON.stringify(offerB))
  }

  // ── Scenario C: stale/superseded offer must not be selected ───────────────
  console.log("\nScenario C — SD with no source_offer_token; a superseded pre-negotiation offer must lose to the signed one")
  {
    const contactId = await makeContact(`${TAG} Gamma`)
    const leadId = await makeLead(`${TAG} Gamma`)
    // Old, pre-negotiation offer — superseded, wrong price, created first.
    await makeOffer({
      token: `${TAG}-gamma-v1`, contactId, leadId, status: "superseded",
      recurringCosts: [
        { label: "1st Installment (January)", price: "$400", currency: "USD" },
        { label: "2nd Installment (June)", price: "$400", currency: "USD" },
      ],
      costSummary: [{ label: "Setup Fee", total: "$1,200" }],
    })
    // Final, signed offer — the real price, created after.
    const tokenFinal = await makeOffer({
      token: `${TAG}-gamma-v2`, contactId, leadId, status: "signed",
      recurringCosts: [
        { label: "1st Installment (January)", price: "$1,000", currency: "USD" },
        { label: "2nd Installment (June)", price: "$1,000", currency: "USD" },
      ],
      costSummary: [{ label: "Setup Fee", total: "$2,000" }],
    })
    // SD with NO source_offer_token — forces the legacy lead-fallback path.
    await makeSd({ contactId, sourceOfferToken: null, serviceName: `Company Formation - ${TAG} Gamma LLC` })
    await makeWizardProgress({ contactId, leadId, chosenName: `${TAG} Gamma LLC` })

    const result = await materializeFormationCompany({ contact_id: contactId, actor: "sandbox-qa" })
    check("materialization succeeded", result.success === true, JSON.stringify(result))
    if (result.success && result.account_id) {
      const acct = await getAccount(result.account_id)
      check("picked the SIGNED offer's price ($1,000), not the superseded $400", acct.installment_1_amount === 1000, JSON.stringify(acct))
    }
    const { data: offerFinal } = await db.from("offers").select("account_id").eq("token", tokenFinal).single()
    check("the signed offer got linked to the account", !!offerFinal?.account_id)
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  await cleanup()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error("SCRIPT ERROR:", e)
  await cleanup().catch(() => {})
  process.exit(1)
})
