/**
 * TD Marketing — Zoom recordings saved into the CRM storage (dev job 9aec66fa, 4 Nov 2026). Every 15 minutes the cron asks Zoom for the new finished cloud recordings of the marketing logins and files each
 * file under Business › Zoom Calls › the marketing folder. This file holds the RULES (pure: what is wanted, what the file is called) and the RUNNER, which does every outside step through `SyncDeps`, so it is tested with fakes.
 * Which recordings: a login that only does marketing calls (Rocco) gives ALL of its recordings; the owner's own login (also used for his client calls) gives ONLY the meetings our booking made (matched by Zoom meeting number),
 * so a client consultation never lands in the marketing folder.
 */
import type { ZoomRecordingFile, ZoomRecordingMeeting, ZoomRecordingStream } from "@/lib/zoom"

export const ZOOM_FOLDER_PARENT = "Zoom Calls"
/** The newest recordings only: Zoom keeps them for weeks, a run reads the last week. */
export const LOOKBACK_DAYS = 7
/** One run stops starting new files after this long, the rest waits for the next run. */
export const RUN_BUDGET_MS = 230_000
/** A single file above this is not copied (reported, left in Zoom). */
export const MAX_FILE_BYTES = 450 * 1024 * 1024
/** A claim older than this was left by a run that died: the next run takes the file again. */
export const STALE_CLAIM_MS = 30 * 60 * 1000

export interface RecordingHost { /** the Zoom login, or "me" for the account owner */ host: string; /** "all" = every recording, "booked" = only meetings made by our booking link */ scope: "all" | "booked" }

export interface WantedFile { meeting: ZoomRecordingMeeting; file: ZoomRecordingFile; host: string; name: string; mimeType: string }

const MIME: Record<string, string> = { mp4: "video/mp4", m4a: "audio/mp4", txt: "text/plain", vtt: "text/vtt", json: "application/json", csv: "text/csv", srt: "text/plain" }
export const mimeForExtension = (ext: string): string => MIME[ext.toLowerCase()] ?? "application/octet-stream"

const TYPE_LABEL: Record<string, string> = {
  shared_screen_with_speaker_view: "video", shared_screen_with_gallery_view: "video gallery", speaker_view: "video", gallery_view: "video gallery", shared_screen: "screen",
  audio_only: "audio", audio_transcript: "transcript", chat_file: "chat", timeline: "timeline", closed_caption: "captions", summary: "summary",
}

/** "2026-11-04 15.30 UTC" — the meeting start in UTC (no guess about anybody's zone). */
export function startLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "unknown time"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}.${p(d.getUTCMinutes())} UTC`
}

const cleanTopic = (t: string): string => t.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)

/** The name a recording file is saved under, e.g. "2026-11-04 15.30 UTC Call with Antonio Durante · Maria - video.mp4". Two files of the same kind in one meeting get the start of their Zoom id so they never overwrite each other. */
export function recordingFileName(meeting: ZoomRecordingMeeting, file: ZoomRecordingFile, siblings: readonly ZoomRecordingFile[]): string {
  const kind = TYPE_LABEL[file.recordingType ?? ""] ?? (file.fileType || "file").toLowerCase()
  const same = siblings.filter(s => (TYPE_LABEL[s.recordingType ?? ""] ?? (s.fileType || "file").toLowerCase()) === kind && s.extension === file.extension)
  const tag = same.length > 1 ? ` ${file.id.slice(0, 6)}` : ""
  const ext = file.extension ? `.${file.extension}` : ""
  const topic = cleanTopic(meeting.topic) || "Zoom call"
  return `${startLabel(meeting.startTime)} ${topic} - ${kind}${tag}${ext}`.slice(0, 190)
}

/** Which files of these meetings the folder should get: finished files only, and only the meetings the host's scope allows. */
export function wantedFiles(meetings: readonly ZoomRecordingMeeting[], host: RecordingHost, bookedMeetingIds: ReadonlySet<string>): WantedFile[] {
  const out: WantedFile[] = []
  for (const m of meetings) {
    if (host.scope === "booked" && !bookedMeetingIds.has(m.meetingId)) continue
    for (const f of m.files) {
      if (f.status !== "completed") continue
      out.push({ meeting: m, file: f, host: host.host, name: recordingFileName(m, f, m.files.filter(x => x.status === "completed")), mimeType: mimeForExtension(f.extension) })
    }
  }
  return out
}

export const dayString = (d: Date): string => d.toISOString().slice(0, 10)

export interface SyncDeps {
  now: () => Date
  hosts: () => Promise<RecordingHost[]>
  list: (host: string, fromDay: string, toDay: string) => Promise<ZoomRecordingMeeting[]>
  open: (url: string) => Promise<ZoomRecordingStream>
  bookedMeetingIds: () => Promise<Set<string>>
  /** Takes the file for this run. false = already saved, or another run has it. */
  claim: (w: WantedFile, size: number | null) => Promise<boolean>
  /** Streams the Zoom file into the folder; returns the saved storage file id. */
  save: (w: WantedFile, stream: ZoomRecordingStream) => Promise<{ storeFileId: string }>
  markSaved: (w: WantedFile, storeFileId: string) => Promise<void>
  release: (w: WantedFile) => Promise<void>
}

export interface SyncReport { hosts: number; seen: number; saved: number; skipped: number; tooBig: string[]; failed: Array<{ name: string; error: string }>; outOfTime: boolean }

export async function syncRecordings(d: SyncDeps): Promise<SyncReport> {
  const start = d.now().getTime()
  const report: SyncReport = { hosts: 0, seen: 0, saved: 0, skipped: 0, tooBig: [], failed: [], outOfTime: false }
  const hosts = await d.hosts()
  report.hosts = hosts.length
  const to = dayString(d.now())
  const from = dayString(new Date(d.now().getTime() - LOOKBACK_DAYS * 86_400_000))
  const booked = hosts.some(h => h.scope === "booked") ? await d.bookedMeetingIds() : new Set<string>()
  for (const host of hosts) {
    let meetings: ZoomRecordingMeeting[]
    try { meetings = await d.list(host.host, from, to) } catch (e) { report.failed.push({ name: `list ${host.host}`, error: e instanceof Error ? e.message : String(e) }); continue }
    for (const w of wantedFiles(meetings, host, booked)) {
      report.seen++
      if (d.now().getTime() - start > RUN_BUDGET_MS) { report.outOfTime = true; return report }
      if (w.file.sizeBytes !== null && w.file.sizeBytes > MAX_FILE_BYTES) { report.tooBig.push(w.name); continue }
      if (!(await d.claim(w, w.file.sizeBytes))) { report.skipped++; continue }
      try {
        const stream = await d.open(w.file.downloadUrl)
        const { storeFileId } = await d.save(w, stream)
        await d.markSaved(w, storeFileId)
        report.saved++
      } catch (e) {
        report.failed.push({ name: w.name, error: e instanceof Error ? e.message : String(e) })
        await d.release(w).catch(() => undefined)
      }
    }
  }
  return report
}
