/* eslint-disable no-console */
/**
 * Seed a Mojo-equivalent fixture for browser QA, then leave it in place.
 * Prints the account ID + login URL. Run the cleanup script after QA done.
 */
import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("xjcxlmlpeywtwkhstjlw")) {
  console.error("NOT SANDBOX — abort")
  process.exit(1)
}

async function main() {
  const { supabaseAdmin } = await import("../../lib/supabase-admin")

  const ts = Date.now()
  const email = `qa-mojo-eq-${ts}@example.test`
  const fullName = `QA Mojo Eq ${ts}`
  const companyName = `QA Mojo Eq ${ts} LLC`

  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .insert({ email, full_name: fullName, language: "en" })
    .select("id")
    .single()
  if (!contact) throw new Error("contact insert failed")

  const { data: account } = await supabaseAdmin
    .from("accounts")
    .insert({
      company_name: companyName,
      account_type: "One-Time",
      status: "Active",
      entity_type: "Single Member LLC",
      ein_number: `99-${Math.floor(Math.random() * 10000000).toString().padStart(7, "0")}`,
      formation_date: "2025-07-17",
      state_of_formation: "Wyoming",
    })
    .select("id")
    .single()
  if (!account) throw new Error("account insert failed")

  await supabaseAdmin
    .from("account_contacts")
    .insert({ account_id: account.id, contact_id: contact.id, role: "owner" })

  const offerToken = `qa-mojo-browser-${ts}`
  await supabaseAdmin.from("offers").insert({
    token: offerToken,
    account_id: account.id,
    client_email: email,
    client_name: companyName,
    contract_type: "onboarding",
    status: "signed",
    cost_summary: [
      { label: "Setup Fee", total: "$3,800", items: [{ name: "LLC Onboarding", price: "$3,800" }] },
    ] as never,
    recurring_costs: [
      { label: "1st Installment (January)", price: "$1250", currency: "USD" },
      { label: "2nd Installment (June)", price: "$1250", currency: "USD" },
      { label: "Annual Total", price: "$2,500", currency: "USD" },
    ] as never,
    services: [
      { name: "LLC Onboarding", price: "$3,800", pipeline_type: "Annual Renewal" },
    ] as never,
    bundled_pipelines: ["Annual Renewal"],
    language: "en",
    payment_type: "bank_transfer",
  })

  // Awaiting payment activation so the Confirm Payment button has something
  // to act on (also matches the showConfirmPaymentBtn gate elsewhere).
  await supabaseAdmin.from("pending_activations").insert({
    offer_token: offerToken,
    client_name: companyName,
    client_email: email,
    amount: 3800,
    currency: "USD",
    payment_method: "bank_transfer",
    status: "awaiting_payment",
    signed_at: new Date().toISOString(),
  })

  console.log("\nSEED OK")
  console.log(`  account_id      = ${account.id}`)
  console.log(`  contact_id      = ${contact.id}`)
  console.log(`  offer_token     = ${offerToken}`)
  console.log(`  email           = ${email}`)
  console.log(`  url             = http://localhost:3000/accounts/${account.id}`)
  console.log("\nCleanup snippet:")
  console.log(`  -- delete from action_log where account_id='${account.id}';`)
  console.log(`  -- delete from pending_activations where offer_token='${offerToken}';`)
  console.log(`  -- delete from offers where token='${offerToken}';`)
  console.log(`  -- delete from account_contacts where account_id='${account.id}';`)
  console.log(`  -- delete from accounts where id='${account.id}';`)
  console.log(`  -- delete from contacts where id='${contact.id}';`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
