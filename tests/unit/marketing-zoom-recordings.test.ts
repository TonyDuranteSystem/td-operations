import { describe, it, expect } from "vitest"
import type { ZoomRecordingFile, ZoomRecordingMeeting } from "@/lib/zoom"
import { LOOKBACK_DAYS, MAX_FILE_BYTES, RUN_BUDGET_MS, dayString, mimeForExtension, recordingFileName, startLabel, syncRecordings, wantedFiles, type RecordingHost, type SyncDeps, type WantedFile } from "@/lib/marketing/zoom-recordings"
import { isMarketingFolderName } from "@/lib/marketing/zoom-recordings-live"

const file = (id: string, over: Partial<ZoomRecordingFile> = {}): ZoomRecordingFile => ({ id, fileType: "MP4", extension: "mp4", sizeBytes: 1000, recordingType: "shared_screen_with_speaker_view", status: "completed", downloadUrl: `https://zoom.us/rec/download/${id}`, ...over })
const meeting = (id: string, files: ZoomRecordingFile[], over: Partial<ZoomRecordingMeeting> = {}): ZoomRecordingMeeting => ({ uuid: `u-${id}`, meetingId: id, topic: "Call with Antonio Durante · Maria", startTime: "2026-11-04T15:30:00Z", files, ...over })

describe("naming", () => {
  it("shows the start in UTC, with no guess about a zone", () => {
    expect(startLabel("2026-11-04T15:30:00Z")).toBe("2026-11-04 15.30 UTC")
    expect(startLabel("nonsense")).toBe("unknown time")
  })
  it("names a file by start, call and kind", () => {
    const m = meeting("1", [file("a1")])
    expect(recordingFileName(m, m.files[0], m.files)).toBe("2026-11-04 15.30 UTC Call with Antonio Durante · Maria - video.mp4")
  })
  it("two files of the same kind in one meeting never share a name", () => {
    const m = meeting("1", [file("aaaaaa111"), file("bbbbbb222")])
    const names = m.files.map(f => recordingFileName(m, f, m.files))
    expect(new Set(names).size).toBe(2)
    expect(names[0]).toContain("aaaaaa")
  })
  it("a topic with slashes or colons is cleaned; an empty one gets a plain word", () => {
    const m = meeting("1", [file("a")], { topic: "A/B: C*" })
    expect(recordingFileName(m, m.files[0], m.files)).toContain("A B C")
    expect(recordingFileName(meeting("1", [file("a")], { topic: "" }), file("a"), [file("a")])).toContain("Zoom call")
  })
  it("knows the file kinds Zoom makes", () => {
    expect(mimeForExtension("MP4")).toBe("video/mp4")
    expect(mimeForExtension("vtt")).toBe("text/vtt")
    expect(mimeForExtension("xyz")).toBe("application/octet-stream")
  })
})

describe("wantedFiles", () => {
  const all: RecordingHost = { host: "rocco@x.test", scope: "all" }
  const booked: RecordingHost = { host: "me", scope: "booked" }
  const ms = [meeting("111", [file("a"), file("b", { status: "processing" })]), meeting("222", [file("c")])]
  it("a marketing login gives every finished file and skips the ones still processing", () => {
    expect(wantedFiles(ms, all, new Set()).map(w => w.file.id)).toEqual(["a", "c"])
  })
  it("the owner's own login gives only the meetings our booking made", () => {
    expect(wantedFiles(ms, booked, new Set(["222"])).map(w => w.file.id)).toEqual(["c"])
    expect(wantedFiles(ms, booked, new Set())).toEqual([])
  })
})

function deps(over: Partial<SyncDeps> = {}, state: { saved: string[]; claimed: Set<string>; released: string[]; marked: string[] } = { saved: [], claimed: new Set(), released: [], marked: [] }) {
  const base: SyncDeps = {
    now: () => new Date("2026-11-04T16:00:00Z"),
    hosts: async () => [{ host: "rocco@x.test", scope: "all" }],
    list: async () => [meeting("111", [file("a"), file("b")])],
    open: async () => ({ body: new ReadableStream<Uint8Array>(), size: 1000, contentType: "video/mp4" }),
    bookedMeetingIds: async () => new Set(),
    claim: async w => { if (state.claimed.has(w.file.id)) return false; state.claimed.add(w.file.id); return true },
    save: async (w: WantedFile) => { state.saved.push(w.file.id); return { storeFileId: `store-${w.file.id}` } },
    markSaved: async w => { state.marked.push(w.file.id) },
    release: async w => { state.released.push(w.file.id) },
    ...over,
  }
  return { d: base, state }
}

describe("syncRecordings", () => {
  it("saves each new file once and marks it", async () => {
    const { d, state } = deps()
    const r = await syncRecordings(d)
    expect(r).toMatchObject({ hosts: 1, seen: 2, saved: 2, skipped: 0, failed: [], tooBig: [], outOfTime: false })
    expect(state.saved).toEqual(["a", "b"])
    expect(state.marked).toEqual(["a", "b"])
  })
  it("a second run saves nothing: the claim is already taken", async () => {
    const { d, state } = deps()
    await syncRecordings(d)
    const r2 = await syncRecordings(d)
    expect(r2).toMatchObject({ saved: 0, skipped: 2 })
    expect(state.saved).toEqual(["a", "b"])
  })
  it("a failed save gives the claim back so the next run tries again, and the others still go", async () => {
    let n = 0
    const { d, state } = deps({ save: async w => { if (++n === 1) throw new Error("storage said no"); return { storeFileId: `s-${w.file.id}` } } })
    const r = await syncRecordings(d)
    expect(r.saved).toBe(1)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].error).toBe("storage said no")
    expect(state.released).toEqual(["a"])
  })
  it("a file over the limit is reported and left in Zoom, never claimed", async () => {
    const { d, state } = deps({ list: async () => [meeting("111", [file("big", { sizeBytes: MAX_FILE_BYTES + 1 }), file("ok")])] })
    const r = await syncRecordings(d)
    expect(r.tooBig).toHaveLength(1)
    expect(r.saved).toBe(1)
    expect(state.claimed.has("big")).toBe(false)
  })
  it("a Zoom error on one login does not stop the other", async () => {
    const { d } = deps({ hosts: async () => [{ host: "bad@x.test", scope: "all" }, { host: "rocco@x.test", scope: "all" }], list: async h => { if (h === "bad@x.test") throw new Error("Zoom answered 404"); return [meeting("111", [file("a")])] } })
    const r = await syncRecordings(d)
    expect(r.saved).toBe(1)
    expect(r.failed[0].name).toBe("list bad@x.test")
  })
  it("stops starting new files when the time budget is used, and says so", async () => {
    let t = Date.parse("2026-11-04T16:00:00Z")
    const { d } = deps({ now: () => new Date(t), save: async w => { t += RUN_BUDGET_MS + 1000; return { storeFileId: `s-${w.file.id}` } } })
    const r = await syncRecordings(d)
    expect(r.saved).toBe(1)
    expect(r.outOfTime).toBe(true)
  })
  it("asks Zoom for the last week only, and only reads the booking list when a booked-only login exists", async () => {
    let asked: [string, string] | null = null
    let bookedReads = 0
    const { d } = deps({ list: async (_h, f, t) => { asked = [f, t]; return [] }, bookedMeetingIds: async () => { bookedReads++; return new Set() } })
    await syncRecordings(d)
    expect(asked).toEqual(["2026-10-28", "2026-11-04"])
    expect(bookedReads).toBe(0)
    expect(LOOKBACK_DAYS).toBe(7)
    expect(dayString(new Date("2026-11-04T23:59:00Z"))).toBe("2026-11-04")
    await syncRecordings({ ...d, hosts: async () => [{ host: "me", scope: "booked" }] })
    expect(bookedReads).toBe(1)
  })
})

describe("the marketing folder is found by its name", () => {
  it("accepts the spelling in use and the right one, not other folders", () => {
    expect(isMarketingFolderName("Zoom Call from Marekting")).toBe(true)
    expect(isMarketingFolderName("Marketing calls")).toBe(true)
    expect(isMarketingFolderName("2026-11-02 09.06.31 Antonio Durante - Tony Durante LLC's Zoom Meeting")).toBe(false)
  })
})
