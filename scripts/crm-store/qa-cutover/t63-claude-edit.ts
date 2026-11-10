/* eslint-disable no-console */
/**
 * Step 2 QA t63 (dev job bd21e833): Claude edits a file in Storage. SANDBOX only (refuses production). Runs the real server functions
 * (the same ones the MCP tools call) against the sandbox database + storage, on a throw-away QA file in the Uxio Test LLC fixture company.
 *   npx tsx scripts/crm-store/qa-cutover/t63-claude-edit.ts
 */
import { config } from "dotenv"
config({ path: ".env.local" })

let failed = 0
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`); if (!ok) failed++ }

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (url.includes("ydzipybqeebtpcvsbtvs") || !url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("not the sandbox — refusing")
  process.env.MY_FILES_ACCESS_ENABLED = "1"
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any; rpc: (f: string, a: unknown) => Promise<any> } // eslint-disable-line @typescript-eslint/no-explicit-any
  const { saveDocumentForAccount } = await import("../../../lib/crm-store/save-for-account")
  const { findStoreFiles, openStoreFile, editStoreFile, saveStoreFile, uploadUrlForStoreFile } = await import("../../../lib/crm-store/claude-edit")
  const { setClientVisibility } = await import("../../../lib/crm-store/browse")
  const { restoreVersion } = await import("../../../lib/crm-store/new-version")
  const { discardProposal } = await import("../../../lib/crm-store/proposals")
  const { listFileVersions } = await import("../../../lib/crm-store/browse")
  const { markFileSigned } = await import("../../../lib/crm-store/file-actions")
  const { trashFile } = await import("../../../lib/crm-store/folders")

  const caller = { method: "qa", email: "antonio.durante@tonydurante.us" }
  const ACCOUNT = "30c2cd96-03e4-43cf-9536-81d961b18b1d" // Uxio Test LLC (QA fixture)
  const tag = Date.now()
  const name = `QA claude edit ${tag}.md`
  const created: string[] = []

  const mk = async (n: string, text: string) => {
    const r = await saveDocumentForAccount({ accountId: ACCOUNT, name: n, bytes: Buffer.from(text), mimeType: "text/markdown", folder: "company", documentType: "other_document", callerKey: `qa-t63:${tag}:${n}`, portalVisible: false, row: { document_type_name: "Other", category: 1, category_name: "Company", status: "classified" } })
    if (r.route !== "store") throw new Error("the QA company is not in the new storage on this sandbox")
    const fileId = String(r.pointer).replace(/^store:/, "")
    created.push(fileId)
    return fileId
  }
  const text = (r: { ok: boolean }) => JSON.stringify(r)
  const versionsOf = async (id: string) => ((await sb.from("store_file_versions").select("version_no, unmerged, sha256").eq("file_id", id).order("version_no")).data ?? []) as Array<{ version_no: number; unmerged: boolean }>
  const currentNo = async (id: string) => ((await sb.from("store_files").select("store_file_versions!store_files_current_version_fk(version_no)").eq("id", id).maybeSingle()).data?.store_file_versions?.version_no ?? null) as number | null
  const contentOf = async (id: string) => { const r = await openStoreFile({ file_id: id }, caller); return r.ok ? (r as unknown as { content: string }).content : `ERR ${text(r)}` }

  const base = "# Plan\n\n## Part 1\nold text\n\n## Part 2\nmore\n"
  const id = await mk(name, base)

  // A — find
  const f = await findStoreFiles({ query: `QA claude edit ${tag}` }, caller)
  const found = f.ok ? (f as unknown as { files: Array<{ file_id: string; where: string; client_visible: boolean }> }).files.find((x) => x.file_id === id) : null
  check("A1 find: the file is found with its place", !!found && /Uxio Test LLC/.test(found.where), text(f))
  check("A2 find: it is not shown to the client", found?.client_visible === false)
  check("A3 find: a one-letter or wildcard query is refused", (await findStoreFiles({ query: "a" }, caller)).ok === false && (await findStoreFiles({ query: "%%" }, caller)).ok === false)

  // B — open
  const o = await openStoreFile({ file_id: id }, caller)
  const oo = o as unknown as { version_no: number; content: string; client_visible: boolean; lock: string | null; encoding: string }
  check("B1 open: text, version 1, no lock, hidden", o.ok && oo.encoding === "text" && oo.version_no === 1 && oo.content === base && oo.lock === null && oo.client_visible === false, text(o))

  // C — edit a hidden file: saved straight away as the next version
  const e1 = await editStoreFile({ file_id: id, base_version_no: 1, edits: [{ op: "replace", find: "old text", with: "new text" }, { op: "append", text: "\n## Part 3\nadded\n" }], why: "QA" }, caller)
  const e1o = e1 as unknown as { status: string; version_no: number }
  check("C1 edit: saved as version 2", e1.ok && e1o.status === "saved" && e1o.version_no === 2, text(e1))
  check("C2 edit: the new copy is current, the old one is kept", (await currentNo(id)) === 2 && (await versionsOf(id)).length === 2)
  check("C3 edit: the content is exactly the edited text", (await contentOf(id)) === "# Plan\n\n## Part 1\nnew text\n\n## Part 2\nmore\n\n## Part 3\nadded\n")
  const ev = (await sb.from("store_events").select("details").eq("file_id", id).eq("event", "version_added").order("id", { ascending: false }).limit(1)).data?.[0]?.details as { source?: string; note?: string; client_visible?: boolean } | undefined
  check("C4 history: source claude and a plain note", ev?.source === "claude" && /^Claude edit: /.test(ev?.note ?? ""), JSON.stringify(ev))

  // D — a bad instruction changes nothing
  const bad = await editStoreFile({ file_id: id, base_version_no: 2, edits: [{ op: "replace", find: "Part", with: "X" }] }, caller)
  check("D1 ambiguous match: refused, nothing saved", !bad.ok && /appears \d+ times/.test((bad as { error: string }).error) && (await versionsOf(id)).length === 2, text(bad))
  const missing = await editStoreFile({ file_id: id, base_version_no: 2, edits: [{ op: "replace", find: "nowhere", with: "X" }] }, caller)
  check("D2 not found: refused, nothing saved", !missing.ok && (await versionsOf(id)).length === 2)
  const noop = await editStoreFile({ file_id: id, base_version_no: 2, edits: [{ op: "replace", find: "added", with: "added" }] }, caller)
  check("D3 no change: nothing saved", noop.ok && (noop as unknown as { status: string }).status === "unchanged" && (await versionsOf(id)).length === 2, text(noop))
  const nover = await editStoreFile({ file_id: id, base_version_no: 9, edits: [{ op: "append", text: "x" }] }, caller)
  check("D4 a version that does not exist is refused", !nover.ok && /does not exist/.test((nover as { error: string }).error))

  // E — the file moved on: Claude's change is kept as a hidden not-applied version
  const stale = await editStoreFile({ file_id: id, base_version_no: 1, edits: [{ op: "append", text: "\nstale edit\n" }] }, caller)
  const so = stale as unknown as { status: string; version_no: number }
  check("E1 stale base: kept as not applied (v3)", stale.ok && so.status === "kept_not_applied" && so.version_no === 3, text(stale))
  check("E2 stale base: the current copy is untouched (still v2)", (await currentNo(id)) === 2 && (await versionsOf(id)).some((v) => v.version_no === 3 && v.unmerged))

  // F — a file the client can see: Claude only PROPOSES
  await setClientVisibility(id, true, null, { silent: true })
  const vis = await openStoreFile({ file_id: id }, caller)
  check("F1 open: now shows it is visible to the client", vis.ok && (vis as unknown as { client_visible: boolean }).client_visible === true)
  const prop = await editStoreFile({ file_id: id, base_version_no: 2, edits: [{ op: "replace", find: "added", with: "proposed" }], why: "QA proposal" }, caller)
  const po = prop as unknown as { status: string; version_no: number }
  check("F2 visible file: a PROPOSED version (v4), not applied", prop.ok && po.status === "proposed" && po.version_no === 4 && (await currentNo(id)) === 2, text(prop))
  check("F3 visible file: the client still sees the same current text", (await contentOf(id)).includes("added") && !(await contentOf(id)).includes("proposed"))
  const vlist = await listFileVersions(id)
  const v4 = vlist.find((v) => v.versionNo === 4)
  check("F4 version list: v4 is Claude's proposal with its note", v4?.by === "Claude" && v4.unmerged && /^Proposed by Claude: /.test(v4.note ?? ""), JSON.stringify(v4))
  const stillShown = ((await sb.from("documents").select("portal_visible").eq("drive_file_id", `store:${id}`)).data ?? []).some((r: { portal_visible: boolean }) => r.portal_visible)
  check("F5 visible file: still shown to the client after the proposal", stillShown)

  // G — accept the proposal and hide the file from the client in the same step
  const acc = await restoreVersion({ fileId: id, versionNo: 4, baseVersionNo: 2, actor: null, clientChoice: "hide" })
  check("G1 accept: becomes the current copy (v5)", acc.status === "versioned" && (await currentNo(id)) === 5, JSON.stringify(acc))
  check("G2 accept: the current text is the proposed text", (await contentOf(id)).includes("proposed"))
  const hiddenNow = !((await sb.from("documents").select("portal_visible").eq("drive_file_id", `store:${id}`)).data ?? []).some((r: { portal_visible: boolean }) => r.portal_visible)
  check("G3 accept + hide: the client no longer sees the file", hiddenNow)

  // H — discard a second proposal
  await setClientVisibility(id, true, null, { silent: true })
  const p2 = await editStoreFile({ file_id: id, base_version_no: 5, edits: [{ op: "append", text: "\nto discard\n" }] }, caller)
  const p2no = (p2 as unknown as { version_no: number }).version_no
  check("H1 second proposal saved", p2.ok && (p2 as unknown as { status: string }).status === "proposed", text(p2))
  const dis = await discardProposal({ fileId: id, versionNo: p2no, actor: null })
  check("H2 discard: reported as discarded", dis.status === "discarded", JSON.stringify(dis))
  check("H3 discard: the current copy is untouched", (await currentNo(id)) === 5)
  check("H4 discard: the version stays listed, marked discarded", (await listFileVersions(id)).find((v) => v.versionNo === p2no)?.discarded === true)
  check("H5 discard twice: says already", (await discardProposal({ fileId: id, versionNo: p2no, actor: null })).status === "already")
  check("H6 discard the current copy: refused", (await discardProposal({ fileId: id, versionNo: 5, actor: null })).status === "refused")

  // I — a signed file is never changed
  const sid = await mk(`QA claude signed ${tag}.md`, "signed text\n")
  await markFileSigned(sid, null)
  const sg = await editStoreFile({ file_id: sid, base_version_no: 1, edits: [{ op: "append", text: "x" }] }, caller)
  check("I1 signed: refused in plain words", !sg.ok && /signed/.test((sg as { error: string }).error), text(sg))
  check("I2 signed: nothing was saved", (await versionsOf(sid)).length === 1)
  const sgs = await saveStoreFile({ file_id: sid, base_version_no: 1, content_base64: Buffer.from("other").toString("base64") }, caller)
  check("I3 signed: a whole-file save is refused too", !sgs.ok)

  // J — whole-file save
  const wid = await mk(`QA claude whole ${tag}.md`, "x".repeat(12000))
  const w1 = await saveStoreFile({ file_id: wid, base_version_no: 1, content_base64: Buffer.from("y".repeat(11000)).toString("base64"), why: "QA whole" }, caller)
  check("J1 whole file: saved as v2", w1.ok && (w1 as unknown as { status: string; version_no: number }).version_no === 2, text(w1))
  const w2 = await saveStoreFile({ file_id: wid, base_version_no: 2, content_base64: Buffer.from("tiny").toString("base64") }, caller)
  check("J2 much smaller: asks for confirmation, nothing saved", !w2.ok && /accept_warnings/.test((w2 as { error: string }).error) && (await currentNo(wid)) === 2, text(w2))
  const w3 = await saveStoreFile({ file_id: wid, base_version_no: 2, content_base64: Buffer.from("tiny").toString("base64"), accept_warnings: true }, caller)
  check("J3 confirmed: saved as v3", w3.ok && (w3 as unknown as { version_no: number }).version_no === 3)
  check("J4 both or neither of content / staged is refused", !(await saveStoreFile({ file_id: wid, base_version_no: 3 }, caller)).ok)
  check("J5 a staged path outside Claude's own folder is refused", !(await saveStoreFile({ file_id: wid, base_version_no: 3, staged_path: "crm-uploads/store-staging/other/x" }, caller)).ok && !(await saveStoreFile({ file_id: wid, base_version_no: 3, staged_path: "crm-uploads/store-staging/claude/../x" }, caller)).ok)

  // K — the upload link for a bigger file
  const up = await uploadUrlForStoreFile({ file_id: wid }, caller)
  const uo = up as unknown as { upload_url: string; staged_path: string }
  check("K1 upload link returned inside Claude's folder", up.ok && uo.staged_path.startsWith("crm-uploads/store-staging/claude/"), text(up))
  if (up.ok) {
    const put = await fetch(uo.upload_url, { method: "PUT", headers: { "Content-Type": "text/markdown" }, body: Buffer.from("z".repeat(500)) })
    check("K2 bytes uploaded to the link", put.ok, `HTTP ${put.status}`)
    const sv = await saveStoreFile({ file_id: wid, base_version_no: 3, staged_path: uo.staged_path, why: "QA staged" }, caller)
    check("K3 staged save: saved as v4", sv.ok && (sv as unknown as { version_no: number }).version_no === 4, text(sv))
    const gone = await sb.storage.from("onboarding-uploads").download(uo.staged_path)
    check("K4 staged save: the staged upload is removed", !!gone.error)
  }

  // L — reach: a study copy and somebody else's My files are not reachable
  const { data: study } = await sb.from("store_files").select("id, store_owners!inner(study_only, kind)").eq("state", "live").eq("store_owners.study_only", true).limit(1)
  if (study?.[0]) check("L1 a hidden study copy is not reachable", !(await openStoreFile({ file_id: study[0].id }, caller)).ok)
  else console.log("SKIP  L1 (no study copy on this sandbox)")
  const { data: priv } = await sb.from("store_files").select("id, store_owners!inner(kind, private_user_id)").eq("state", "live").eq("store_owners.kind", "private").limit(40)
  const { ownersAreaUserId } = await import("../../../lib/crm-store/structure")
  const mine = await ownersAreaUserId()
  const foreign = (priv ?? []).find((r: { store_owners: { private_user_id: string } }) => r.store_owners.private_user_id !== mine)
  if (foreign) check("L2 another person's My files is not reachable", !(await openStoreFile({ file_id: foreign.id }, caller)).ok)
  else console.log("SKIP  L2 (no other private area on this sandbox)")
  check("L3 a made-up id is refused like a missing one", !(await openStoreFile({ file_id: "0f8fad5b-d9cb-469f-a165-70867728950e" }, caller)).ok && !(await openStoreFile({ file_id: "nope" }, caller)).ok)

  // M — the switch
  delete process.env.MY_FILES_ACCESS_ENABLED
  check("M1 switched off: refused", !(await openStoreFile({ file_id: id }, caller)).ok)
  process.env.MY_FILES_ACCESS_ENABLED = "1"

  // clean up the QA files (exact ids this run made)
  for (const fid of created) { try { await trashFile({ id: "00000000-0000-0000-0000-000000000000", app_metadata: { role: "admin" } } as never, fid, "QA t63 cleanup") } catch (e) { console.log("cleanup:", e instanceof Error ? e.message : e) } }

  console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
