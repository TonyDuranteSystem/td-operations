/* eslint-disable no-console */
/**
 * Audit batch A QA (dev job ad09ea91, child 2d26a2df): a company in storage is no longer read from / written to through Drive.
 * SANDBOX only; needs the dev server on :3100. Company = Uxio Test LLC (live storage in sandbox).
 *  A1 a contact-scoped flow upload (ITIN) for a person in a switched company is saved in the person's storage (not a 500)
 *  A2 process-and-share on a company in storage answers 409 with the plain message
 *  A3 processFile refuses a company in storage
 *  A4 the welcome-package and bank-statement lookups read the CRM records (no Drive)
 */
import { config } from "dotenv"
import { call, check, pdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UXIO = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const ITIN_SD = "853b827a-5b8f-4c53-abc2-183744ca75f3"

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const staff = await sessionCookie("staff")
  const tag = Date.now()

  // A1 — contact-scoped flow upload
  const { data: sd } = await sb.from("service_deliveries").select("id, account_id, contact_id, service_type, stage").eq("id", ITIN_SD).maybeSingle()
  check("A0 the test ITIN flow is contact-scoped", !!sd && sd.account_id === null && !!sd.contact_id, JSON.stringify(sd))
  const path = `crm-uploads/store-staging/qa-${tag}-itin.pdf`
  await sb.storage.from("onboarding-uploads").upload(path, pdf("itin"), { contentType: "application/pdf", upsert: true })
  const name = `QA Test itin letter ${tag}.pdf`
  const up = await call(`/api/flows/${ITIN_SD}/upload-document`, { cookie: staff, json: { storage_path: path, file_name: name, mime_type: "application/pdf", flow_stage: sd.stage, auto_advance: false } })
  check("A1 the upload is accepted (no server error)", up.status === 200, `HTTP ${up.status} ${up.text.slice(0, 200)}`)
  const { data: row } = await sb.from("documents").select("id, drive_file_id, contact_id, portal_visible, file_name").eq("file_name", name).maybeSingle()
  check("A2 its record points at the new storage and belongs to the person", !!row && String(row.drive_file_id).startsWith("store:") && row.contact_id === sd.contact_id, JSON.stringify(row))
  check("A3 …and is hidden from the client", row?.portal_visible === false, JSON.stringify(row))

  // A2 — process-and-share
  const ps = await call(`/api/accounts/${UXIO}/files/process-and-share`, { cookie: staff, json: { fileId: `qa-fake-drive-file-${tag}` } })
  check("B1 process-and-share on a company in storage answers 409", ps.status === 409, `HTTP ${ps.status} ${ps.text.slice(0, 160)}`)
  check("B2 …with the plain message", /CRM storage/i.test(ps.text), ps.text.slice(0, 160))

  // A3 — processFile
  const { processFile } = await import("../../../lib/mcp/tools/doc")
  const r = await processFile(`qa-fake-drive-file-${tag}`, UXIO)
  check("C1 processFile refuses a company in storage", r.success === false && r.status === "refused", JSON.stringify(r))

  // A4 — record lookups
  const { findWelcomeDocsFromRecords } = await import("../../../lib/operations/welcome-docs")
  const w = await findWelcomeDocsFromRecords(UXIO)
  check("D1 the welcome-package lookup answers from the CRM records (no Drive)", w !== null, JSON.stringify(w))
  const { findStatementRecords } = await import("../../../lib/operations/bank-statement-files")
  const s = await findStatementRecords(UXIO, new Date().getFullYear() - 1)
  check("D2 the bank-statement lookup answers from the CRM records (no Drive)", Array.isArray(s.files), JSON.stringify(s))

  // clean-up of what this run made
  if (row?.id) await sb.from("documents").delete().eq("id", row.id)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
