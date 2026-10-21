/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * ITIN documents go to People › ITIN (Antonio 2026-10-21): the REAL workspace upload route on the local dev server (sandbox database).
 * An ITIN case's workspace upload must land in the person's ITIN folder; the person's passport rule is unchanged (Personal documents).
 * Needs: dev server on QA_BASE (default http://localhost:3045), the staff QA session (qa-creds.json). SANDBOX only.
 * Run: DOTENV_PATH=.env.local npx tsx scripts/crm-store/qa-cutover/t48-itin-docs-folder.ts
 */
import { config } from "dotenv"
import { PDFDocument } from "pdf-lib"
import { check, summary, sessionCookie, BASE } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  const { ensurePersonOwner } = await import("../../../lib/crm-store/formation-pilot")
  const stamp = Date.now()
  const doc = await PDFDocument.create(); doc.addPage()
  const bytes = Buffer.from(await doc.save())
  const cookie = await sessionCookie("staff")
  const { data: c } = await sb.from("contacts").insert({ first_name: "Qa", last_name: `ItinDocs${stamp}`, full_name: `Qa ItinDocs${stamp}`, email: `qa-itin-docs-${stamp}@example.invalid`, language: "English" }).select("id").single()
  const ownerId = await ensurePersonOwner(c.id, `Qa ItinDocs${stamp}`)
  const { data: sd } = await sb.from("service_deliveries").insert({ service_name: `QA ITIN docs ${stamp}`, service_type: "ITIN", stage: "Documents Received", stage_order: 5, status: "active", contact_id: c.id }).select("id").single()
  const staged: string[] = []
  const up = async (name: string) => { const p = `qa-itin-docs/${stamp}/${name}`; await sb.storage.from("onboarding-uploads").upload(p, bytes, { contentType: "application/pdf", upsert: true }); staged.push(p); return p }
  const post = async (path: string, file: string, stage: string) => {
    const r = await fetch(`${BASE}/api/flows/${sd.id}/upload-document`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ storage_path: path, file_name: file, mime_type: "application/pdf", flow_stage: stage, auto_advance: false }) })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  const where = async (name: string) => {
    const { data: f } = await sb.from("store_files").select("name, folder_id").eq("owner_id", ownerId).eq("name", name).is("trashed_at", null).maybeSingle()
    if (!f) return null
    const { data: fo } = await sb.from("store_folders").select("name, kind").eq("id", f.folder_id).single()
    return fo.name as string
  }
  try {
    const r1 = await post(await up("IRS letter.pdf"), `QA IRS letter ${stamp}.pdf`, "Documents Received")
    check("F1 the workspace upload (Documents Received) is accepted", r1.status === 200 && r1.body.success !== false, JSON.stringify(r1).slice(0, 250))
    check("F2 …and lands in the person's ITIN folder (not Personal documents)", (await where(`QA IRS letter ${stamp}.pdf`)) === "ITIN", String(await where(`QA IRS letter ${stamp}.pdf`)))
    const r2 = await post(await up("approval.pdf"), `QA CP565 ${stamp}.pdf`, "CAA Review")
    check("F3 another ITIN stage upload also lands in ITIN", r2.status === 200 && (await where(`QA CP565 ${stamp}.pdf`)) === "ITIN", JSON.stringify(r2).slice(0, 200))
  } finally {
    await sb.from("service_deliveries").update({ status: "cancelled" }).eq("id", sd.id)
    const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", c.id); for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id)
    await sb.storage.from("onboarding-uploads").remove(staged)
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
