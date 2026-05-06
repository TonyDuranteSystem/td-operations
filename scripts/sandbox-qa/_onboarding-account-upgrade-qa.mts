/* eslint-disable no-console -- QA script: console output is the deliverable */
/**
 * Sandbox QA — onboarding account-upgrade chain.
 *
 * End-to-end exercise of the new helper `applyOnboardingAccountUpgrades`
 * via the activate-service route. Verifies:
 *
 *   S1 — Mojo equivalent: existing One-Time account, onboarding offer with
 *        Setup Fee + 1st + 2nd installments. Expected post-activation:
 *          - accounts.account_type = 'Client'
 *          - accounts.setup_fee_amount + currency populated
 *          - accounts.installment_1_amount + installment_2_amount populated
 *          - pending_activations.status = 'activated'
 *          - action_log row with action_type='onboarding_account_upgrade'
 *
 *   S8 — Setup-fee-only: same as S1 but recurring_costs is empty.
 *        Expected post-activation:
 *          - accounts.account_type = 'One-Time' (NO flip)
 *          - accounts.setup_fee_amount populated
 *          - installment columns stay null
 *
 *   S9 — Retry idempotency: re-fire activate-service on an already-activated
 *        row. Expected: returns "Already activated", account row unchanged.
 *
 * Sandbox-only: aborts if NEXT_PUBLIC_SUPABASE_URL is not the sandbox ref.
 *
 * Cleanup: deletes the seeded fixtures at the end (or on script abort) so
 * sandbox stays tidy. No real Drive operations are triggered (SANDBOX_MODE=1
 * in sandbox env blocks Drive writes; activate-service handles this gracefully).
 */
import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("xjcxlmlpeywtwkhstjlw")) {
  console.error("NOT SANDBOX — abort")
  process.exit(1)
}

type CleanupRefs = {
  contact_ids: string[]
  account_ids: string[]
  offer_tokens: string[]
  pending_activation_ids: string[]
  payment_ids: string[]
  contract_ids: string[]
}
const cleanup: CleanupRefs = {
  contact_ids: [],
  account_ids: [],
  offer_tokens: [],
  pending_activation_ids: [],
  payment_ids: [],
  contract_ids: [],
}

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
const API_SECRET = process.env.API_SECRET_TOKEN

if (!API_SECRET) {
  console.error("API_SECRET_TOKEN not set in .env.local — abort")
  process.exit(1)
}

async function main() {
  const { supabaseAdmin } = await import("../../lib/supabase-admin")

  let pass = 0
  let fail = 0
  function check(label: string, ok: boolean, detail?: string) {
    if (ok) {
      console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`)
      pass++
    } else {
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
      fail++
    }
  }

  // ─── Seed helpers ─────────────────────────────────────────────────────────

  async function seedScenario(opts: {
    label: string
    accountType: "One-Time" | "Client" | null
    withRecurring: boolean
    setupFeeTotal?: string // e.g. "$1,000" or "€3,800"
    installment1Price?: string // e.g. "$1000"
    installment2Price?: string
    accountInstallment1Preset?: number | null // simulate a manually-set value
  }) {
    const ts = Date.now()
    const suffix = `${opts.label}-${ts}`
    const email = `qa-onb-${suffix}@example.test`
    const fullName = `QA OnbUpgrade ${suffix}`
    const companyName = `QA Onb ${suffix} LLC`

    // Contact
    const { data: contact, error: cErr } = await supabaseAdmin
      .from("contacts")
      .insert({ email, full_name: fullName, language: "en" })
      .select("id")
      .single()
    if (cErr || !contact) throw new Error(`contact insert failed: ${cErr?.message}`)
    cleanup.contact_ids.push(contact.id)

    // Account — emulates Mojo: existing One-Time with EIN/formation/state
    const { data: account, error: aErr } = await supabaseAdmin
      .from("accounts")
      .insert({
        company_name: companyName,
        account_type: opts.accountType,
        status: "Active",
        entity_type: "Single Member LLC",
        ein_number: `99-${Math.floor(Math.random() * 10000000).toString().padStart(7, "0")}`,
        formation_date: "2025-07-17",
        state_of_formation: "Wyoming",
        // pre-set installment_1_amount if requested (tests the "don't overwrite" guard)
        ...(opts.accountInstallment1Preset !== undefined
          ? { installment_1_amount: opts.accountInstallment1Preset, installment_1_currency: "USD" }
          : {}),
      })
      .select("id, account_type, setup_fee_amount, installment_1_amount, installment_2_amount")
      .single()
    if (aErr || !account) throw new Error(`account insert failed: ${aErr?.message}`)
    cleanup.account_ids.push(account.id)

    // Link contact to account
    await supabaseAdmin
      .from("account_contacts")
      .insert({ account_id: account.id, contact_id: contact.id, role: "owner" })

    // Offer — onboarding with the requested cost shape
    const offerToken = `qa-onb-${suffix}`
    const costSummary = [
      {
        label: "Setup Fee",
        total: opts.setupFeeTotal || "$1,000",
        items: [{ name: "LLC Onboarding", price: opts.setupFeeTotal || "$1,000" }],
      },
    ]
    const recurringCosts = opts.withRecurring
      ? [
          { label: "1st Installment (January)", price: opts.installment1Price || "$1000", currency: "USD" },
          { label: "2nd Installment (June)", price: opts.installment2Price || "$1000", currency: "USD" },
          { label: "Annual Total", price: "$2,000", currency: "USD" },
        ]
      : []
    const { error: oErr } = await supabaseAdmin
      .from("offers")
      .insert({
        token: offerToken,
        account_id: account.id,
        client_email: email,
        client_name: companyName,
        contract_type: "onboarding",
        status: "signed",
        cost_summary: costSummary as never,
        recurring_costs: recurringCosts as never,
        services: [
          { name: "LLC Onboarding", price: opts.setupFeeTotal || "$1,000", pipeline_type: "Annual Renewal" },
        ] as never,
        bundled_pipelines: ["Annual Renewal"],
        language: "en",
        payment_type: "bank_transfer",
      })
    if (oErr) throw new Error(`offer insert failed: ${oErr.message}`)
    cleanup.offer_tokens.push(offerToken)

    // Contracts row — signature-of-record (mimics what service-agreement.tsx writes)
    const { data: contractRow, error: contractErr } = await supabaseAdmin
      .from("contracts")
      .insert({
        offer_token: offerToken,
        client_name: fullName,
        client_email: email,
        signed_at: new Date().toISOString(),
        status: "signed",
        llc_type: "SMLLC",
      })
      .select("id")
      .single()
    if (contractErr) throw new Error(`contracts insert failed: ${contractErr.message}`)
    if (contractRow?.id) cleanup.contract_ids.push(contractRow.id)

    // Pending activation — emulates what offer-signed creates
    const total = parseFloat((opts.setupFeeTotal || "$1,000").replace(/[^0-9.]/g, ""))
    const { data: pa, error: paErr } = await supabaseAdmin
      .from("pending_activations")
      .insert({
        offer_token: offerToken,
        client_name: companyName,
        client_email: email,
        amount: total,
        currency: "USD",
        payment_method: "bank_transfer",
        status: "payment_confirmed", // skip the offer-signed step; route is the unit under test
        payment_confirmed_at: new Date().toISOString(),
        signed_at: new Date().toISOString(),
      })
      .select("id")
      .single()
    if (paErr || !pa) throw new Error(`pending_activation insert failed: ${paErr?.message}`)
    cleanup.pending_activation_ids.push(pa.id)

    return { accountId: account.id, contactId: contact.id, offerToken, pendingActivationId: pa.id, companyName, email }
  }

  async function callActivateService(pendingActivationId: string) {
    const res = await fetch(`${BASE_URL}/api/workflows/activate-service`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
      },
      body: JSON.stringify({ pending_activation_id: pendingActivationId }),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // ignore — non-JSON
    }
    return { status: res.status, body }
  }

  async function readAccount(accountId: string) {
    const { data } = await supabaseAdmin
      .from("accounts")
      .select("account_type, setup_fee_amount, setup_fee_currency, installment_1_amount, installment_1_currency, installment_2_amount, installment_2_currency")
      .eq("id", accountId)
      .single()
    return data
  }

  async function readActivation(paId: string) {
    const { data } = await supabaseAdmin
      .from("pending_activations")
      .select("status, activated_at")
      .eq("id", paId)
      .single()
    return data
  }

  async function readActionLog(accountId: string) {
    const { data } = await supabaseAdmin
      .from("action_log")
      .select("action_type, summary, details")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(5)
    return data ?? []
  }

  // ─── S1: Mojo equivalent ──────────────────────────────────────────────────

  console.log("\n━━━ S1: Mojo equivalent — One-Time + onboarding + recurring ━━━")
  const s1 = await seedScenario({
    label: "s1-mojo",
    accountType: "One-Time",
    withRecurring: true,
    setupFeeTotal: "$3,800",
    installment1Price: "$1250",
    installment2Price: "$1250",
  })
  const r1 = await callActivateService(s1.pendingActivationId)
  check("S1 activate-service returned 200", r1.status === 200, `HTTP ${r1.status}`)
  const a1 = await readAccount(s1.accountId)
  check("S1 account_type flipped One-Time → Client", a1?.account_type === "Client", `now ${a1?.account_type}`)
  check("S1 setup_fee_amount populated", Number(a1?.setup_fee_amount) === 3800, `value=${a1?.setup_fee_amount}`)
  check("S1 setup_fee_currency=USD", a1?.setup_fee_currency === "USD", `value=${a1?.setup_fee_currency}`)
  check("S1 installment_1_amount=1250", Number(a1?.installment_1_amount) === 1250, `value=${a1?.installment_1_amount}`)
  check("S1 installment_2_amount=1250", Number(a1?.installment_2_amount) === 1250, `value=${a1?.installment_2_amount}`)
  const pa1 = await readActivation(s1.pendingActivationId)
  check("S1 pending_activation activated", pa1?.status === "activated")
  const log1 = await readActionLog(s1.accountId)
  check(
    "S1 action_log has onboarding_account_upgrade entry",
    log1.some(l => l.action_type === "onboarding_account_upgrade"),
    `entries=${log1.map(l => l.action_type).join(",")}`,
  )

  // ─── S8: Setup-fee-only (no recurring) ────────────────────────────────────

  console.log("\n━━━ S8: Setup-fee-only — One-Time + onboarding + NO recurring ━━━")
  const s8 = await seedScenario({
    label: "s8-fee-only",
    accountType: "One-Time",
    withRecurring: false,
    setupFeeTotal: "$500",
  })
  const r8 = await callActivateService(s8.pendingActivationId)
  check("S8 activate-service returned 200", r8.status === 200)
  const a8 = await readAccount(s8.accountId)
  check("S8 account_type STAYS One-Time (no flip)", a8?.account_type === "One-Time", `now ${a8?.account_type}`)
  check("S8 setup_fee_amount=500", Number(a8?.setup_fee_amount) === 500, `value=${a8?.setup_fee_amount}`)
  check("S8 installment_1_amount stays null", a8?.installment_1_amount === null, `value=${a8?.installment_1_amount}`)
  check("S8 installment_2_amount stays null", a8?.installment_2_amount === null, `value=${a8?.installment_2_amount}`)

  // ─── S9: Retry idempotency ────────────────────────────────────────────────

  console.log("\n━━━ S9: Retry idempotency — re-fire on already-activated ━━━")
  const r9 = await callActivateService(s1.pendingActivationId)
  check("S9 activate-service returned 200 (already activated)", r9.status === 200)
  const a9 = await readAccount(s1.accountId)
  check("S9 account_type unchanged after retry", a9?.account_type === "Client")
  check("S9 setup_fee_amount unchanged", Number(a9?.setup_fee_amount) === 3800)
  check("S9 installment_1_amount unchanged", Number(a9?.installment_1_amount) === 1250)

  // ─── S7: Already-Client + onboarding offer (no flip, no downgrade) ────────

  console.log("\n━━━ S7: Already-Client + onboarding + recurring ━━━")
  const s7 = await seedScenario({
    label: "s7-already-client",
    accountType: "Client",
    withRecurring: true,
    setupFeeTotal: "$1,000",
    accountInstallment1Preset: 9999, // pre-set value, must NOT be overwritten
  })
  const r7 = await callActivateService(s7.pendingActivationId)
  check("S7 activate-service returned 200", r7.status === 200)
  const a7 = await readAccount(s7.accountId)
  check("S7 account_type stays Client", a7?.account_type === "Client")
  check(
    "S7 installment_1_amount NOT overwritten (still 9999)",
    Number(a7?.installment_1_amount) === 9999,
    `value=${a7?.installment_1_amount}`,
  )
  check("S7 setup_fee written (was null)", Number(a7?.setup_fee_amount) === 1000)

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  console.log("\n━━━ Cleanup ━━━")
  // Delete in reverse FK order: action_log → pending_activations → contracts → offers → account_contacts → accounts → contacts
  if (cleanup.account_ids.length > 0) {
    await supabaseAdmin.from("action_log").delete().in("account_id", cleanup.account_ids)
  }
  if (cleanup.pending_activation_ids.length > 0) {
    await supabaseAdmin.from("pending_activations").delete().in("id", cleanup.pending_activation_ids)
  }
  if (cleanup.contract_ids.length > 0) {
    await supabaseAdmin.from("contracts").delete().in("id", cleanup.contract_ids)
  }
  if (cleanup.offer_tokens.length > 0) {
    await supabaseAdmin.from("offers").delete().in("token", cleanup.offer_tokens)
  }
  if (cleanup.account_ids.length > 0) {
    await supabaseAdmin.from("account_contacts").delete().in("account_id", cleanup.account_ids)
    // Delete payments + invoices created during activation (createTDInvoice fires)
    await supabaseAdmin.from("payments").delete().in("account_id", cleanup.account_ids)
    await supabaseAdmin.from("client_expenses").delete().in("account_id", cleanup.account_ids)
    await supabaseAdmin.from("accounts").delete().in("id", cleanup.account_ids)
  }
  if (cleanup.contact_ids.length > 0) {
    await supabaseAdmin.from("contacts").delete().in("id", cleanup.contact_ids)
  }
  console.log(`  cleaned: ${cleanup.account_ids.length} accounts, ${cleanup.contact_ids.length} contacts, ${cleanup.offer_tokens.length} offers`)

  // ─── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n━━━ Summary ━━━`)
  console.log(`  ${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error("\n✗ FATAL:", err)
  // Best-effort cleanup
  try {
    const { supabaseAdmin } = await import("../../lib/supabase-admin")
    if (cleanup.account_ids.length) {
      await supabaseAdmin.from("action_log").delete().in("account_id", cleanup.account_ids)
      await supabaseAdmin.from("pending_activations").delete().in("id", cleanup.pending_activation_ids)
      await supabaseAdmin.from("contracts").delete().in("id", cleanup.contract_ids)
      await supabaseAdmin.from("offers").delete().in("token", cleanup.offer_tokens)
      await supabaseAdmin.from("account_contacts").delete().in("account_id", cleanup.account_ids)
      await supabaseAdmin.from("payments").delete().in("account_id", cleanup.account_ids)
      await supabaseAdmin.from("client_expenses").delete().in("account_id", cleanup.account_ids)
      await supabaseAdmin.from("accounts").delete().in("id", cleanup.account_ids)
      await supabaseAdmin.from("contacts").delete().in("id", cleanup.contact_ids)
    }
  } catch (cleanupErr) {
    console.error("  cleanup also failed:", cleanupErr)
  }
  process.exit(1)
})
