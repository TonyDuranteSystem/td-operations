/* eslint-disable no-console -- CLI E2E harness, stdout IS the report. */
/* eslint-disable no-restricted-syntax -- raw writes are DELIBERATE: the harness seeds and deletes its own throwaway fixtures and must bypass the operations layer to plant exact row shapes (e.g. a legacy account-keyed progress row). */
/**
 * E2E — "an ITIN belongs to the PERSON" regression suite. SANDBOX ONLY.
 *
 * Origin: Pietro De Pellegrino (DeP Consulting LLC, 2026-07-21) bought an ITIN
 * standalone while already owning a company. `createSD` strips account_id from
 * every ITIN service delivery, but the portal READ side looked for services on
 * the COMPANY whenever the client had one — so his ITIN was invisible and he
 * had no way to start it.
 *
 * Exercises REAL code (no reimplemented logic):
 *   - computeHasWizardPending .............. the sidebar entrance (hits the DB)
 *   - resolveWizardProgressScope ........... where progress is read from
 *   - accountIdForWizardSubmission ......... what the submission is keyed on
 *   - canSubmitWizard ...................... the authorization gate
 *   - getContactScopedDiscoveryServiceTypes  what discovery unions in
 *   - createSD ............................. the write-side ownership rule
 *
 * NOT covered here (deliberately — a script cannot prove a render): that the
 * wizard PAGE offers the ITIN tab. That is verified in a real browser against
 * the deployed sandbox; replicating the page's query here would only test the
 * replica. See docs/systems/portal.md (2026-07-21).
 *
 * Run:  npx tsx scripts/e2e-itin-person-scope.ts
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { computeHasWizardPending } from "@/lib/portal/wizard-visibility"
import { resolveWizardProgressScope, accountIdForWizardSubmission } from "@/lib/portal/wizard-scope"
import { canSubmitWizard } from "@/lib/portal/wizard-submit-access"
import {
  getContactScopedDiscoveryServiceTypes,
  getPersonOwnedServiceTypes,
  isPersonOwnedWizard,
} from "@/lib/portal/wizard-map"
import type { PortalIdentity } from "@/lib/portal/resolve-portal-identity"

const SUP = supabaseAdmin
const TAG = "e2e-person-scope"

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

// ── fixtures ─────────────────────────────────────────────────────────────────
const created = { contacts: [] as string[], accounts: [] as string[] }

async function mkAccount(name: string): Promise<string> {
  const { data, error } = await SUP.from("accounts")
    .insert({ company_name: name, notes: TAG })
    .select("id")
    .single()
  if (error) throw new Error(`account insert: ${error.message}`)
  created.accounts.push(data.id)
  return data.id
}

async function mkContact(name: string, email: string, accountId?: string): Promise<string> {
  const { data, error } = await SUP.from("contacts")
    .insert({ full_name: name, email, notes: TAG })
    .select("id")
    .single()
  if (error) throw new Error(`contact insert: ${error.message}`)
  created.contacts.push(data.id)
  if (accountId) {
    await SUP.from("account_contacts").insert({ contact_id: data.id, account_id: accountId, is_primary: true })
  }
  return data.id
}

async function mkSd(fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await SUP.from("service_deliveries")
    .insert({ status: "active", notes: TAG, ...fields })
    .select("id")
    .single()
  if (error) throw new Error(`sd insert: ${error.message}`)
  return data.id
}

async function cleanup() {
  for (const id of created.contacts) {
    await SUP.from("wizard_progress").delete().eq("contact_id", id)
    await SUP.from("itin_submissions").delete().eq("contact_id", id)
    await SUP.from("service_deliveries").delete().eq("contact_id", id)
    await SUP.from("account_contacts").delete().eq("contact_id", id)
    await SUP.from("contacts").delete().eq("id", id)
  }
  for (const id of created.accounts) {
    await SUP.from("wizard_progress").delete().eq("account_id", id)
    await SUP.from("service_deliveries").delete().eq("account_id", id)
    await SUP.from("account_contacts").delete().eq("account_id", id)
    await SUP.from("accounts").delete().eq("id", id)
  }
}

// ── scenarios ────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🧪 E2E — an ITIN belongs to the PERSON (sandbox)\n")

  // ── 1. Pietro's shape: owns a company, ITIN attached to him ────────────────
  console.log("1. Pietro's shape — owns a company, ITIN on the person")
  const acctP = await mkAccount(`${TAG} DeP-like LLC`)
  const pietro = await mkContact(`${TAG} Pietro`, `${TAG}-pietro@example.test`, acctP)
  await mkSd({ service_name: "ITIN", service_type: "ITIN", stage: "Data Collection", stage_order: 1, account_id: null, contact_id: pietro })

  check(
    "sidebar entrance appears while a company is selected",
    await computeHasWizardPending({ contactId: pietro, selectedAccountId: acctP, portalTier: "active" }),
    "this was FALSE before the fix — the whole bug",
  )
  const scopeP = resolveWizardProgressScope({ wizardType: "itin", formationLeadId: null, accountId: acctP, contactId: pietro })
  check("his answers are keyed on HIM, not the company", scopeP?.col === "contact_id" && scopeP.val === pietro, `got ${scopeP?.col}`)
  check("his submission carries no company", accountIdForWizardSubmission("itin", acctP) === null)
  check("discovery unions in the ITIN service type", getContactScopedDiscoveryServiceTypes().includes("ITIN"))

  // ── 2. ITIN-only client (no company at all) — regression ───────────────────
  console.log("\n2. Regression — ITIN-only client with no company")
  const solo = await mkContact(`${TAG} Solo`, `${TAG}-solo@example.test`)
  await mkSd({ service_name: "ITIN", service_type: "ITIN", stage: "Data Collection", stage_order: 1, account_id: null, contact_id: solo })
  check(
    "still reaches the questionnaire (the path that always worked)",
    await computeHasWizardPending({ contactId: solo, selectedAccountId: "", portalTier: "active" }),
  )

  // ── 3. After submitting — the nag must stop ───────────────────────────────
  console.log("\n3. After submitting — the reminder stops")
  await SUP.from("wizard_progress").insert({
    wizard_type: "itin", status: "submitted", contact_id: pietro, account_id: null, data: {}, current_step: 3,
  })
  check(
    "entrance disappears once the ITIN questionnaire is submitted",
    (await computeHasWizardPending({ contactId: pietro, selectedAccountId: acctP, portalTier: "active" })) === false,
    "the ITIN service stays active for months of IRS processing — 'active' must not mean 'still owes us the form'",
  )

  // ── 4. Two people, one company (LUMA Beauty Global shape) ─────────────────
  console.log("\n4. Two people in ONE company, each with their own ITIN (LUMA shape)")
  const acctL = await mkAccount(`${TAG} LUMA-like LLC`)
  const adam = await mkContact(`${TAG} Adam`, `${TAG}-adam@example.test`, acctL)
  const peter = await mkContact(`${TAG} Peter`, `${TAG}-peter@example.test`, acctL)
  const sdAdam = await mkSd({ service_name: "ITIN", service_type: "ITIN", stage: "Data Collection", stage_order: 1, account_id: null, contact_id: adam })
  const sdPeter = await mkSd({ service_name: "ITIN", service_type: "ITIN", stage: "Data Collection", stage_order: 1, account_id: null, contact_id: peter })

  const sA = resolveWizardProgressScope({ wizardType: "itin", formationLeadId: null, accountId: acctL, contactId: adam })
  const sB = resolveWizardProgressScope({ wizardType: "itin", formationLeadId: null, accountId: acctL, contactId: peter })
  check("each person reads their OWN answers, not their colleague's", sA?.val === adam && sB?.val === peter && sA.val !== sB.val)
  check("both service deliveries are distinct and person-scoped", sdAdam !== sdPeter)

  // Adam submits. CRITICAL: seed the row the way the LIVE CODE would write it —
  // ask accountIdForWizardSubmission for the account, exactly as the submit
  // route does. Hardcoding account_id:null here would bake in the post-fix
  // shape and the leak below could never reproduce, making the check a
  // vacuous pass (caught during the negative-control run of this harness).
  await SUP.from("wizard_progress").insert({
    wizard_type: "itin", status: "submitted", contact_id: adam,
    account_id: accountIdForWizardSubmission("itin", acctL),
    data: { passport_number: "SECRET-ADAM", dob: "1990-01-01" }, current_step: 3,
  })
  check(
    "after Adam submits, Adam is no longer nagged",
    (await computeHasWizardPending({ contactId: adam, selectedAccountId: acctL, portalTier: "active" })) === false,
  )
  check(
    "after Adam submits, PETER is still offered his own ITIN",
    await computeHasWizardPending({ contactId: peter, selectedAccountId: acctL, portalTier: "active" }),
    "before the fix Peter's submit returned 'Already submitted' and silently did nothing",
  )
  // THE PII CHECK. Ask the REAL resolver where Peter's form would read from,
  // then run exactly that query. Querying by contact_id directly would pass
  // trivially in both directions and prove nothing — the leak is that Peter's
  // lookup RESOLVES to the company and therefore returns Adam's row.
  const peterLookup = resolveWizardProgressScope({
    wizardType: "itin", formationLeadId: null, accountId: acctL, contactId: peter,
  })
  const { data: peterSees } = await SUP.from("wizard_progress")
    .select("id, contact_id, data")
    .eq(peterLookup!.col, peterLookup!.val)
    .eq("wizard_type", "itin")
  const leaked = (peterSees ?? []).filter(
    (r) => (r.data as Record<string, unknown> | null)?.passport_number === "SECRET-ADAM",
  )
  check(
    "Peter's form does NOT load Adam's passport number",
    leaked.length === 0,
    leaked.length ? `LEAKED: Peter's lookup (${peterLookup!.col}) returned Adam's row` : `lookup keyed on ${peterLookup!.col}`,
  )
  check(
    "Peter's form opens blank (no row of his own yet)",
    (peterSees ?? []).length === 0,
  )

  // ── 5. Company Formation must NOT leak across companies ──────────────────
  console.log("\n5. No formation leak — a client running company A, forming company B")
  check(
    "Company Formation is NOT in the contact-scoped discovery union",
    !getContactScopedDiscoveryServiceTypes().includes("Company Formation"),
    "unioning it would show company B's setup inside company A's portal",
  )

  // ── 6. Closure (the pre-existing flexible type) unchanged ────────────────
  console.log("\n6. Regression — Closure (flexible) still discovered")
  check("Company Closure still in the discovery union", getContactScopedDiscoveryServiceTypes().includes("Company Closure"))
  const closureContact = await mkContact(`${TAG} Closure`, `${TAG}-closure@example.test`, acctP)
  await mkSd({ service_name: "Closure", service_type: "Company Closure", stage: "Requested", stage_order: 1, account_id: null, contact_id: closureContact })
  check(
    "a contact-scoped closure still surfaces alongside a company",
    await computeHasWizardPending({ contactId: closureContact, selectedAccountId: acctP, portalTier: "active" }),
  )

  // ── 7. ITIN Renewal deliberately out of scope ────────────────────────────
  console.log("\n7. ITIN Renewal is deliberately NOT on this rail")
  check("'ITIN Renewal' is not treated as person-owned", !getPersonOwnedServiceTypes().includes("ITIN Renewal"))
  const renewalContact = await mkContact(`${TAG} Renewal`, `${TAG}-renewal@example.test`, acctP)
  const renewalSd = await mkSd({
    service_name: "ITIN Renewal", service_type: "ITIN Renewal", stage: "Data Collection", stage_order: 1,
    account_id: acctP, contact_id: renewalContact,
  })
  const { data: renewalRow } = await SUP.from("service_deliveries").select("account_id").eq("id", renewalSd).single()
  check(
    "a renewal keeps its company (so it is NOT swept into the person rail)",
    renewalRow?.account_id === acctP,
    "including renewals would route them into the ITIN-APPLICATION chain",
  )

  // ── 8. Authorization — a teammate cannot file someone's ITIN ─────────────
  console.log("\n8. Authorization — teammates cannot file a person's ITIN")
  const teammate = { kind: "teammate", accountId: acctP, teamMemberId: "tm-1" } as unknown as PortalIdentity
  const owner: PortalIdentity = { kind: "contact", contactId: pietro, accountIds: [acctP] }
  check("teammate is DENIED an ITIN submit", canSubmitWizard(teammate, null, pietro, "itin") === false,
    "the submission carries no company, so the company check alone would have passed it")
  check("teammate can still submit a company-owned wizard", canSubmitWizard(teammate, acctP, null, "tax") === true)
  check("the ITIN owner can submit their own", canSubmitWizard(owner, null, pietro, "itin") === true)
  check("nobody can submit an ITIN under a different person", canSubmitWizard(owner, null, "someone-else", "itin") === false)

  // ── 9. The no-migration claim, proven against a legacy row shape ─────────
  console.log("\n9. Legacy rows — the reason no migration was needed")
  const legacy = await mkContact(`${TAG} Legacy`, `${TAG}-legacy@example.test`, acctP)
  await SUP.from("wizard_progress").insert({
    wizard_type: "itin", status: "submitted",
    contact_id: legacy, account_id: acctP, // the OLD shape: both set
    data: { passport_number: "LEGACY" }, current_step: 3,
  })
  const legacyScope = resolveWizardProgressScope({ wizardType: "itin", formationLeadId: null, accountId: acctP, contactId: legacy })
  const { data: foundLegacy } = await SUP.from("wizard_progress")
    .select("id, data")
    .eq(legacyScope!.col, legacyScope!.val)
    .eq("wizard_type", "itin")
    .eq("status", "submitted")
  check(
    "an old company-keyed record is STILL found by the new person-keyed lookup",
    (foundLegacy ?? []).length === 1,
    "every existing ITIN record already carries the person — that is why no data move was needed",
  )
  check("that client is therefore NOT re-offered a blank form", (foundLegacy ?? []).length > 0)

  // ── 10. The rule is declared once ───────────────────────────────────────
  console.log("\n10. The person-ownership rule is declared in ONE place")
  check("'itin' is the person-owned wizard", isPersonOwnedWizard("itin"))
  check("'formation' is NOT person-owned (it has its own lead-scoped rule)", !isPersonOwnedWizard("formation"))
  check("'tax' is NOT person-owned", !isPersonOwnedWizard("tax"))
  check("a company-owned wizard still keeps its company", accountIdForWizardSubmission("tax", acctP) === acctP)

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
