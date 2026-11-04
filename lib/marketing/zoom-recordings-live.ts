/**
 * TD Marketing — the real services behind the Zoom recordings sync (server; dev job 9aec66fa, 4 Nov 2026). Rules and the runner live in `zoom-recordings.ts`; this file wires them to Zoom, the database and the CRM storage:
 * the folder is Business › Zoom Calls › the folder whose name says "marketing" (found by name, so a rename of the spelling never breaks it); a file is streamed from Zoom into the storage's staging area and registered through the
 * same slot the browser upload uses (`createServerUploadIntent` → `pipeToObject` → `registerNow`), never held whole in memory.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { zoomApi as liveZoomApi, zoomConfigured, type ZoomApi } from "@/lib/zoom"
import { listTeams } from "@/lib/marketing/settings"
import { loadPrefsAndTakers } from "@/lib/marketing/time-prefs-server"
import { ZOOM_FOLDER_PARENT, STALE_CLAIM_MS, type RecordingHost, type SyncDeps } from "@/lib/marketing/zoom-recordings"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing and store tables are newer than the generated types
const db = () => supabaseAdmin as any

/** The folder name that means "the marketing recordings" (his spelling today has a typo, so the check is loose on purpose). */
export const isMarketingFolderName = (name: string): boolean => /market|marek/i.test(name)

export type LiveSetup = { ok: true; deps: SyncDeps } | { ok: false; reason: string }

async function findTargetFolder(): Promise<{ ownerId: string; folderId: string } | string> {
  const { ensureArea } = await import("@/lib/crm-store/structure")
  const ownerId = await ensureArea("business", null)
  const { data: top } = await db().from("store_folders").select("id").eq("owner_id", ownerId).is("parent_id", null).is("trashed_at", null).limit(1)
  if (!top?.[0]) return "The Business storage has no top folder."
  const { data: zc } = await db().from("store_folders").select("id").eq("parent_id", top[0].id).ilike("name", ZOOM_FOLDER_PARENT).is("trashed_at", null).limit(1)
  if (!zc?.[0]) return `There is no "${ZOOM_FOLDER_PARENT}" folder in Business.`
  const { data: kids } = await db().from("store_folders").select("id, name").eq("parent_id", zc[0].id).is("trashed_at", null)
  const hits = ((kids ?? []) as Array<{ id: string; name: string }>).filter(k => isMarketingFolderName(k.name))
  if (hits.length !== 1) return hits.length === 0 ? `There is no marketing folder inside "${ZOOM_FOLDER_PARENT}".` : `More than one folder inside "${ZOOM_FOLDER_PARENT}" looks like the marketing one; leave only one.`
  return { ownerId, folderId: hits[0].id as string }
}

/** `opts.zoom` lets a test put a fake Zoom in place of the real one (the sandbox has no Zoom keys); `opts.teamId` picks the team (a test makes its own). */
/** Whose name the saved files carry: the team's recorded owner, else an active owner member (the admin first). The recorded owner can be empty (it is, in production), so this never relies on it. */
export async function actorFor(teamId: string, recordedOwner: string | null): Promise<string | null> {
  if (recordedOwner) return recordedOwner
  const { data } = await db().from("marketing_team_members").select("user_id").eq("team_id", teamId).eq("member_role", "owner").eq("status", "active")
  const ids = ((data ?? []) as Array<{ user_id: string }>).map(r => r.user_id)
  for (const id of ids) {
    const u = await db().auth.admin.getUserById(id)
    if (u?.data?.user?.app_metadata?.role === "admin") return id
  }
  return ids[0] ?? null
}

export async function liveSyncSetup(opts: { zoom?: ZoomApi; teamId?: string } = {}): Promise<LiveSetup> {
  const zoomApi = opts.zoom ?? liveZoomApi
  if (!opts.zoom && !zoomConfigured()) return { ok: false, reason: "Zoom is not set up in this environment." }
  if (!zoomApi.listRecordings || !zoomApi.openRecording) return { ok: false, reason: "The Zoom helper cannot read recordings." }
  const teams = (await listTeams()).filter(t => t.status === "active" && (!opts.teamId || t.id === opts.teamId))
  if (teams.length === 0) return { ok: false, reason: "No marketing team is active." }
  const target = await findTargetFolder()
  if (typeof target === "string") return { ok: false, reason: target }
  const team = teams[0]
  const actor = await actorFor(team.id, team.owner_user_id)
  if (!actor) return { ok: false, reason: "The team has no active owner to save the files under." }
  const list = zoomApi.listRecordings.bind(zoomApi)
  const open = zoomApi.openRecording.bind(zoomApi)

  const deps: SyncDeps = {
    now: () => new Date(),
    hosts: async () => {
      const out: RecordingHost[] = [{ host: (process.env.ZOOM_HOST_USER ?? "").trim() || "me", scope: "booked" }]
      const { takers } = await loadPrefsAndTakers(team.id)
      for (const tk of takers) {
        if (!tk.email) continue
        const u = await db().auth.admin.getUserById(tk.userId)
        if (u?.data?.user?.app_metadata?.role === "admin") continue // the owner's own login is covered above (booked meetings only)
        if (!out.some(h => h.host.toLowerCase() === tk.email!.toLowerCase())) out.push({ host: tk.email, scope: "all" })
      }
      return out
    },
    list,
    open,
    bookedMeetingIds: async () => {
      const { data } = await db().from("marketing_joint_links").select("zoom_meeting_id").eq("team_id", team.id).not("zoom_meeting_id", "is", null)
      return new Set(((data ?? []) as Array<{ zoom_meeting_id: string }>).map(r => String(r.zoom_meeting_id)))
    },
    claim: async (w, size) => {
      const row = { zoom_file_id: w.file.id, team_id: team.id, host: w.host, meeting_id: w.meeting.meetingId, meeting_uuid: w.meeting.uuid, topic: w.meeting.topic.slice(0, 200), started_at: w.meeting.startTime || null, file_type: w.file.fileType, recording_type: w.file.recordingType, size_bytes: size, status: "saving" }
      const ins = await db().from("marketing_zoom_recordings").insert(row)
      if (!ins.error) return true
      if (ins.error.code !== "23505") throw new Error(`could not claim the recording: ${ins.error.message}`)
      // already there: saved (skip), or a run that died left it "saving" for too long (take it again, once)
      const stale = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
      const take = await db().from("marketing_zoom_recordings").update({ claimed_at: new Date().toISOString() }).eq("zoom_file_id", w.file.id).eq("status", "saving").lt("claimed_at", stale).select("zoom_file_id")
      return !take.error && (take.data?.length ?? 0) === 1
    },
    save: async (w, stream) => {
      const { createServerUploadIntent, registerNow, discardUploadIntentObjects, storedSize } = await import("@/lib/crm-store/writer")
      const { pipeToObject } = await import("@/lib/crm-store/stream-import")
      const intent = await createServerUploadIntent({ ownerId: target.ownerId, folderId: target.folderId, fileName: w.name, mimeType: w.mimeType, callerKey: `zoom:${w.file.id}`, actor })
      try {
        const d = await pipeToObject({ body: stream.body, bucket: intent.bucket, path: intent.stagingPath, contentType: w.mimeType })
        if (stream.size !== null && d.bytes !== stream.size) throw new Error(`Zoom promised ${stream.size} bytes and ${d.bytes} arrived — the download is incomplete.`)
        if ((await storedSize(intent.bucket, intent.stagingPath).catch(() => -1)) !== d.bytes) throw new Error("The staged copy is not as long as the bytes that were sent.")
        const r = await registerNow({ intentId: intent.intentId, actor, documentType: null, published: false })
        return { storeFileId: r.fileId }
      } catch (e) {
        await discardUploadIntentObjects(intent.intentId).catch(() => undefined) // no half file is left behind; the next run starts clean
        throw e
      }
    },
    markSaved: async (w, storeFileId) => {
      const { error } = await db().from("marketing_zoom_recordings").update({ status: "saved", store_file_id: storeFileId, saved_at: new Date().toISOString() }).eq("zoom_file_id", w.file.id)
      if (error) throw new Error(`saved, but the record could not be written: ${error.message}`)
    },
    release: async w => { await db().from("marketing_zoom_recordings").delete().eq("zoom_file_id", w.file.id).eq("status", "saving") },
  }
  return { ok: true, deps }
}
