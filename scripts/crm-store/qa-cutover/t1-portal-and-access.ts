/* eslint-disable no-console */
/**
 * Phase 3 QA t1 (bug-hunter rows 2, 4, 5, 8 + V1/V2): the client's own upload, an INTERNAL file reached by id, another
 * company's client, and staff correspondence opened by the client. SANDBOX only. Run: npx tsx scripts/crm-store/qa-cutover/t1-portal-and-access.ts
 */
import { config } from "dotenv"
import { call, check, form, pdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const TC_ACCOUNT_NAME = "Test Company LLC"

async function main() {
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = new Date().toISOString()
  const staff = await sessionCookie("staff")
  const clientUx = await sessionCookie("clientUx")
  const clientTc = await sessionCookie("clientTc")

  // ── row 5: the client uploads a document in the portal (switched company) ─────────────────────────────────
  const up = await call("/api/portal/documents/upload", { cookie: clientUx, form: form({ account_id: UX, doc_type: "QA Test client upload", category: "1" }, { name: "QA Test client upload.pdf", data: pdf("client upload"), type: "application/pdf" }) })
  const upBody = up.json as { document_id?: string; error?: string } | null
  check("5a client upload accepted", up.status === 200 && !!upBody?.document_id, `HTTP ${up.status} ${up.text.slice(0, 120)}`)
  const docId = upBody?.document_id as string
  const { data: row } = await sb.from("documents").select("id, drive_file_id, portal_visible, document_type_name, account_id, drive_link").eq("id", docId).maybeSingle()
  check("5b listed as a storage pointer, never a Drive id", !!row?.drive_file_id?.startsWith("store:"), `drive_file_id=${row?.drive_file_id}`)
  check("5c row belongs to the company", row?.account_id === UX, `account_id=${row?.account_id}`)
  const fileId = String(row?.drive_file_id ?? "").replace("store:", "")
  const { data: sf } = await sb.from("store_files").select("document_type, published, state").eq("id", fileId).maybeSingle()
  // a HIDDEN upload may stay untyped (staff type it when they show it); only a client-visible file needs a type
  check("5d the stored file is live and not shown (type may be empty until staff review)", sf?.state === "live" && sf?.published === false, `type=${sf?.document_type} state=${sf?.state} published=${sf?.published}`)
  check("5e client upload is hidden by default like the Drive path (documents.portal_visible default false)", row?.portal_visible === false, `portal_visible=${row?.portal_visible}`)

  // the uploader can open their own file through the portal route? (hidden store rows are 404 — same as an internal file)
  const own = await call(`/api/portal/documents/${docId}`, { cookie: clientUx })
  console.log(`      (info) the uploading client opening their own hidden-by-default upload: HTTP ${own.status}`)

  // ── rows 2 + V1/V2: an INTERNAL store file (SS-4, portal_visible=false) must be a 404 for the client, by id ──
  const { saveSignedPdfForAccount } = await import("../../../lib/crm-store/save-for-account")
  const internal = await saveSignedPdfForAccount({ accountId: UX, fileName: "QA Test internal ss4.pdf", bytes: pdf("internal ss4"), label: "Form SS-4 (Signed)", category: 1, callerKey: `qa-t1-internal:${Date.now()}`, portalVisible: false, documentType: "form_ss_4" })
  if (internal.route !== "store") throw new Error("expected a store save for the fixture company")
  const byId = await call(`/api/portal/documents/${internal.documentRowId}`, { cookie: clientUx })
  check("2a internal SS-4 by id → 404 for the client of the SAME company", byId.status === 404, `HTTP ${byId.status}`)
  const staffOpen = await call(`/api/documents/${internal.documentRowId}/preview`, { cookie: staff })
  check("2b staff CAN open the internal SS-4 (CRM preview)", staffOpen.status === 200 && staffOpen.bytes.length > 10, `HTTP ${staffOpen.status}, ${staffOpen.bytes.length} bytes`)

  // a visible typed file → the client opens it
  const shown = await saveSignedPdfForAccount({ accountId: UX, fileName: "QA Test shown lease.pdf", bytes: pdf("shown lease"), label: "Lease Agreement", category: 1, callerKey: `qa-t1-shown:${Date.now()}`, documentType: "office_lease" })
  if (shown.route !== "store") throw new Error("expected store")
  const open = await call(`/api/portal/documents/${shown.documentRowId}`, { cookie: clientUx })
  check("5f a visible typed file opens for its own client", open.status === 200 && open.bytes.length > 10, `HTTP ${open.status}, ${open.bytes.length} bytes`)

  // forced-visible but staff-only type (V1): the Formation Summary must stay closed whatever the row says
  const fs = await saveSignedPdfForAccount({ accountId: UX, fileName: "QA Test formation summary.pdf", bytes: pdf("formation summary"), label: "Formation Summary", category: 1, callerKey: `qa-t1-fs:${Date.now()}`, portalVisible: false, documentType: "formation_summary" })
  if (fs.route !== "store") throw new Error("expected store")
  await sb.from("documents").update({ portal_visible: true }).eq("id", fs.documentRowId)
  const fsOpen = await call(`/api/portal/documents/${fs.documentRowId}`, { cookie: clientUx })
  check("V1 Formation Summary with portal_visible forced TRUE still 404 for a client", fsOpen.status === 404, `HTTP ${fsOpen.status}`)

  // ── row 4: cross-company — the other company's client must not reach UX files ──────────────────────────────
  for (const [label, id] of [["visible lease", shown.documentRowId], ["internal ss4", internal.documentRowId], ["own upload", docId]] as const) {
    const r = await call(`/api/portal/documents/${id}`, { cookie: clientTc })
    check(`4 other company's client → ${label}`, r.status === 403 || r.status === 404, `HTTP ${r.status}`)
  }
  const anon = await call(`/api/portal/documents/${shown.documentRowId}`)
  check("4x no login → 401", anon.status === 401, `HTTP ${anon.status}`)

  // ── row 8: staff sends correspondence; the client opens it through the new route ──────────────────────────
  const corr = await call("/api/accounts/correspondence", { cookie: staff, form: form({ account_id: UX, description: "QA Test correspondence" }, { name: "QA Test correspondence.pdf", data: pdf("correspondence"), type: "application/pdf" }) })
  const corrBody = corr.json as { correspondence?: { id: string; drive_file_id: string; drive_file_url: string }; error?: string } | null
  check("8a staff correspondence accepted", corr.status === 200 && !!corrBody?.correspondence?.id, `HTTP ${corr.status} ${corr.text.slice(0, 140)}`)
  const c = corrBody?.correspondence
  check("8b stored as a pointer and the link is the portal route (no Drive link)", !!c?.drive_file_id?.startsWith("store:") && c?.drive_file_url === `/api/portal/correspondence/${c?.id}/file`, `${c?.drive_file_id} | ${c?.drive_file_url}`)
  const cOpen = await call(`/api/portal/correspondence/${c?.id}/file`, { cookie: clientUx })
  check("8c the client opens it (attachment)", cOpen.status === 200 && /attachment/.test(cOpen.headers.get("content-disposition") ?? "") && cOpen.bytes.length > 10, `HTTP ${cOpen.status} ${cOpen.headers.get("content-disposition")}`)
  const cOther = await call(`/api/portal/correspondence/${c?.id}/file`, { cookie: clientTc })
  check("8d another company's client → 403", cOther.status === 403, `HTTP ${cOther.status}`)
  const cNone = await call(`/api/portal/correspondence/00000000-0000-4000-8000-000000000000/file`, { cookie: clientUx })
  check("8e unknown id → 404", cNone.status === 404, `HTTP ${cNone.status}`)
  const cDocs = await sb.from("documents").select("id, portal_visible").eq("drive_file_id", c?.drive_file_id)
  check("8f not listed a second time under Documents (the row stays hidden)", (cDocs.data ?? []).every((d: { portal_visible: boolean }) => d.portal_visible === false), `rows=${JSON.stringify(cDocs.data)}`)

  // ── Q3: nothing written to Drive for this company in this run ──────────────────────────────────────────────
  const { data: stray } = await sb.from("documents").select("id, drive_file_id").eq("account_id", UX).gt("created_at", t0).not("drive_file_id", "like", "store:%")
  check("Q3 no document of this run points at a Drive id", (stray ?? []).length === 0, `rows=${JSON.stringify(stray)}`)

  console.log("      (cleanup) test rows stay in the sandbox (QA Test prefix); stored files are never deleted")
  void TC_ACCOUNT_NAME
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
