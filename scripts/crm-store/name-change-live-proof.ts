/* eslint-disable no-console, no-restricted-syntax, @typescript-eslint/no-explicit-any -- a sandbox-only proof script: prints its results, seeds a ZZ test company directly, store_* are not in the generated types */
/**
 * Change Name, Track S — END-TO-END proof on the SANDBOX through the REAL application code and the web API (PostgREST):
 *   save files with the real writer (folderOfKind → upload → store_write), list them in the CRM `documents` table,
 *   change the company's name with the account wrapper (supabase-js .rpc, service role), then check:
 *     - the wrapper answers over the API with the expected JSON;
 *     - the real folderOfKind now returns the FRESH folders (S1 + S2 together) and a new save lands there;
 *     - the real effectiveKind / categoryForFolder of every OLD file is unchanged (portal Documents + category counts);
 *     - the `documents` rows and their store:<file id> pointers are identical, and every pointer still resolves;
 *     - undo over the API puts everything back.
 * Creates a "ZZ Live Proof" TEST company (is_test) that stays in the sandbox. Refuses to run against production.
 *   npx tsx scripts/crm-store/name-change-live-proof.ts
 */
import { config } from "dotenv"
import { createHash } from "crypto"
config({ path: ".env.local" })

let failures = 0
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++ }

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../lib/supabase-admin")
  const pilot = await import("../../lib/crm-store/formation-pilot")
  const { effectiveKind, categoryForFolder } = await import("../../lib/crm-store/structure")
  const { storePointer } = await import("../../lib/crm-store/document-pointer")
  const d = supabaseAdmin as any
  const tag = Date.now().toString(36)
  const oldName = `ZZ Live Proof ${tag} LLC`
  const newName = `ZZ Live Proof Renamed ${tag} LLC`

  // ── the company, built the way the app builds it
  const { data: acct, error: aErr } = await d.from("accounts").insert({ company_name: oldName, is_test: true }).select("id").single()
  if (aErr) throw new Error(aErr.message)
  const { data: ownerId, error: oErr } = await d.rpc("store_ensure_owner", { p_kind: "company", p_ref: acct.id })
  if (oErr) throw new Error(oErr.message)
  await d.rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: pilot.COMPANY_TEMPLATE, p_root_name: pilot.storeSafeFolderName(oldName) })

  const bytes = (s: string) => Buffer.from(`%PDF-1.4 ${s} ${tag} ${createHash("md5").update(s + tag).digest("hex")}`)
  const saved: Array<{ id: string; name: string; kind: string }> = []
  const save = async (folderKind: string, name: string, key: string, folderId?: string) => {
    const w = await pilot.savePilotFile({ ownerId, folderKind, folderId, name, bytes: bytes(name), mimeType: "application/pdf", documentType: null, callerKey: `live-proof:${tag}:${key}` })
    const folder = (await d.from("store_files").select("folder_id").eq("id", w.fileId).single()).data.folder_id as string
    const cat = await categoryForFolder(folder)
    await pilot.upsertStoreDocumentRow(w.fileId, { file_name: name, account_id: acct.id, category: cat.num, category_name: cat.name, portal_visible: false }, w.status)
    saved.push({ id: w.fileId, name, kind: await effectiveKind(folder) })
    return w.fileId
  }
  await save("company", "Operating Agreement.pdf", "oa")
  await save("company", "EIN Letter.pdf", "ein")
  await save("correspondence", "Welcome Letter.pdf", "welcome")
  const { ensureYearFolder } = await import("../../lib/crm-store/save-form")
  const year = await ensureYearFolder(await pilot.folderOfKind(ownerId, "tax"), "2025")
  await save("tax", "Form 1120 2025.pdf", "ret", year)
  const oldTax = await pilot.folderOfKind(ownerId, "tax")
  const oldCompany = await pilot.folderOfKind(ownerId, "company")

  const docsFor = async () => {
    const { data } = await d.from("documents").select("id, drive_file_id, file_name, category, category_name, account_id").eq("account_id", acct.id).order("id")
    return data as Array<{ id: string; drive_file_id: string; category: number }>
  }
  const docsBefore = await docsFor()
  ok(docsBefore.length === 4 && docsBefore.every((x) => x.drive_file_id.startsWith("store:")), "4 CRM documents rows, all store:<file id> pointers")
  const catBefore = await Promise.all(saved.map(async (f) => [f.id, (await categoryForFolder((await d.from("store_files").select("folder_id").eq("id", f.id).single()).data.folder_id)).num]))

  // ── 1. dry run over the API: writes nothing
  const changeId = crypto.randomUUID()
  const dry = await d.rpc("store_apply_name_change_for_account", { p_account_id: acct.id, p_change_id: changeId, p_new_name: newName, p_expected_old_name: oldName, p_actor: null, p_dry_run: true })
  ok(!dry.error && dry.data?.status === "dry_run" && dry.data?.storage?.ok === true, `dry run over the API answers dry_run/ok (${dry.error?.message ?? JSON.stringify(dry.data?.storage?.would_move)})`)
  ok((await d.from("accounts").select("company_name").eq("id", acct.id).single()).data.company_name === oldName, "dry run changed nothing")

  // ── 2. the real change
  const res = await d.rpc("store_apply_name_change_for_account", { p_account_id: acct.id, p_change_id: changeId, p_new_name: newName, p_expected_old_name: oldName, p_actor: null, p_dry_run: false })
  ok(!res.error && res.data?.status === "applied" && res.data?.storage?.status === "applied", `wrapper over the API: applied (${res.error?.message ?? res.data?.status})`)
  const a = (await d.from("accounts").select("company_name, previous_name, name_history").eq("id", acct.id).single()).data
  ok(a.company_name === newName && a.previous_name === oldName && a.name_history.length === 1, "account: new name, previous_name = old name, one history entry")
  const rootName = (await d.from("store_folders").select("name").eq("owner_id", ownerId).is("parent_id", null).single()).data.name
  ok(rootName === pilot.storeSafeFolderName(newName), "the storage's top folder carries the new name")

  // ── 3. S1 + S2 together: the real lookups now answer with the FRESH folders
  const newTax = await pilot.folderOfKind(ownerId, "tax")
  const newCompany = await pilot.folderOfKind(ownerId, "company")
  ok(newTax !== oldTax && newCompany !== oldCompany, "folderOfKind('tax'/'company') returns the NEW folders, not the archived ones")
  const w = await pilot.savePilotFile({ ownerId, folderKind: "company", name: "Operating Agreement v2.pdf", bytes: bytes("oa v2"), mimeType: "application/pdf", documentType: null, callerKey: `live-proof:${tag}:oa2` })
  ok((await d.from("store_files").select("folder_id").eq("id", w.fileId).single()).data.folder_id === newCompany, "a document saved after the change lands in the NEW Company folder")
  // a retry of the same change over the API moves nothing
  const again = await d.rpc("store_apply_name_change_for_account", { p_account_id: acct.id, p_change_id: changeId, p_new_name: newName, p_expected_old_name: oldName, p_actor: null, p_dry_run: false })
  ok(again.data?.status === "already_applied", "the same call again: already_applied")

  // ── 4. the old files: same category, same CRM rows, pointers still resolve
  const catAfter = await Promise.all(saved.map(async (f) => [f.id, (await categoryForFolder((await d.from("store_files").select("folder_id").eq("id", f.id).single()).data.folder_id)).num]))
  ok(JSON.stringify(catAfter) === JSON.stringify(catBefore), "every old file keeps its category (effectiveKind / categoryForFolder): Documents category counts unchanged")
  const kindsAfter = await Promise.all(saved.map(async (f) => effectiveKind((await d.from("store_files").select("folder_id").eq("id", f.id).single()).data.folder_id)))
  ok(JSON.stringify(kindsAfter) === JSON.stringify(saved.map((f) => f.kind)), "…and the same effective folder kind (the archived Tax still counts as Tax, the archived year folder as a tax year)")
  const docsAfter = (await docsFor()).filter((x) => saved.some((f) => storePointer(f.id) === x.drive_file_id))
  ok(JSON.stringify(docsAfter) === JSON.stringify(docsBefore), "the CRM documents rows are byte-identical")
  let resolved = 0
  for (const f of saved) { const { data } = await d.from("store_files").select("id, state").eq("id", f.id).maybeSingle(); if (data?.state === "live") resolved++ }
  ok(resolved === saved.length, "every store:<file id> pointer still resolves to a live file")

  // ── 5. undo over the API (the new Company folder holds a file now: refused), then after removing nothing it stays refused
  const refused = await d.rpc("store_undo_name_change_for_account", { p_account_id: acct.id, p_change_id: changeId, p_actor: null, p_dry_run: false })
  ok(!!refused.error && /can no longer be undone|already hold files/.test(refused.error.message), `undo refused once the new folders hold a file (${refused.error?.message})`)
  console.log(failures ? `\n${failures} FAILED` : "\nall passed")
  process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2) })
