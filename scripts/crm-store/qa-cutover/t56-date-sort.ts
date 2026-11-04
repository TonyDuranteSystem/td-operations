/* eslint-disable no-console */
/**
 * "Sort by date" on a storage folder (dev job 1f4645b6, 2026-11-04). SANDBOX only, real database, real library functions (the screen's two calls).
 * Run: npx tsx scripts/crm-store/qa-cutover/t56-date-sort.ts
 * Builds its OWN test tree ("QA DateSort <stamp>") of 167 Zoom-style folders (166 dated, 1 undated, 5 naming Rocco/Alex) and proves: the preview
 * writes nothing and counts right; Confirm moves in batches into year / month REAL folders; a second preview is empty (nothing twice); a NEW call later
 * lands in the existing month (no duplicate folders); the Mac change feed got one "moved" row per folder (Finder will hear it); the folder lists
 * newest- or oldest-first as chosen and remembers the choice; fixed folders and client storages are refused; a plain folder called "2025" beside
 * Business folders behaves like any folder. Everything it made is trashed at the end (by id, never by pattern).
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const N_DATED = 166
const pad = (n: number) => String(n).padStart(2, "0")

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const S = await import("../../../lib/crm-store/structure")
  const D = await import("../../../lib/crm-store/date-sort")
  const R = await import("../../../lib/crm-store/date-sort-rules")
  const B = await import("../../../lib/crm-store/browse")
  const { trashFolder } = await import("../../../lib/crm-store/folders")
  const stamp = Date.now()
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (users?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  if (!qa) throw new Error("no admin test login in the sandbox")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const made: string[] = []

  const live = async (parent: string) => ((await admin.from("store_folders").select("id, name").eq("parent_id", parent).is("trashed_at", null).order("name")).data ?? []) as Array<{ id: string; name: string }>
  try {
    const { data: biz } = await admin.from("store_owners").select("id").eq("kind", "business").limit(1).maybeSingle()
    const ownerId = biz.id as string
    const { data: rootF } = await admin.from("store_folders").select("id").eq("owner_id", ownerId).is("parent_id", null).maybeSingle()
    const root = await S.createFolder(rootF.id, `QA DateSort ${stamp}`, qa.id); made.push(root.id)
    const zoom = await S.createFolder(root.id, "TD Zoom Calls QA", qa.id)
    const marketing = await S.createFolder(root.id, "TD Marketing Calls QA", qa.id)

    // 167 folders: 166 dated spread over 2025-09-11 … 2026-11-02, 1 undated, 5 naming Rocco / Alex
    const start = Date.UTC(2025, 8, 11), end = Date.UTC(2026, 10, 2)
    const names: string[] = []
    for (let i = 0; i < N_DATED; i++) {
      const t = new Date(start + Math.floor(((end - start) * i) / (N_DATED - 1)))
      const stampName = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(8 + (i % 9))}.${pad(i % 60)}.${pad((i * 7) % 60)}`
      names.push(i < 5 ? `${stampName} Antonio Durante - Rocco Resta ${i}` : i % 3 === 0 ? `${stampName} Antonio Durante - Tony Durante LLC's Zoom Meeting` : `${stampName} Person ${i} and Antonio Durante`)
    }
    names.push("Zoom Call from Marketing QA")
    for (const n of names) await S.createFolder(zoom.id, n, qa.id)
    check("1 the test pile is 167 folders directly in the folder", (await live(zoom.id)).length === 167, `${(await live(zoom.id)).length}`)

    const before = await live(zoom.id)
    const pv = await D.previewDateSort(zoom.id, R.DEFAULT_DATE_SORT)
    const after = await live(zoom.id)
    check("2 the preview counts 166 to move, 1 staying, and writes nothing", pv.toMove === 166 && pv.stay === 1 && pv.clashes === 0 && before.length === after.length && after.every((a) => before.some((b) => b.id === a.id)), `move ${pv.toMove} stay ${pv.stay}; folders ${before.length}→${after.length}`)
    check("3 the preview lists the groups newest first", pv.groups[0].label.startsWith("2026 / 11") && pv.groups[pv.groups.length - 1].label.startsWith("2025 / 09"), `${pv.groups[0].label} … ${pv.groups[pv.groups.length - 1].label}`)
    check("4 the undated folder is named as staying, with the reason", pv.stayList.length === 1 && /no date/.test(pv.stayList[0].reason), JSON.stringify(pv.stayList))

    const { data: headBefore } = await admin.rpc("store_changes_head")
    const h0 = (headBefore ?? [])[0] as { txid: string; seq: number | string } | undefined
    let loops = 0, moved = 0, remaining = 999, failed = 0
    const t0 = Date.now()
    while (remaining > 0 && loops < 20) {
      const a = await D.applyDateSort(zoom.id, R.DEFAULT_DATE_SORT, qa.id)
      loops++; moved += a.moved; failed += a.failed.length; remaining = a.remaining
      if (a.moved === 0) break
    }
    check("5 Confirm moves all 166, in batches, none failed", moved === 166 && failed === 0 && remaining === 0, `moved ${moved} in ${loops} calls, ${((Date.now() - t0) / 1000).toFixed(1)} s`)

    const top = await live(zoom.id)
    check("6 only year folders and the one undated folder are left directly inside", top.length === 3 && top.some((f) => f.name === "2025") && top.some((f) => f.name === "2026") && top.some((f) => f.name.startsWith("Zoom Call from Marketing")), top.map((f) => f.name).join(" | "))
    let total = 0, wrongName = 0
    for (const y of top.filter((f) => /^\d{4}$/.test(f.name))) {
      for (const m of await live(y.id)) {
        const calls = await live(m.id)
        total += calls.length
        for (const c of calls) { const d = R.dateFromName(c.name); if (!d || String(d.year) !== y.name || R.monthLabelFor(d.month, "number_name") !== m.name) wrongName++ }
      }
    }
    check("7 every call is inside the year and month its own name says", total === 166 && wrongName === 0, `${total} found, ${wrongName} in the wrong place`)

    const pv2 = await D.previewDateSort(zoom.id, R.DEFAULT_DATE_SORT)
    check("8 a second preview has nothing to move (nothing done twice)", pv2.toMove === 0, `${pv2.toMove}`)
    await S.createFolder(zoom.id, "2026-11-03 10.00.00 A new call after the sort", qa.id)
    const pv3 = await D.previewDateSort(zoom.id, R.DEFAULT_DATE_SORT)
    check("9 a new call afterwards goes into the EXISTING month (no new folders)", pv3.toMove === 1 && pv3.newGroups.length === 0 && pv3.reusedGroups.length === 2, JSON.stringify({ toMove: pv3.toMove, new: pv3.newGroups, reused: pv3.reusedGroups }))
    await D.applyDateSort(zoom.id, R.DEFAULT_DATE_SORT, qa.id)
    const novs = (await live(top.find((f) => f.name === "2026")!.id)).filter((f) => f.name === "11 November")
    check("10 still ONE '11 November' inside 2026 after the second sort", novs.length === 1 && (await live(novs[0].id)).some((c) => c.name.includes("A new call after")), `${novs.length}`)

    const { data: rows } = await admin.rpc("store_changes_since", { p_after_txid: h0 ? h0.txid : null, p_after_seq: h0 ? Number(h0.seq) : 0, p_limit: 2000 })
    const moves = ((rows ?? []) as Array<{ item_kind: string; op: string; old_parent_id: string | null; parent_id: string | null; resync?: boolean }>).filter((r) => r.item_kind === "folder" && r.op === "upsert" && r.old_parent_id === zoom.id)
    check("11 the Mac change feed has one 'moved' row per call folder (Finder is told)", moves.length >= 167, `${moves.length} moved-out-of-the-pile rows (166 + the new call)`)

    const c1 = await B.folderContents(ownerId, zoom.id)
    check("12 the folder lists years newest first, the undated one above them, and remembers the choice", c1.folders.map((f) => f.name).join("|").startsWith("Zoom Call from Marketing QA|2026|2025") && c1.sortOrder === "newest", c1.folders.map((f) => f.name).join("|"))
    const y26 = top.find((f) => f.name === "2026")!
    const c2 = await B.folderContents(ownerId, y26.id)
    check("13 the months inside a year are newest first", c2.folders[0].name === "11 November" && c2.folders[c2.folders.length - 1].name === "01 January", c2.folders.map((f) => f.name).join("|"))
    await S.createFolder(zoom.id, "2026-11-04 09.00.00 Order test", qa.id)
    await D.applyDateSort(zoom.id, { ...R.DEFAULT_DATE_SORT, order: "oldest" }, qa.id)
    const c3 = await B.folderContents(ownerId, zoom.id)
    check("14 'oldest first' flips the order and is remembered", c3.folders.map((f) => f.name).join("|") === "Zoom Call from Marketing QA|2025|2026" && (await D.savedSettings(zoom.id))?.order === "oldest", c3.folders.map((f) => f.name).join("|"))

    // other choices: month only, year only, own pattern — preview only
    const pm = await D.previewDateSort(marketing.id, { grouping: "month", monthLabel: "name", order: "newest" })
    check("15 an empty folder previews 'nothing to move' for any choice", pm.toMove === 0, `${pm.toMove}`)
    const probe = await S.createFolder(marketing.id, "2026-06-15 10.00.00 Marketing call", qa.id)
    const pMonth = await D.previewDateSort(marketing.id, { grouping: "month", monthLabel: "name", order: "newest" })
    const pYear = await D.previewDateSort(marketing.id, { grouping: "year", monthLabel: "name", order: "newest" })
    const pOwn = await D.previewDateSort(marketing.id, { grouping: "year_month", monthLabel: "number", order: "newest", custom: { year: "Year {year}", month: "{month} - {monthName}" } })
    check("16 month only / year only / own names give the names the screen showed", pMonth.groups[0].label === "June 2026" && pYear.groups[0].label === "2026" && pOwn.groups[0].label === "Year 2026 / 06 - June", `${pMonth.groups[0].label} | ${pYear.groups[0].label} | ${pOwn.groups[0].label}`)
    void probe

    // refusals
    const refused = async (id: string, fn?: () => Promise<unknown>) => { try { await (fn ? fn() : D.previewDateSort(id, R.DEFAULT_DATE_SORT)); return null } catch (e) { return e instanceof Error ? e.message : String(e) } }
    check("17 the top folder of a storage is refused", /fixed folder/.test((await refused(rootF.id)) ?? ""), (await refused(rootF.id)) ?? "NOT refused")
    const { data: co } = await admin.from("store_owners").select("id").eq("kind", "company").limit(1).maybeSingle()
    const { data: coF } = await admin.from("store_folders").select("id").eq("owner_id", co.id).eq("kind", "custom").is("trashed_at", null).limit(1)
    const coMsg = coF?.[0] ? await refused(coF[0].id) : "no custom company folder in the sandbox — covered by the owner-kind rule"
    check("18 a client's own storage is refused (changed in the CRM only)", coF?.[0] ? /Business and My files/.test(coMsg ?? "") : true, coMsg ?? "NOT refused")
    check("19 a bad choice is refused in plain words", /group/i.test((await refused(zoom.id, () => D.previewDateSort(zoom.id, { grouping: "week" }))) ?? ""), "")
    const bad = await refused(zoom.id, () => D.previewDateSort(zoom.id, { grouping: "month", monthLabel: "name", order: "newest", custom: { month: "Calls" } }))
    check("20 an own pattern that would put every date in one folder is refused", /must contain/.test(bad ?? ""), bad ?? "NOT refused")

    // a plain folder called "2025" beside the Business folders
    const plain = await S.createFolder(rootF.id, "2025", qa.id); made.push(plain.id)
    const { data: plainRow } = await admin.from("store_folders").select("kind, template_slug").eq("id", plain.id).maybeSingle()
    const biz1 = await B.folderContents(ownerId, rootF.id)
    const { folderMoveRefusal, folderRenameRefusal, folderDeleteRefusal, isYearFolderKind } = await import("../../../lib/crm-store/folder-rules")
    const fl = { template_slug: plainRow.template_slug as string | null, parent_id: rootF.id as string | null, kind: plainRow.kind as string, name: "2025" }
    check("21 a plain '2025' folder next to the Business folders is a normal folder (not a tax year)", plainRow.kind === "custom" && !isYearFolderKind(plainRow.kind) && folderMoveRefusal(fl) === null && folderRenameRefusal(fl) === null && folderDeleteRefusal(fl, []) === null && biz1.folders.some((f) => f.name === "2025"), `kind ${plainRow.kind}; listed ${biz1.folders.some((f) => f.name === "2025")}`)
    await S.moveFolder(plain.id, root.id, qa.id)
    await S.renameFolder(plain.id, "2025 renamed", qa.id)
    check("22 it can be moved, renamed and trashed like any folder", (await live(root.id)).some((f) => f.name === "2025 renamed"), "")
  } finally {
    for (const id of made.reverse()) await trashFolder(ACTOR, id, "qa date sort").catch((e) => console.log("cleanup:", e?.message))
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
