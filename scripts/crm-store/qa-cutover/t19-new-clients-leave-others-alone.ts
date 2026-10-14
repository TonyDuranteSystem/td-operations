/* eslint-disable no-console, no-restricted-syntax -- sandbox QA fixtures ("ZZ B19" rows) */
/**
 * Batch B QA (dev job ad09ea91): turning the new-clients switch ON must not touch anyone who is not a NEW client.
 *   a) a formation that began on Drive BEFORE the switch (no storage) stays owner-less when its wizard runs after the switch
 *   b) a returning client (a linked company) buying a new formation gets no formation storage
 *   c) a contact with an old Drive contact folder and no storage of their own gets none
 *   d) switch OFF: a brand-new client gets nothing either (default behaviour unchanged)
 * SANDBOX only, no server needed.   npx tsx scripts/crm-store/qa-cutover/t19-new-clients-leave-others-alone.ts
 */
import { config } from "dotenv"
config({ path: ".env.local" })

let failures = 0
function check(cond: unknown, msg: string, extra?: unknown) {
  if (cond) console.log(`  PASS  ${msg}`)
  else { failures++; console.log(`  FAIL  ${msg}`, extra === undefined ? "" : JSON.stringify(extra)) }
}

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("not the sandbox — refusing")
  process.env.SANDBOX_MODE = "1"
  delete process.env.STORE_NEW_CLIENTS
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const pilot = await import("../../../lib/crm-store/formation-pilot")
  const { createSD } = await import("../../../lib/operations/service-delivery")
  const db = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const tag = Date.now()
  const mk = async (label: string, extra: Record<string, unknown> = {}) => {
    const { data, error } = await db.from("contacts").insert({ full_name: `ZZ B19 ${label} ${tag}`, email: `zz-b19-${label}-${tag}@example.test`, ...extra }).select("id").single()
    if (error) throw new Error(error.message)
    return data.id as string
  }
  const owner = async (sd: string) => (await db.from("store_owners").select("id").eq("service_delivery_id", sd).maybeSingle()).data
  const formation = (contactId: string) => createSD({ service_type: "Company Formation", contact_id: contactId, account_id: null, service_name: `Company Formation - ZZ B19 ${tag}` } as never) as Promise<{ id: string }>

  console.log("\nd) switch OFF — a brand-new client gets nothing")
  const fresh0 = await mk("fresh0")
  const sd0 = await formation(fresh0)
  check(!(await owner(sd0.id)), "no formation storage (default behaviour unchanged)")

  process.env.STORE_NEW_CLIENTS = "1"

  console.log("\na) a formation that began BEFORE the switch")
  check(!(await owner(sd0.id)), "still no storage after the switch is turned on")
  const again = await pilot.ensureFormationOwner({ id: sd0.id, contact_id: fresh0, account_id: null, service_type: "Company Formation" }, "x")
  check(again === null, "the wizard / upload steps never open one mid-flight", again)

  console.log("\nb) a returning client (already has a company)")
  const ret = await mk("returning")
  const { data: acc } = await db.from("accounts").select("id").limit(1).single()
  await db.from("account_contacts").insert({ account_id: acc.id, contact_id: ret, role: "Owner" })
  const sdR = await formation(ret)
  check(!(await owner(sdR.id)), "no formation storage — they stay on Drive until their company switches")
  await db.from("account_contacts").delete().eq("account_id", acc.id).eq("contact_id", ret)

  console.log("\nc) a contact with an old Drive contact folder")
  const old = await mk("old", { drive_folder_id: `zz-b19-folder-${tag}` })
  const sdO = await formation(old)
  check(!(await owner(sdO.id)), "no formation storage")

  console.log("\nand a genuinely new client DOES get one")
  const fresh = await mk("fresh")
  const sdF = await formation(fresh)
  check(!!(await owner(sdF.id)), "formation storage opened at once")

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
