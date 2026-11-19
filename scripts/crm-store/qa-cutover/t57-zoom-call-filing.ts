/* eslint-disable no-console */
/**
 * Filing Zoom call folders into TD Zoom Calls › year › month (dev job 1f4645b6, 2026-11-11). SANDBOX only, real database, the REAL library functions the cron runs.
 * Run: npx tsx scripts/crm-store/qa-cutover/t57-zoom-call-filing.ts
 * Builds its OWN test tree ("QA ZoomFiling <stamp>") with a "Zoom Calls" folder holding TD Zoom Calls (year / month groups already there), TD Marketing Calls and
 * eight call folders dated 2031 (far from any real data): a Calendly-booked call (a real lead + lead_calls row), two calls started straight from Zoom, a call inside
 * a marketing booking (the booking is injected: the sandbox has no marketing team), a call with an upload still open, a call with a same-name clash, a plain folder
 * that is not a call. It proves: the switch off / dry run change nothing; a fresh folder waits; once quiet each call lands in the right place; the existing year /
 * month groups are reused; the activity log says where each call came from; the Mac change feed hears every move; a second run does nothing. Everything it made
 * is trashed / deleted at the end (by id, never by pattern).
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const S = await import("../../../lib/crm-store/structure")
  const F = await import("../../../lib/crm-store/zoom-call-filing")
  const R = await import("../../../lib/crm-store/zoom-call-filing-rules")
  const { trashFolder } = await import("../../../lib/crm-store/folders")
  const stamp = Date.now()
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (users?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  if (!qa) throw new Error("no admin test login in the sandbox")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const made: string[] = []
  const leadIds: string[] = []
  const callIds: string[] = []
  const intentIds: string[] = []

  const live = async (parent: string) => ((await admin.from("store_folders").select("id, name").eq("parent_id", parent).is("trashed_at", null).order("name")).data ?? []) as Array<{ id: string; name: string }>
  const parentOf = async (id: string) => ((await admin.from("store_folders").select("parent_id").eq("id", id).maybeSingle()).data?.parent_id ?? null) as string | null
  const nameOf = async (id: string | null) => (id ? (((await admin.from("store_folders").select("name").eq("id", id).maybeSingle()).data?.name ?? "?") as string) : "-")
  const pathOf = async (id: string, stopAt: string): Promise<string> => { const out: string[] = []; let cur: string | null = await parentOf(id); for (let i = 0; i < 8 && cur && cur !== stopAt; i++) { out.unshift(await nameOf(cur)); cur = await parentOf(cur) } return out.join(" / ") }   // where the folder SITS, below the Zoom Calls folder

  try {
    const { data: biz } = await admin.from("store_owners").select("id").eq("kind", "business").limit(1).maybeSingle()
    const ownerId = biz.id as string
    const { data: rootF } = await admin.from("store_folders").select("id").eq("owner_id", ownerId).is("parent_id", null).maybeSingle()
    const root = await S.createFolder(rootF.id, `QA ZoomFiling ${stamp}`, qa.id); made.push(root.id)
    const zc = await S.createFolder(root.id, "Zoom Calls", qa.id)
    const td = await S.createFolder(zc.id, "TD Zoom Calls", qa.id)
    const mk = await S.createFolder(zc.id, "TD Marketing Calls", qa.id)
    const y2031 = await S.createFolder(td.id, "2031", qa.id)
    const m03 = await S.createFolder(y2031.id, "03 March", qa.id)
    await admin.from("store_folders").update({ date_sort: { grouping: "year_month", monthLabel: "number_name", order: "newest" } }).eq("id", td.id)

    // a real lead + a real Calendly booking row for the Luca-style call (2031-03-04 09:00:57 New York = 14:00:57 UTC, winter time)
    const lead = await admin.from("leads").insert({ full_name: `QA ZoomFiling Luca ${stamp}` }).select("id").single()
    if (lead.error) throw new Error(`could not make the test lead: ${lead.error.message}`)
    leadIds.push(lead.data.id)
    const call = await admin.from("lead_calls").insert({ lead_id: lead.data.id, scheduled_start: "2031-03-04T14:00:00Z", state: "scheduled", source: "calendly", calendly_event_uri: `https://api.calendly.com/scheduled_events/qa-zf-${stamp}` }).select("id").single()
    if (call.error) throw new Error(`could not make the test booking: ${call.error.message}`)
    callIds.push(call.data.id)

    const nCalendly = await S.createFolder(zc.id, `2031-03-04 09.00.57 QA Luca ${stamp} and Antonio Durante`, qa.id)
    const nZoom1 = await S.createFolder(zc.id, "2031-03-05 08.10.00 Antonio Durante - Tony Durante LLC's Zoom Meeting", qa.id)
    const nZoom2 = await S.createFolder(zc.id, "2031-04-02 15.20.00 Antonio Durante - Tony Durante LLC's Zoom Meeting", qa.id)
    const nMarketing = await S.createFolder(zc.id, "2031-03-06 11.00.00 QA marketing call", qa.id)
    const nUploading = await S.createFolder(zc.id, "2031-03-07 09.30.00 QA upload still open", qa.id)
    const nClash = await S.createFolder(zc.id, "2031-03-08 10.00.00 QA clash", qa.id)
    const nNotCall = await S.createFolder(zc.id, "QA plain folder not a call", qa.id)
    await S.createFolder(mk.id, "2031-03-08 10.00.00 QA clash", qa.id)   // the marketing folder already holds a folder of that name, and it is not sorted: a real, stable clash

    // an upload that is still open for the "upload" call
    const intent = await admin.from("store_upload_intents").insert({ owner_id: ownerId, folder_id: nUploading.id, created_by: qa.id, file_name: "video.mp4", staging_path: `qa-zf/${stamp}/video.mp4`, expires_at: new Date(Date.now() + 2 * 3_600_000).toISOString() }).select("id").single()
    if (intent.error) throw new Error(`could not make the open upload: ${intent.error.message}`)
    intentIds.push(intent.data.id)

    const real = Date.now()
    const later = () => new Date(real + 15 * 60_000)       // 15 minutes on: everything made above has been quiet for longer than 10 minutes
    const injectMarketing = (d: import("../../../lib/crm-store/zoom-call-filing").FilingDeps): import("../../../lib/crm-store/zoom-call-filing").FilingDeps => ({
      ...d,
      bookings: async (c) => [...(await d.bookings(c)), { kind: "marketing", start: new Date("2031-03-06T16:00:00Z"), end: new Date("2031-03-06T16:30:00Z"), who: "QA Maria" }, { kind: "marketing", start: new Date("2031-03-08T15:00:00Z"), end: new Date("2031-03-08T15:30:00Z"), who: "QA Clash" }],
    })
    const deps = (mode: import("../../../lib/crm-store/zoom-call-filing").FilingMode, now?: () => Date) => injectMarketing(F.liveFilingDeps({ zoomCallsId: zc.id, mode, now }))
    const top = async () => (await live(zc.id)).map((f) => f.name).sort()
    const topBefore = await top()
    check("1 the test pile: seven folders at the top of Zoom Calls plus TD Zoom Calls and TD Marketing Calls", topBefore.length === 9, `${topBefore.length}`)

    const off = await F.fileZoomCalls(deps("off", later))
    check("2 switched off: nothing is read or moved and it says why", !!off.skipped && /switched off/.test(off.skipped) && JSON.stringify(await top()) === JSON.stringify(topBefore), off.skipped ?? "")

    const fresh = await F.fileZoomCalls(deps("live"))
    check("3 live, but the folders were made seconds ago: every call waits, nothing moves", fresh.filed.length === 0 && fresh.waiting.length >= 5 && JSON.stringify(await top()) === JSON.stringify(topBefore), JSON.stringify(fresh.waiting.map((w) => w.reason)))

    const dry = await F.fileZoomCalls(deps("dry_run", later))
    const dryNames = dry.filed.map((f) => `${f.origin}>${f.destination}`).sort()
    check("4 dry run: says what it WOULD do (Calendly, Zoom x2, marketing) and changes nothing", dry.filed.length === 5 && dry.filed.every((f) => f.dryRun) && JSON.stringify(await top()) === JSON.stringify(topBefore), dryNames.join(" | "))
    check("5 dry run writes no activity-log rows", ((await admin.from("store_events").select("id").eq("event", "zoom_call_filed").eq("owner_id", ownerId).in("folder_id", [nCalendly.id, nZoom1.id, nMarketing.id])).data ?? []).length === 0, "")

    const { data: headBefore } = await admin.rpc("store_changes_head")
    const h0 = (headBefore ?? [])[0] as { txid: string; seq: number | string } | undefined

    const liveRun = await F.fileZoomCalls(deps("live", later))
    check("6 live: the Calendly call is in TD Zoom Calls › 2031 › 03 March (the EXISTING groups)", (await pathOf(nCalendly.id, zc.id)) === "TD Zoom Calls / 2031 / 03 March" && (await parentOf(nCalendly.id)) === m03.id, await pathOf(nCalendly.id, zc.id))
    check("7 a call started straight from Zoom lands in the same group", (await pathOf(nZoom1.id, zc.id)) === "TD Zoom Calls / 2031 / 03 March", await pathOf(nZoom1.id, zc.id))
    check("8 a call in a new month gets a NEW month group inside the existing year", (await pathOf(nZoom2.id, zc.id)) === "TD Zoom Calls / 2031 / 04 April" && (await live(td.id)).filter((f) => f.name === "2031").length === 1, await pathOf(nZoom2.id, zc.id))
    check("9 the marketing-booked call is in TD Marketing Calls and was not sorted", (await parentOf(nMarketing.id)) === mk.id, await pathOf(nMarketing.id, zc.id))
    check("10 the call with an upload still open waits where it is", (await parentOf(nUploading.id)) === zc.id && liveRun.waiting.some((w) => w.reason === "upload_running"), JSON.stringify(liveRun.waiting))
    check("11 the clash is reported in plain words and the call stays; the plain folder is untouched", (await parentOf(nClash.id)) === zc.id && liveRun.failed.some((f) => /already has a folder/.test(f.error)) && (await parentOf(nNotCall.id)) === zc.id, JSON.stringify(liveRun.failed))
    check("12 the report counts 4 filed", liveRun.filed.length === 4 && liveRun.filed.every((f) => !f.dryRun), `${liveRun.filed.length}`)

    const ev = ((await admin.from("store_events").select("folder_id, reason, details").eq("event", "zoom_call_filed").in("folder_id", [nCalendly.id, nZoom1.id, nZoom2.id, nMarketing.id])).data ?? []) as Array<{ folder_id: string; reason: string; details: { origin: string; destination: string; booking: unknown } }>
    const evOf = (id: string) => ev.find((e) => e.folder_id === id)
    check("13 the activity log says Calendly (with the lead's name and time) for the booked call", evOf(nCalendly.id)?.details.origin === "calendly" && /^Calendly booking 2031-03-04 14:00 UTC — QA ZoomFiling Luca/.test(evOf(nCalendly.id)?.reason ?? ""), evOf(nCalendly.id)?.reason ?? "no row")
    check("14 the activity log says 'Started in Zoom' for the two direct calls and Marketing for the marketing one", evOf(nZoom1.id)?.details.origin === "zoom_direct" && evOf(nZoom2.id)?.details.origin === "zoom_direct" && evOf(nMarketing.id)?.details.origin === "marketing" && /^Marketing booking 2031-03-06 16:00 UTC — QA Maria/.test(evOf(nMarketing.id)?.reason ?? ""), JSON.stringify(ev.map((e) => e.details.origin)))

    const { data: rows } = await admin.rpc("store_changes_since", { p_after_txid: h0 ? h0.txid : null, p_after_seq: h0 ? Number(h0.seq) : 0, p_limit: 2000 })
    const outOfZoomCalls = ((rows ?? []) as Array<{ item_kind: string; op: string; old_parent_id: string | null; parent_id: string | null }>).filter((r) => r.item_kind === "folder" && r.op === "upsert" && r.old_parent_id === zc.id)
    check("15 the Mac change feed has a row for each call that left Zoom Calls (Finder is told)", outOfZoomCalls.length >= 4, `${outOfZoomCalls.length} rows`)

    const again = await F.fileZoomCalls(deps("live", later))
    check("16 a second run does nothing more (waiting call and clash are still waiting / failing, nothing filed twice)", again.filed.length === 0 && again.waiting.some((w) => w.reason === "upload_running"), JSON.stringify({ filed: again.filed.length, failed: again.failed.length }))
    check("17 only calls with a name Zoom would write are ever touched (the rules agree)", R.isCallFolderName(nCalendly.name) && !R.isCallFolderName(nNotCall.name), "")

    // the upload ends -> that call is filed on the next run
    await admin.from("store_upload_intents").update({ consumed_at: new Date().toISOString() }).eq("id", intent.data.id)
    const last = await F.fileZoomCalls(deps("live", later))
    check("18 once the upload is done the waiting call is filed too", (await pathOf(nUploading.id, zc.id)) === "TD Zoom Calls / 2031 / 03 March" && last.filed.length === 1, await pathOf(nUploading.id, zc.id))
  } finally {
    for (const id of intentIds) await admin.from("store_upload_intents").delete().eq("id", id)
    for (const id of callIds) await admin.from("lead_calls").delete().eq("id", id)
    for (const id of leadIds) await admin.from("leads").delete().eq("id", id)
    for (const id of made.reverse()) await trashFolder(ACTOR, id, "qa zoom call filing").catch((e) => console.log("cleanup:", e?.message))
  }
  summary()
}

main().catch((e) => { console.error(e); process.exit(1) })
