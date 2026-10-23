/* eslint-disable no-console */
/**
 * QA t52 — My files ACCESS (full read/write for the owner's Claude sessions, 2026-10-23). LOCAL stack / SANDBOX only. Calls the real server functions against a real
 * database + storage: list / read / write (3 modes) / folders / rename / move / trash / restore, and every boundary (Shared with staff read-only, foreign ids,
 * locked folders, limits, audit, nothing deleted for good).
 *   npx tsx scripts/crm-store/qa-cutover/t52-my-files-access.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const A = await import("../../../lib/crm-store/my-files-access")
  const { ensureArea, ownersAreaUserId } = await import("../../../lib/crm-store/structure")
  const { saveBytesToStore } = await import("../../../lib/crm-store/writer")
  const { PRIMARY_OWNER_EMAIL } = await import("../../../lib/auth")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; rpc: (f: string, a: unknown) => Promise<any>; auth: any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const caller = { method: "static", email: PRIMARY_OWNER_EMAIL }
  const tag = `${Date.now()}`.slice(-8)
  const T = `QA Access ${tag}`

  // the local stack may not have the store's buckets yet (the migration that makes them has not run there)
  if (/127\.0\.0\.1|localhost/.test(url)) {
    for (const b of ["crm-store", "crm-store-staging"]) await sb.storage.createBucket(b, { public: false })
  }
  // earlier runs inside the hour would eat the real hourly limits: start from a clean count (local stack / sandbox rows of THIS tool only)
  await sb.from("action_log").delete().like("action_type", "my_files_%")
  let uid = await ownersAreaUserId()
  if (!uid) {
    if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error("the owner login does not exist here and this is not the local stack")
    const { data, error } = await sb.auth.admin.createUser({ email: PRIMARY_OWNER_EMAIL, password: `Qa-${tag}-xY9!`, email_confirm: true })
    if (error) throw error
    uid = data.user.id
    console.log("(created the owner login on the local stack)")
  }
  const ownerId = (await ensureArea("private", uid)) as string
  const { data: root } = await sb.from("store_folders").select("id").eq("owner_id", ownerId).is("parent_id", null).maybeSingle()
  const { data: share } = await sb.from("store_folders").select("id, name").eq("owner_id", ownerId).eq("kind", "staff_share").is("trashed_at", null).maybeSingle()
  if (!share) throw new Error("no Shared with staff folder in the private area")
  const { data: others } = await sb.from("store_owners").select("id").eq("kind", "private").neq("id", ownerId)
  const countOthers = async () => ((others ?? []).length ? ((await sb.from("store_files").select("id", { count: "exact", head: true }).in("owner_id", (others ?? []).map((o: { id: string }) => o.id))).count as number) : 0)
  const othersBefore = await countOthers()
  const purgedBefore = ((await sb.from("store_files").select("id", { count: "exact", head: true }).eq("state", "purged")).count as number) ?? 0
  const need = <R extends { ok: boolean }>(r: R): Extract<R, { ok: true }> => { if (!r.ok) throw new Error(JSON.stringify(r)); return r as never }
  const fail = (r: { ok: boolean; error?: string }) => (r.ok === false ? r.error ?? "" : "(unexpectedly ok)")

  // A0 switch off
  delete process.env.MY_FILES_ACCESS_ENABLED
  const off = await A.listMyFiles({}, caller)
  check("A0 switched off: every call refused", !off.ok && /switched off/.test(fail(off)))
  process.env.MY_FILES_ACCESS_ENABLED = "1"

  // A1 write → list → read
  const w1 = need(await A.writeMyFile({ path: `${T}/Plans`, name: "plan.md", text: "# v1\nhello" }, caller))
  check("A1 write creates the folders and the file", w1.status === "created" && w1.path === `${T}/Plans/plan.md`, JSON.stringify(w1))
  const l1 = need(await A.listMyFiles({ path: `${T}/Plans` }, caller))
  check("A2 list shows the file with an id and size", l1.entries.some((e) => e.type === "file" && e.name === "plan.md" && e.id === w1.file_id && e.size === 10), JSON.stringify(l1.entries))
  const top = need(await A.listMyFiles({}, caller))
  check("A3 the top lists the new folder and the read-only Shared with staff", top.entries.some((e) => e.type === "folder" && e.name === T) && top.entries.some((e) => e.type === "folder" && e.kind === "staff_share"))
  const rd = need(await A.readMyFile({ file_id: w1.file_id }, caller))
  check("A4 read returns the text", rd.encoding === "text" && rd.content === "# v1\nhello" && !rd.cut, JSON.stringify(rd).slice(0, 200))

  // A5 write modes
  const again = await A.writeMyFile({ path: `${T}/Plans`, name: "plan.md", text: "# v2" }, caller)
  check("A5 default (refuse): same name is refused, the file is untouched", !again.ok && /already exists/.test(fail(again)) && need(await A.readMyFile({ file_id: w1.file_id }, caller)).content === "# v1\nhello")
  const cp = need(await A.writeMyFile({ path: `${T}/Plans`, name: "plan.md", text: "# copy", if_exists: "copy" }, caller))
  check("A6 copy: saved as (2), first file untouched", cp.name === "plan (2).md" && cp.file_id !== w1.file_id, JSON.stringify(cp))
  const nv = need(await A.writeMyFile({ path: `${T}/Plans`, name: "plan.md", text: "# v2 new version", if_exists: "new_version" }, caller))
  const { data: vers } = await sb.from("store_file_versions").select("id").eq("file_id", w1.file_id)
  check("A7 new_version: same file, 2 versions, read returns the new text", nv.status === "versioned" && nv.file_id === w1.file_id && (vers ?? []).length === 2 && need(await A.readMyFile({ file_id: w1.file_id }, caller)).content === "# v2 new version", JSON.stringify(nv))
  const same = need(await A.writeMyFile({ path: `${T}/Plans`, name: "plan.md", text: "# v2 new version", if_exists: "new_version" }, caller))
  check("A8 new_version with the same content: unchanged, still 2 versions", same.status === "unchanged" && ((await sb.from("store_file_versions").select("id").eq("file_id", w1.file_id)).data ?? []).length === 2)

  // A9 binary
  const png = need(await A.writeMyFile({ path: T, name: "dot.png", content_base64: PNG }, caller))
  const rb = await A.readMyFile({ file_id: png.file_id }, caller)
  const rb64 = need(await A.readMyFile({ file_id: png.file_id, as_base64: true }, caller))
  check("A9 binary: refused without as_base64, base64 round-trips with it", !rb.ok && rb64.encoding === "base64" && rb64.content === PNG, fail(rb))

  // A10 folders, rename, move
  const nf = need(await A.newMyFolder({ path: `${T}/Archive` }, caller))
  const nf2 = need(await A.newMyFolder({ path: `${T}/Archive` }, caller))
  check("A10 new_folder: created, then 'already existed'", nf.path === `${T}/Archive` && /ready/i.test(nf.note) && /already/i.test(nf2.note) && nf2.folder_id === nf.folder_id)
  const rn = need(await A.renameMyItem({ file_id: cp.file_id, new_name: "plan copy" }, caller))
  check("A11 rename a file keeps the extension", rn.name === "plan copy.md", JSON.stringify(rn))
  const rnf = need(await A.renameMyItem({ folder_id: nf.folder_id, new_name: "Old stuff" }, caller))
  check("A12 rename a folder", rnf.name === "Old stuff")
  const mv = need(await A.moveMyItem({ file_id: cp.file_id, to_path: `${T}/Old stuff` }, caller))
  const l2 = need(await A.listMyFiles({ path: `${T}/Old stuff` }, caller))
  check("A13 move a file: it is in the new folder", mv.to === `${T}/Old stuff` && l2.entries.some((e) => e.id === cp.file_id))
  const mvf = need(await A.moveMyItem({ folder_id: nf.folder_id, to_path: `${T}/Plans` }, caller))
  check("A14 move a folder into another", /Moved/.test(mvf.note) && need(await A.listMyFiles({ path: `${T}/Plans/Old stuff` }, caller)).entries.some((e) => e.id === cp.file_id))
  const clash = await A.renameMyItem({ file_id: png.file_id, new_name: "dot" }, caller)
  check("A15 rename to a name that exists is refused only if it clashes (same name here = fine)", clash.ok, fail(clash))

  // A16 trash + restore (a file)
  const tr = need(await A.trashMyItem({ file_id: cp.file_id }, caller))
  const l3 = need(await A.listMyFiles({ path: `${T}/Plans/Old stuff` }, caller))
  const tl = need(await A.trashListMy(caller))
  check("A16 trash: gone from the list, in the trash list with a batch id, the row is state=trashed (not deleted)",
    !!tr.batch_id && !l3.entries.some((e) => e.id === cp.file_id) && tl.entries.some((e) => e.batch_id === tr.batch_id) && (await sb.from("store_files").select("state").eq("id", cp.file_id).maybeSingle()).data?.state === "trashed")
  const rdT = await A.readMyFile({ file_id: cp.file_id }, caller)
  check("A17 a trashed file cannot be read or renamed", !rdT.ok && !(await A.renameMyItem({ file_id: cp.file_id, new_name: "x" }, caller)).ok)
  const rs = need(await A.restoreMy({ batch_id: tr.batch_id as string }, caller))
  check("A18 restore brings it back to the same place", rs.restored.length >= 1 && need(await A.listMyFiles({ path: `${T}/Plans/Old stuff` }, caller)).entries.some((e) => e.id === cp.file_id), JSON.stringify(rs))
  // A19 trash + restore a folder with files
  const trf = need(await A.trashMyItem({ folder_id: nf.folder_id }, caller))
  check("A19 trash a folder: its file goes with it", !!trf.batch_id && /1 file/.test(trf.note) && (await sb.from("store_files").select("state").eq("id", cp.file_id).maybeSingle()).data?.state === "trashed", JSON.stringify(trf))
  need(await A.restoreMy({ batch_id: trf.batch_id as string }, caller))
  check("A20 restore the folder: file live again", (await sb.from("store_files").select("state").eq("id", cp.file_id).maybeSingle()).data?.state === "live")
  const rs2 = await A.restoreMy({ batch_id: trf.batch_id as string }, caller)
  check("A21 restoring twice is refused", !rs2.ok, fail(rs2))

  // A22 Shared with staff is READ-ONLY
  const { data: sf } = await saveBytesToStore({ ownerId, folderId: share.id, name: `shared ${tag}.txt`, mimeType: "text/plain", callerKey: `qa-t52:${tag}:share`, contentChanged: false, published: false, actor: null, documentType: null, skipAnalysis: true, bytes: Buffer.from("staff can read this") }).then((r) => ({ data: r }))
  const lsh = need(await A.listMyFiles({ path: "Shared with staff" }, caller))
  const rsh = need(await A.readMyFile({ file_id: sf.fileId }, caller))
  check("A22 Shared with staff: listing + reading work, flagged read-only", lsh.read_only && lsh.entries.some((e) => e.id === sf.fileId) && rsh.content === "staff can read this")
  const shSub = await sb.rpc("store_ensure_folder_path", { p_owner: ownerId, p_parent: share.id, p_path: ["SubA"], p_actor: uid })
  const lshSub = await A.listMyFiles({ path: "Shared with staff/SubA" }, caller)
  check("A22a a sub-folder of Shared with staff can be listed by path, flagged read-only", lshSub.ok && lshSub.read_only && !shSub.error, fail(lshSub))
  await sb.rpc("store_trash_folder", { p_folder_id: shSub.data, p_actor: uid, p_reason: "QA t52 tidy" })
  const wsh = await A.writeMyFile({ path: "Shared with staff", name: "x.md", text: "no" }, caller)
  const wsh2 = await A.writeMyFile({ path: "shared WITH staff/Sub", name: "x.md", text: "no" }, caller)
  const nfs = await A.newMyFolder({ path: "Shared with staff/Sub" }, caller)
  const mvIn = await A.moveMyItem({ file_id: w1.file_id, to_path: "Shared with staff" }, caller)
  const mvOut = await A.moveMyItem({ file_id: sf.fileId, to_path: T }, caller)
  const rnSh = await A.renameMyItem({ file_id: sf.fileId, new_name: "other" }, caller)
  const trSh = await A.trashMyItem({ file_id: sf.fileId }, caller)
  const trShF = await A.trashMyItem({ folder_id: share.id }, caller)
  const rnShF = await A.renameMyItem({ folder_id: share.id, new_name: "Mine" }, caller)
  check("A23 nothing can be written, made, moved in/out, renamed or trashed in Shared with staff",
    [wsh, wsh2, nfs, mvIn, mvOut, rnSh, trSh, trShF, rnShF].every((r) => !r.ok && /Shared with staff/.test(fail(r))), [wsh, wsh2, nfs, mvIn, mvOut, rnSh, trSh, trShF, rnShF].map(fail).join(" | "))
  check("A24 the share is unchanged after all that", (await sb.from("store_files").select("state, folder_id, name").eq("id", sf.fileId).maybeSingle()).data?.state === "live" && (await sb.from("store_folders").select("id").eq("parent_id", share.id).is("trashed_at", null)).data?.length === 0)
  // restore of a batch that came out of the share
  const batch = (await sb.rpc("store_trash_file", { p_file_id: sf.fileId, p_actor: uid, p_reason: "QA t52 (by hand)" })).data as string
  const rsSh = await A.restoreMy({ batch_id: batch }, caller)
  check("A25 a trash entry that came from Shared with staff is not restored by Claude", !rsSh.ok && /Shared with staff/.test(fail(rsSh)), fail(rsSh))

  // A26 foreign ids
  const bizId = (await ensureArea("business", null)) as string
  const { data: bizRoot } = await sb.from("store_folders").select("id").eq("owner_id", bizId).is("parent_id", null).maybeSingle()
  const biz = await saveBytesToStore({ ownerId: bizId, folderId: bizRoot.id, name: `biz ${tag}.txt`, mimeType: "text/plain", callerKey: `qa-t52:${tag}:biz`, contentChanged: false, published: false, actor: null, documentType: null, skipAnalysis: true, bytes: Buffer.from("business secret") })
  const foreign = [
    await A.readMyFile({ file_id: biz.fileId }, caller), await A.renameMyItem({ file_id: biz.fileId, new_name: "x" }, caller), await A.moveMyItem({ file_id: biz.fileId, to_path: T }, caller),
    await A.trashMyItem({ file_id: biz.fileId }, caller), await A.listMyFiles({ folder_id: bizRoot.id }, caller), await A.trashMyItem({ folder_id: bizRoot.id }, caller),
    await A.moveMyItem({ file_id: w1.file_id, to_path: "Business" }, caller),
  ]
  check("A26 a file/folder of another area is 'not found' for every tool (the same words as a missing id)", foreign.slice(0, 6).every((r) => !r.ok && /Not found/.test(fail(r))), foreign.map(fail).join(" | "))
  check("A27 the Business file is untouched and no file was created outside My files", (await sb.from("store_files").select("state, name").eq("id", biz.fileId).maybeSingle()).data?.state === "live" && (await countOthers()) === othersBefore)
  // A28a a file bigger than the read limit is refused BEFORE it is downloaded
  const bigSaved = await saveBytesToStore({ ownerId, folderId: root.id, name: `big ${tag}.txt`, mimeType: "text/plain", callerKey: `qa-t52:${tag}:big`, contentChanged: false, published: false, actor: null, documentType: null, skipAnalysis: true, bytes: Buffer.alloc(26 * 1024 * 1024, 97) })
  const bigRead = await A.readMyFile({ file_id: bigSaved.fileId }, caller)
  check("A28a a 26 MB file is refused for a read, before it is downloaded", !bigRead.ok && /too big to read/.test(fail(bigRead)), fail(bigRead))
  const ghost = await A.readMyFile({ file_id: "00000000-0000-4000-8000-000000000000" }, caller)
  check("A28 an id that does not exist says the same", !ghost.ok && /Not found/.test(fail(ghost)))

  // A29 fixed folders and the top
  const lockedTrash = await A.trashMyItem({ folder_id: root.id }, caller)
  const lockedRename = await A.renameMyItem({ folder_id: root.id, new_name: "Mine" }, caller)
  check("A29 the My files top can't be renamed or trashed", !lockedTrash.ok && !lockedRename.ok, `${fail(lockedTrash)} | ${fail(lockedRename)}`)
  const bad = [
    await A.writeMyFile({ path: T, name: "x.html", text: "<b>" }, caller), await A.writeMyFile({ path: "../x", name: "x.md", text: "a" }, caller),
    await A.writeMyFile({ path: T, name: "x.csv", text: "a\n=HYPERLINK(\"http://x\")" }, caller), await A.writeMyFile({ path: T, name: "x.md", text: "a".repeat(3 * 1024 * 1024 + 1) }, caller),
  ]
  check("A30 content rules still hold (html, traversal, formula csv, too big)", bad.every((r) => !r.ok), bad.map(fail).join(" | "))

  // A31 the audit
  const { data: audit } = await sb.from("action_log").select("action_type, summary, details").like("action_type", "my_files_%").gte("created_at", new Date(Date.now() - 600_000).toISOString())
  const rows = (audit ?? []) as Array<{ action_type: string; summary: string; details: Record<string, unknown> }>
  check("A31 every call left an audit row with who/how and the untrusted flag", rows.length >= 30 && rows.every((r) => r.details.untrusted_ai_content === true && r.details.caller_email === caller.email && r.details.auth_method === "static"), `${rows.length} rows`)
  check("A32 outcomes are recorded (done and refused both)", rows.some((r) => r.details.outcome === "done") && rows.some((r) => String(r.details.outcome).startsWith("refused")) && !rows.some((r) => r.details.outcome === "started"), JSON.stringify(Array.from(new Set(rows.map((r) => String(r.details.outcome).slice(0, 20))))))
  check("A33 write rows carry size + sha256", rows.filter((r) => r.action_type === "my_files_change" && r.summary.startsWith("my_files_write: write")).every((r) => typeof r.details.size === "number" && typeof r.details.sha256 === "string"))

  // A34 limits (rows inserted by hand, removed after)
  const stamp = new Date().toISOString()
  const fakeRows = Array.from({ length: 80 }, () => ({ actor: "qa-t52", action_type: "my_files_change", table_name: "store_files", summary: "qa filler", details: { size: 0 }, created_at: stamp }))
  const ins = await sb.from("action_log").insert(fakeRows).select("id")
  const lim = await A.newMyFolder({ path: `${T}/Limit` }, caller)
  const stillRead = await A.listMyFiles({ path: T }, caller)
  check("A34 at 80 changes in the hour: changes refused, reads still work", !lim.ok && /Too many changes/.test(fail(lim)) && stillRead.ok, fail(lim))
  await sb.from("action_log").delete().in("id", (ins.data ?? []).map((r: { id: string }) => r.id))
  // A34a parallel calls cannot all pass the same count: 79 used, 10 at once, at most one gets through
  const f79 = await sb.from("action_log").insert(Array.from({ length: 79 }, () => ({ actor: "qa-t52", action_type: "my_files_change", table_name: "store_files", summary: "qa filler", details: { size: 0 } }))).select("id")
  const par = await Promise.all(Array.from({ length: 10 }, (_, i) => A.newMyFolder({ path: `${T}/Par${i}` }, caller)))
  check("A34a 79 used + 10 parallel calls: at most 1 succeeds", par.filter((r) => r.ok).length <= 1, `${par.filter((r) => r.ok).length} ok`)
  await sb.from("action_log").delete().in("id", (f79.data ?? []).map((r: { id: string }) => r.id))
  await sb.from("action_log").delete().eq("actor", "claude.mcp").like("summary", "my_files_new_folder%")
  const big = await sb.from("action_log").insert({ actor: "qa-t52", action_type: "my_files_change", table_name: "store_files", summary: "qa filler", details: { size: 59 * 1024 * 1024 } }).select("id").single()
  const lim2 = await A.writeMyFile({ path: T, name: "bytes.md", text: "x".repeat(2 * 1024 * 1024) }, caller)
  check("A35 at 59 MB written in the hour, a 2 MB write is refused", !lim2.ok && /Too much written/.test(fail(lim2)), fail(lim2))
  await sb.from("action_log").delete().eq("id", big.data.id)
  const okAgain = await A.writeMyFile({ path: T, name: "bytes.md", text: "back to normal" }, caller)
  check("A36 once the filler rows are gone, writes work again", okAgain.ok, fail(okAgain))

  // A37 nothing was ever deleted for good
  const { count: purged } = await sb.from("store_files").select("id", { count: "exact", head: true }).eq("state", "purged")
  check("A37 no file was purged during the run", (purged ?? 0) === purgedBefore, `${purgedBefore} -> ${purged}`)
  check("A38 no other private area received anything", (await countOthers()) === othersBefore)

  await A.trashMyItem({ file_id: bigSaved.fileId }, caller).catch(() => {})
  // tidy: trash the QA folder (restorable), leave the audit rows
  await A.trashMyItem({ folder_id: (need(await A.listMyFiles({}, caller)).entries.find((e) => e.name === T) as { id: string }).id }, caller).catch(() => {})
  summary(); process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
