/* eslint-disable no-console */
/**
 * Phase 5 QA t14: a staff upload into a company's storage is HIDDEN from the client unless "show to client" is chosen on purpose.
 * SANDBOX only; needs the dev server on :3100 (sandbox mode, so no email can go out).
 */
import { config } from "dotenv"
import { call, check, pdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const staff = await sessionCookie("staff")
  const clientUx = await sessionCookie("clientUx")
  const stage = async (name: string) => { const p = `crm-uploads/store-staging/qa-${Date.now()}-${name}`; await sb.storage.from("onboarding-uploads").upload(p, pdf(name), { contentType: "application/pdf", upsert: true }); return p }
  const { data: live } = await sb.from("store_owners").select("id").eq("account_id", "30c2cd96-03e4-43cf-9536-81d961b18b1d").eq("study_only", false).maybeSingle()
  const { data: folder } = await sb.from("store_folders").select("id").eq("owner_id", live.id).eq("name", "1. Company").is("trashed_at", null).maybeSingle()
  const up = async (name: string, extra: Record<string, unknown>) => call("/api/crm-store/browse/upload", { cookie: staff, json: { ownerId: live.id, folderId: folder.id, storagePath: await stage(name), fileName: name, mimeType: "application/pdf", documentType: "other_document", ...extra } })
  const tag = Date.now()

  const a = await up(`QA Test default ${tag}.pdf`, {})                       // the caller says nothing about visibility
  const aId = (a.json as { fileId?: string } | null)?.fileId
  check("H1 an upload that says nothing about visibility is accepted", a.status === 200 && !!aId, `HTTP ${a.status} ${a.text.slice(0, 120)}`)
  const { data: fa } = await sb.from("store_files").select("published").eq("id", aId).maybeSingle()
  check("H2 …and it is HIDDEN from the client", fa?.published === false, JSON.stringify(fa))
  const { data: ra } = await sb.from("documents").select("id, portal_visible").eq("drive_file_id", `store:${aId}`).maybeSingle()
  check("H3 the CRM row says hidden too, and the client gets 404", ra?.portal_visible === false && (await call(`/api/portal/documents/${ra?.id}`, { cookie: clientUx })).status === 404, JSON.stringify(ra))

  const b = await up(`QA Test hidden ${tag}.pdf`, { visible: false })
  const bId = (b.json as { fileId?: string } | null)?.fileId
  const { data: fb } = await sb.from("store_files").select("published").eq("id", bId).maybeSingle()
  check("H4 an explicit 'do not show' stays hidden", fb?.published === false, JSON.stringify(fb))

  const c = await up(`QA Test shown ${tag}.pdf`, { visible: true })
  const cId = (c.json as { fileId?: string } | null)?.fileId
  const { data: fc } = await sb.from("store_files").select("published").eq("id", cId).maybeSingle()
  const { data: rc } = await sb.from("documents").select("id, portal_visible").eq("drive_file_id", `store:${cId}`).maybeSingle()
  const open = await call(`/api/portal/documents/${rc?.id}`, { cookie: clientUx })
  check("H5 choosing 'show to client' on purpose shows it, and the client opens it", fc?.published === true && rc?.portal_visible === true && open.status === 200, `${JSON.stringify({ fc, rc })} client HTTP ${open.status} ${open.text.slice(0, 100)}`)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
