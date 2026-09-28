/**
 * CRM Store — slice S5: the automatic ONE-WAY backup CRM store → Google Drive (master plan v4.5 §8.7,
 * §8.9 #5; decisions #10 #27 #36 #61 #62 #63; job 685467b5). DARK: the kill switch STORE_BACKUP_ENABLED
 * is OFF by default and nothing schedules the sweep.
 *
 * Antonio 2026-09-26:
 *   #62 the backup goes INTO THE EXISTING client Drive folders. A company whose account already has a
 *       Drive folder uses THAT folder and its existing sub-folders; the backup only ADDS and UPDATES its
 *       own tagged copies and NEVER renames, moves, overwrites or deletes an existing folder or an
 *       original file ("adopted" / "imported" items are fixed).
 *   #63 personal documents (person owners, Unfiled) and the copies of files trashed in the CRM live in a
 *       SEPARATE PRIVATE Shared Drive (STORE_BACKUP_PRIVATE_DRIVE_ID), never in the client Drive.
 *
 * One run = one owner, under a database lease. It brings Drive in line with the store, never the other
 * way round: every live file gets a copy of its CURRENT bytes (an imported original that still holds
 * those bytes counts as the copy); renames / moves / re-homes of OUR copies propagate (mirrored by CRM
 * id, never by name); a CRM-trashed file's copy moves to the protected area in the private Drive (never
 * Drive's own trash) and back on restore; a purged file's copies are removed; a copy deleted by hand is
 * recreated; every copy is tagged with its CRM id so a crashed run finds its own work instead of making
 * a duplicate. Fixed Drive "places" (state folders, "_In formation", People, Unfiled, protected areas)
 * are created once under a database claim — an existing folder with the right name is adopted. A run
 * stops cleanly before the job's time limit; a file that fails is recorded and the rest continue.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import * as drive from "@/lib/google-drive"
import type { DriveTaggedItem } from "@/lib/google-drive"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export const BACKUP_JOB = "crm_store_backup_owner"
const STOP_BEFORE_DEADLINE_MS = 30_000
const PAGE = 1000

export interface BackupConfig {
  /** the existing client Drive: its id and its "Companies" folder (state folders live under it) */
  mainDriveId: string
  companiesRoot: string
  /** the separate private Shared Drive (#63): people / Unfiled under restrictedRoot, trashed copies under protectedRoot */
  privateDriveId: string
  restrictedRoot: string
  protectedRoot: string
}

export function backupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.STORE_BACKUP_ENABLED === "1"
}

export function backupConfig(env: Record<string, string | undefined> = process.env): BackupConfig {
  const c: BackupConfig = {
    mainDriveId: (env.GOOGLE_SHARED_DRIVE_ID ?? "").trim(),
    companiesRoot: (env.STORE_BACKUP_COMPANIES_ROOT ?? "").trim(),
    privateDriveId: (env.STORE_BACKUP_PRIVATE_DRIVE_ID ?? "").trim(),
    restrictedRoot: (env.STORE_BACKUP_RESTRICTED_ROOT ?? "").trim(),
    protectedRoot: (env.STORE_BACKUP_PROTECTED_ROOT ?? "").trim(),
  }
  if (Object.values(c).some((v) => !v)) {
    throw new Error("store backup: GOOGLE_SHARED_DRIVE_ID, STORE_BACKUP_COMPANIES_ROOT, STORE_BACKUP_PRIVATE_DRIVE_ID, STORE_BACKUP_RESTRICTED_ROOT and STORE_BACKUP_PROTECTED_ROOT must all be set")
  }
  if (new Set([c.companiesRoot, c.restrictedRoot, c.protectedRoot]).size !== 3) {
    throw new Error("store backup: the companies, restricted and protected roots must be three different folders")
  }
  return c
}

/** State of formation → the name of its Drive folder (codes and full names both appear in the CRM). */
const STATE_NAMES: Record<string, string> = {
  NM: "New Mexico", WY: "Wyoming", DE: "Delaware", FL: "Florida", MA: "Massachusetts", NY: "New York", TX: "Texas", CA: "California", NV: "Nevada",
}
export function stateFolderName(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim()
  if (!t) return null
  const hit = STATE_NAMES[t.toUpperCase()]
  if (hit) return hit
  return t.replace(/\s+/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())
}

// ─────────────────────────────────────────────────────────────── snapshot of one owner

export interface RefRow { external_id: string; backed_up_sha256: string | null; drive_path: Record<string, unknown>; status: string }
export interface OwnerSnap {
  id: string; kind: "company" | "person" | "formation" | "unfiled" | "business" | "private"
  state: string | null
  /** the account's existing Drive folder (#62) — adopted when no other owner already uses it */
  accountFolderId: string | null
  accountFolderTakenByOther: boolean
  folders: Array<{ id: string; parent_id: string | null; name: string; trashed_at: string | null }>
  files: Array<{ id: string; folder_id: string; name: string; state: "live" | "trashed" | "purged"
                 sha256: string | null; bucket: string | null; path: string | null; size: number | null; mime: string | null }>
  backupRefs: Map<string, RefRow>
  importRefs: Map<string, RefRow>
}

export interface BackupIO {
  claim(ownerId: string): Promise<{ claimed: boolean; token?: string; upTo?: number; fullCheckDue?: boolean }>
  finish(ownerId: string, token: string, outcome: "ok" | "deferred" | "failed", upTo: number, error?: string, fullCheck?: boolean): Promise<void>
  noteError(ownerId: string, error: string): Promise<void>
  load(ownerId: string): Promise<OwnerSnap>
  currentOwner(fileId: string): Promise<string | null>
  recordRef(kind: "folder" | "file", objectId: string, externalId: string, sha: string | null, path: Record<string, unknown>, status?: string): Promise<void>
  place(key: string): Promise<{ driveId?: string; claim?: string; busy?: boolean }>
  placeSet(key: string, token: string, driveId: string): Promise<boolean>
  placeReset(key: string, driveId: string): Promise<boolean>
  open(bucket: string, path: string): Promise<ReadableStream<Uint8Array>>
  find(key: string, value: string, driveIds: string[]): Promise<DriveTaggedItem[]>
  get(id: string): Promise<DriveTaggedItem | null>
  childFolders(folderId: string, driveId: string): Promise<DriveTaggedItem[]>
  createFolder(parentId: string, name: string, tags: Record<string, string>): Promise<DriveTaggedItem>
  patch(id: string, p: { name?: string; newParentId?: string; appProperties?: Record<string, string> }): Promise<DriveTaggedItem>
  upload(p: Parameters<typeof drive.uploadStreamToDrive>[0]): Promise<DriveTaggedItem>
  trash(id: string): Promise<void>
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args)
  if (error) throw new Error(`[crm-store backup] ${fn} failed: ${error.message}`)
  return data as T
}

async function allRows<T>(q: () => { range: (a: number, b: number) => Promise<{ data: T[] | null; error: { message: string } | null }> }, what: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q().range(from, from + PAGE - 1)
    if (error) throw new Error(`store backup: could not read ${what}: ${error.message}`)
    out.push(...(data ?? []))
    if ((data ?? []).length < PAGE) return out
  }
}

export const backupIO: BackupIO = {
  async claim(ownerId) {
    const r = await rpc<{ claimed: boolean; token?: string; up_to_event?: number; full_check_due?: boolean }>("store_backup_claim", { p_owner_id: ownerId })
    return { claimed: r.claimed, token: r.token, upTo: r.up_to_event, fullCheckDue: r.full_check_due }
  },
  async finish(ownerId, token, outcome, upTo, error, fullCheck) {
    await rpc("store_backup_finish", { p_owner_id: ownerId, p_token: token, p_outcome: outcome, p_up_to_event: upTo, p_error: error ?? null, p_full_check: !!fullCheck })
  },
  async noteError(ownerId, error) { await rpc("store_backup_note_error", { p_owner_id: ownerId, p_error: error }) },
  async load(ownerId) {
    const { data: o, error } = await db().from("store_owners").select("id, kind, account_id").eq("id", ownerId).single()
    if (error || !o) throw new Error(`store backup: owner ${ownerId} not found (${error?.message ?? "no row"})`)
    let state: string | null = null
    let accountFolderId: string | null = null
    if (o.kind === "company" && o.account_id) {
      const { data: a, error: aErr } = await db().from("accounts").select("state_of_formation, drive_folder_id").eq("id", o.account_id).maybeSingle()
      if (aErr) throw new Error(`store backup: could not read the account: ${aErr.message}`)
      state = a?.state_of_formation ?? null
      accountFolderId = a?.drive_folder_id ?? null
    }
    const folders = await allRows<OwnerSnap["folders"][number]>(
      () => db().from("store_folders").select("id, parent_id, name, trashed_at").eq("owner_id", ownerId).order("id"), "folders")
    const files = await allRows<Record<string, unknown>>(
      () => db().from("store_files")
        .select("id, folder_id, name, state, store_file_versions!store_files_current_version_fk(sha256, storage_bucket, storage_path, size_bytes, mime_type)")
        .eq("owner_id", ownerId).order("id"), "files")
    const ids = [...folders.map((f) => f.id), ...files.map((f) => f.id as string)]
    const backupRefs = new Map<string, RefRow>()
    const importRefs = new Map<string, RefRow>()
    for (let i = 0; i < ids.length; i += 200) {
      const { data: rs, error: rErr } = await db().from("store_external_refs")
        .select("object_id, external_id, backed_up_sha256, drive_path, status, direction")
        .eq("provider", "gdrive").in("object_id", ids.slice(i, i + 200))
      if (rErr) throw new Error(`store backup: could not read Drive references: ${rErr.message}`)
      for (const r of rs ?? []) (r.direction === "import" ? importRefs : backupRefs).set(r.object_id, r)
    }
    let accountFolderTakenByOther = false
    const root = folders.find((f) => f.parent_id === null)
    if (accountFolderId) {
      const { data: taken, error: tErr } = await db().from("store_external_refs").select("object_id")
        .eq("provider", "gdrive").eq("direction", "backup").eq("object_kind", "folder").eq("external_id", accountFolderId).limit(1)
      if (tErr) throw new Error(`store backup: could not check the account folder: ${tErr.message}`)
      accountFolderTakenByOther = (taken ?? []).some((t: { object_id: string }) => t.object_id !== root?.id)
    }
    return {
      id: o.id, kind: o.kind, state, accountFolderId, accountFolderTakenByOther, folders,
      files: files.map((f) => {
        const v = (f.store_file_versions ?? {}) as Record<string, unknown>
        return { id: f.id as string, folder_id: f.folder_id as string, name: f.name as string, state: f.state as OwnerSnap["files"][number]["state"],
                 sha256: (v.sha256 as string) ?? null, bucket: (v.storage_bucket as string) ?? null, path: (v.storage_path as string) ?? null,
                 size: v.size_bytes == null ? null : Number(v.size_bytes), mime: (v.mime_type as string) ?? null }
      }),
      backupRefs, importRefs,
    }
  },
  async currentOwner(fileId) {
    const { data, error } = await db().from("store_files").select("owner_id").eq("id", fileId).maybeSingle()
    if (error) throw new Error(`store backup: could not re-check a file's owner: ${error.message}`)
    return data?.owner_id ?? null
  },
  async recordRef(kind, objectId, externalId, sha, path, status = "ok") {
    await rpc("store_backup_record_ref", { p_object_kind: kind, p_object_id: objectId, p_external_id: externalId, p_sha256: sha, p_drive_path: path, p_status: status })
  },
  async place(key) {
    const r = await rpc<{ drive_id?: string; claim?: string; busy?: boolean }>("store_backup_place", { p_key: key })
    return { driveId: r.drive_id, claim: r.claim, busy: r.busy }
  },
  placeSet: (key, token, driveId) => rpc<boolean>("store_backup_place_set", { p_key: key, p_token: token, p_drive_id: driveId }),
  placeReset: (key, driveId) => rpc<boolean>("store_backup_place_reset", { p_key: key, p_drive_id: driveId }),
  async open(bucket, path) {
    const { data, error } = await db().storage.from(bucket).createSignedUrl(path, 3600)
    if (error || !data?.signedUrl) throw new Error(`store backup: cannot read ${path} (${error?.message ?? "no url"})`)
    const res = await fetch(data.signedUrl)
    if (!res.ok || !res.body) throw new Error(`store backup: cannot read ${path} (HTTP ${res.status})`)
    const { keepAliveBody } = await import("./folders")
    return keepAliveBody(res)
  },
  find: (k, v, driveIds) => drive.findByAppProperty(k, v, driveIds),
  get: (id) => drive.getTaggedItem(id),
  childFolders: (id, driveId) => drive.listChildFolders(id, driveId),
  createFolder: (parent, name, tags) => drive.createTaggedFolder(parent, name, tags),
  patch: (id, p) => drive.patchTaggedItem(id, p),
  upload: (p) => drive.uploadStreamToDrive(p),
  trash: async (id) => { await drive.trashFile(id) },
}

// ─────────────────────────────────────────────────────────────── one owner

export interface BackupReport {
  status: "done" | "busy" | "disabled" | "failed" | "deferred"
  folders: number; uploaded: number; updated: number; moved: number; recreated: number; protectedMoves: number; removed: number
  skippedRehomed: number; fileErrors: Array<{ fileId: string; message: string }>
  error?: string
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase()

/**
 * Bring Drive in line with one owner's store. Idempotent. Refuses while the kill switch is off (unless
 * `force` — proofs only) and whenever Drive is faked (a faked run would record fake ids as backed up).
 */
export async function backupOwner(
  ownerId: string,
  opts: { io?: BackupIO; config?: BackupConfig; fullCheck?: boolean; force?: boolean; deadlineAt?: number } = {},
): Promise<BackupReport> {
  const rep: BackupReport = { status: "done", folders: 0, uploaded: 0, updated: 0, moved: 0, recreated: 0, protectedMoves: 0, removed: 0, skippedRehomed: 0, fileErrors: [] }
  if (!opts.force && !backupEnabled()) return { ...rep, status: "disabled" }
  const io = opts.io ?? backupIO
  if (!opts.io && drive.driveIsMocked()) return { ...rep, status: "disabled", error: "Drive is faked in this environment (GOOGLE_DRIVE_LIVE is off)" }
  let cfg: BackupConfig
  try {
    cfg = opts.config ?? backupConfig()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await io.noteError(ownerId, msg).catch(() => undefined)
    return { ...rep, status: "failed", error: msg }
  }
  const drives = [cfg.mainDriveId, cfg.privateDriveId]
  const lease = await io.claim(ownerId)
  if (!lease.claimed || !lease.token) return { ...rep, status: "busy" }
  const token = lease.token
  const upTo = lease.upTo ?? 0
  const full = !!opts.fullCheck || !!lease.fullCheckDue
  const timeUp = () => opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt - STOP_BEFORE_DEADLINE_MS
  try {
    const snap = await io.load(ownerId)
    // The firm's "Business" area and a staff member's private "My files" are NOT backed up into the client
    // Drive or the restricted area until Antonio decides where (master plan #94) — never fall into "Unfiled".
    if (snap.kind === "business" || snap.kind === "private") {
      await io.finish(ownerId, token, "ok", upTo, undefined, full)
      return { ...rep, status: "disabled", error: `the ${snap.kind === "private" ? "private My files" : "Business"} area is not backed up (not decided yet)` }
    }

    // a fixed place: created once under a database claim; an existing folder of that name is adopted
    const places = new Map<string, string>()
    const place = async (key: string, parentId: string, name: string, driveId: string): Promise<string> => {
      const hit = places.get(key)
      if (hit) return hit
      let p = await io.place(key)
      if (p.driveId) {
        const it = await io.get(p.driveId)
        if (it && !it.trashed) { places.set(key, p.driveId); return p.driveId }
        await io.placeReset(key, p.driveId)       // its folder was deleted by hand → create it again
        p = await io.place(key)
        if (p.driveId) { places.set(key, p.driveId); return p.driveId }
      }
      if (p.busy || !p.claim) throw new Error(`store backup: the Drive place "${name}" is being created by another run — retry`)
      const existing = (await io.childFolders(parentId, driveId)).find((f) => norm(f.name) === norm(name))
      const id = existing?.id ?? (await io.createFolder(parentId, name, { crm_place: key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) })).id
      if (!(await io.placeSet(key, p.claim, id))) throw new Error(`store backup: lost the claim on "${name}" — retry`)
      places.set(key, id)
      return id
    }
    const protectedArea = () => place(`protected:${ownerId}`, cfg.protectedRoot, `${rootFolder.name} — trashed in CRM`, cfg.privateDriveId)

    // the owner's root in Drive
    const byParent = new Map<string | null, OwnerSnap["folders"]>()
    for (const f of snap.folders) byParent.set(f.parent_id, [...(byParent.get(f.parent_id) ?? []), f])
    const rootFolder = (byParent.get(null) ?? [])[0]
    if (!rootFolder) throw new Error("store backup: owner has no root folder")

    // ensure OUR mirror of a folder (adopted folders are fixed: verified, never renamed or moved)
    const ensureOurFolder = async (crmId: string, parentId: string, name: string): Promise<string> => {
      const ref = snap.backupRefs.get(crmId)
      if (ref?.drive_path?.adopted) {
        const it = await io.get(ref.external_id)
        if (it && !it.trashed) { rep.folders++; return it.id }
      }
      let item = ref && !ref.drive_path?.adopted ? await io.get(ref.external_id) : null
      if (item?.trashed) item = null
      if (!item) item = (await io.find("crm_folder_id", crmId, drives)).find((f) => !f.trashed) ?? null
      if (!item) {
        item = await io.createFolder(parentId, name, { crm_folder_id: crmId })
        if (ref) rep.recreated++
      } else if (item.name !== name || !(item.parents ?? []).includes(parentId)) {
        item = await io.patch(item.id, { name, newParentId: (item.parents ?? []).includes(parentId) ? undefined : parentId })
        rep.moved++
      }
      await io.recordRef("folder", crmId, item.id, null, { area: "live", parent: parentId, adopted: false })
      rep.folders++
      return item.id
    }
    const adoptFolder = async (crmId: string, driveId: string, parentId: string | null) => {
      await io.recordRef("folder", crmId, driveId, null, { area: "live", parent: parentId, adopted: true })
      rep.folders++
      return driveId
    }

    let rootDrive: string
    let rootAdopted = false
    if (snap.kind === "company" && snap.accountFolderId && !snap.accountFolderTakenByOther
        && (await io.get(snap.accountFolderId).then((x) => !!x && !x.trashed))) {
      rootDrive = await adoptFolder(rootFolder.id, snap.accountFolderId, null)
      rootAdopted = true
    } else {
      let parent: string
      if (snap.kind === "company") {
        const st = stateFolderName(snap.state)
        parent = st ? await place(`state:${st}`, cfg.companiesRoot, st, cfg.mainDriveId)
                    : await place("unplaced", cfg.companiesRoot, "_Unplaced — state missing in the CRM", cfg.mainDriveId)
      } else if (snap.kind === "formation") {
        parent = await place("in_formation", cfg.companiesRoot, "_In formation", cfg.mainDriveId)
      } else if (snap.kind === "person") {
        parent = await place("people", cfg.restrictedRoot, "People", cfg.privateDriveId)
      } else {
        parent = await place("unfiled", cfg.restrictedRoot, "Unfiled", cfg.privateDriveId)
      }
      rootDrive = await ensureOurFolder(rootFolder.id, parent, rootFolder.name)
    }

    // folders, top-down; inside an adopted root, existing sub-folders with the same name are adopted
    const mirror = new Map<string, string>([[rootFolder.id, rootDrive]])
    const walk = async (folderId: string, driveParent: string, parentAdopted: boolean) => {
      const existing = parentAdopted ? await io.childFolders(driveParent, cfg.mainDriveId) : []
      for (const child of byParent.get(folderId) ?? []) {
        const ref = snap.backupRefs.get(child.id)
        if (child.trashed_at) {
          if (ref && !ref.drive_path?.adopted && ref.drive_path?.area !== "protected") {   // OUR empty mirror → protected area
            const it = await io.get(ref.external_id)
            if (it && !it.trashed) await io.patch(it.id, { newParentId: await protectedArea() })
            await io.recordRef("folder", child.id, ref.external_id, null, { area: "protected" })
          }
          continue
        }
        const match = !ref ? existing.find((f) => norm(f.name) === norm(child.name)) : undefined
        const id = ref?.drive_path?.adopted || match
          ? await adoptFolder(child.id, ref?.drive_path?.adopted ? ref.external_id : match!.id, driveParent)
          : await ensureOurFolder(child.id, driveParent, child.name)
        mirror.set(child.id, id)
        await walk(child.id, id, !!(ref?.drive_path?.adopted || match))
      }
    }
    await walk(rootFolder.id, rootDrive, rootAdopted)

    // files — each one on its own: a failure is recorded, the others continue
    for (const f of snap.files) {
      if (timeUp()) {
        await io.finish(ownerId, token, "deferred", upTo)
        return { ...rep, status: "deferred" }
      }
      try {
        const ref = snap.backupRefs.get(f.id)
        const imp = snap.importRefs.get(f.id)
        if (f.state === "purged") {
          const copies = [...(ref ? [await io.get(ref.external_id)] : []), ...(await io.find("crm_file_id", f.id, drives))]
          for (const c of copies) if (c && !c.trashed) { await io.trash(c.id); rep.removed++ }
          if (ref && ref.status !== "purged") await io.recordRef("file", f.id, ref.external_id, ref.backed_up_sha256, { area: "purged" }, "purged")
          continue   // an imported original is fixed (#62): it is never deleted from Drive
        }
        if (!f.bucket || !f.path || !f.sha256) continue
        const area: "live" | "protected" = f.state === "live" && mirror.has(f.folder_id) ? "live" : "protected"
        // an imported original that still holds exactly these bytes IS the live copy — nothing to add
        if (area === "live" && !ref && imp && imp.backed_up_sha256 === f.sha256) continue
        const parentId = area === "live" ? mirror.get(f.folder_id)! : await protectedArea()
        // cheap path: nothing changed since the last run and no full check is due → no Drive call
        if (!full && ref && ref.status === "ok" && ref.backed_up_sha256 === f.sha256
            && ref.drive_path?.area === area && ref.drive_path?.parent === parentId && ref.drive_path?.name === f.name) continue
        // a file moved to another client meanwhile belongs to that client's run now
        if ((await io.currentOwner(f.id)) !== ownerId) { rep.skippedRehomed++; continue }
        const tags = { crm_file_id: f.id, crm_version_sha: f.sha256.slice(0, 64) }
        let item = ref ? await io.get(ref.external_id) : null
        if (item?.trashed) item = null
        const tagged = (await io.find("crm_file_id", f.id, drives)).filter((x) => !x.trashed)
        if (!item) item = tagged[0] ?? null
        if (full) for (const extra of tagged) if (item && extra.id !== item.id) { await io.trash(extra.id); rep.removed++ }   // stray duplicates of OUR copy
        if (!item) {
          item = await io.upload({ mode: "create", parentId, name: f.name, mimeType: f.mime || "application/octet-stream", size: f.size ?? 0,
                                    stream: await io.open(f.bucket, f.path), appProperties: tags })
          if (ref) rep.recreated++; else rep.uploaded++
        } else {
          const sameBytes = (ref && ref.backed_up_sha256 === f.sha256 && ref.external_id === item.id) || item.appProperties?.crm_version_sha === f.sha256.slice(0, 64)
          if (!sameBytes) {
            item = await io.upload({ mode: "update", fileId: item.id, name: f.name, mimeType: f.mime || "application/octet-stream", size: f.size ?? 0,
                                      stream: await io.open(f.bucket, f.path), appProperties: tags })
            rep.updated++
          }
          const inPlace = (item.parents ?? []).includes(parentId)
          if (item.name !== f.name || !inPlace) {
            const wasProtected = ref?.drive_path?.area === "protected"
            item = await io.patch(item.id, { name: f.name, newParentId: inPlace ? undefined : parentId })
            if (!inPlace && (area === "protected" || wasProtected)) rep.protectedMoves++; else rep.moved++
          }
        }
        await io.recordRef("file", f.id, item.id, f.sha256, { area, parent: parentId, name: f.name })
      } catch (e) {
        rep.fileErrors.push({ fileId: f.id, message: e instanceof Error ? e.message : String(e) })
      }
    }

    if (rep.fileErrors.length > 0) {
      const msg = `${rep.fileErrors.length} file(s) not backed up: ${rep.fileErrors.slice(0, 3).map((x) => `${x.fileId}: ${x.message}`).join("; ")}`
      await io.finish(ownerId, token, "failed", upTo, msg)
      return { ...rep, status: "failed", error: msg }
    }
    await io.finish(ownerId, token, "ok", upTo, undefined, full)
    return rep
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await io.finish(ownerId, token, "failed", upTo, msg).catch(() => undefined)
    return { ...rep, status: "failed", error: msg }
  }
}

// ─────────────────────────────────────────────────────────────── sweep (NOT scheduled — dark)

/** Queue one backup job per owner that needs it (never two for the same owner). Refuses while disabled. */
export async function sweepBackups(opts: { limit?: number } = {}): Promise<{ status: "disabled" } | { status: "queued"; owners: number }> {
  if (!backupEnabled()) return { status: "disabled" }
  const due = await rpc<Array<{ owner_id: string; reason: string }> | null>("store_backup_dirty_owners", { p_limit: opts.limit ?? 50 })
  const ids = (due ?? []).map((d) => d.owner_id)
  if (ids.length === 0) return { status: "queued", owners: 0 }
  const { data: pending, error } = await db().from("job_queue").select("payload").eq("job_type", BACKUP_JOB).in("status", ["pending", "processing"])
  if (error) throw new Error(`store backup: could not read the job queue: ${error.message}`)
  const busy = new Set((pending ?? []).map((p: { payload: { owner_id?: string } }) => p.payload?.owner_id))
  const jobs = (due ?? []).filter((d) => !busy.has(d.owner_id)).map((d) => ({
    job_type: BACKUP_JOB, payload: { owner_id: d.owner_id, full_check: d.reason === "check" } as never,
    related_entity_type: "store_owner", related_entity_id: d.owner_id,
  }))
  const { enqueueJobs } = await import("@/lib/jobs/queue")
  await enqueueJobs(jobs)          // one worker trigger for the whole batch
  return { status: "queued", owners: jobs.length }
}

/** The completeness alarm: counts per kind + a sample of each. */
export async function backupGaps(): Promise<{ counts: Record<string, number>; sample: Array<{ kind: string; owner_id: string; file_id: string | null; detail: string | null }> }> {
  const counts = (await rpc<Array<{ kind: string; n: number }> | null>("store_backup_gap_counts", {})) ?? []
  const sample = (await rpc<Array<{ kind: string; owner_id: string; file_id: string | null; detail: string | null }> | null>("store_backup_gaps", {})) ?? []
  return { counts: Object.fromEntries(counts.map((c) => [c.kind, Number(c.n)])), sample }
}
