/**
 * CRM Store — the PLAN-DRIVEN BUILD (job 685467b5; Antonio 2026-10-03: "put order in the mess and create the real
 * situation" — a one-off tool for the Drive → storage migration).
 *
 * The copy engine (drive-import.ts) files things by their Drive path and CRM label — which copies the mess. Here a
 * HAND-APPROVED PLAN says, per file: which Drive file, whose storage, which folder, what type, what name, which
 * e-signature certificates to merge into it. Claude reads the folders and proposes the plan; Antonio approves it on
 * the review page; this module builds exactly that, hidden:
 *
 *   • every new storage is "study only" (hidden, the CRM untouched), files are not published, no CRM row is created
 *     or re-pointed, and nothing is ever deleted on Drive;
 *   • it runs ON the import-run machinery (store_import_runs / store_import_items, mode "copy"): same claim, resume,
 *     report and UNDO guards as a study copy;
 *   • the approved plan's SHA-256 is pinned: a plan changed after approval is refused; the plan names every account
 *     and person it may touch, and every source file must be found in a fresh scan of the company's own Drive
 *     folder with the md5 and size the plan expects;
 *   • a merged PDF (document + certificates) is deterministic, so a retry never saves a new version.
 *
 * "Make real" (the storage becomes the CRM's source of truth) is NOT here: it needs its own decision.
 */

import { createHash } from "crypto"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { ImportItem, RunView } from "./drive-import"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export const PLAN_MARK = "PLAN"
export const PLAN_MAX_ITEMS = 300
const COMPANY_FOLDER_KINDS = ["company", "tax", "banking", "correspondence"] as const
const PERSON_FOLDER_KINDS = ["personal", "itin", "person_tax"] as const
/** one Drive file (or the sum of a merged document) may not pass the store's per-file limit */
export const PLAN_MAX_PART_BYTES = 50 * 1024 * 1024
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 .&'()-]{0,39}$/

export class PlanError extends Error {
  constructor(public readonly errors: string[]) { super(errors[0] ?? "The plan is not valid."); this.name = "PlanError" }
}

// ─────────────────────────────────────────────────────────────── the plan (pure)

const PartSchema = z.object({
  driveFileId: z.string().min(8).max(120),
  /** what Drive says today — the build refuses a file whose bytes or size differ */
  md5: z.string().regex(/^[0-9a-f]{32}$/, "md5 must be 32 hex characters"),
  size: z.number().int().positive().max(PLAN_MAX_PART_BYTES),
})
const OwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company"), accountId: z.string().uuid(), companyName: z.string().min(1).max(160) }),
  z.object({ kind: z.literal("person"), contactId: z.string().uuid(), fullName: z.string().min(1).max(160) }),
])
export const PlanItemSchema = z.object({
  key: z.string().min(1).max(40),
  source: PartSchema,
  /** e-signature certificate PDFs appended, in this order, to the source PDF → ONE complete document */
  appended: z.array(PartSchema).max(6).default([]),
  owner: OwnerSchema,
  /** must be true when the owner is another company than the plan's, or a person who is not a member of it */
  crossCompany: z.boolean().default(false),
  folder: z.object({
    kind: z.enum(["company", "tax", "banking", "correspondence", "personal", "itin", "person_tax"]),
    /** sub-folders below it: a year ("2024") inside Tax, "DBA" inside Company, "Correspondence" inside Personal */
    path: z.array(z.string().regex(SEGMENT, "folder names: letters, digits, spaces and . & ' ( ) -")).max(2).default([]),
  }),
  name: z.string().trim().min(1).max(160),
  documentType: z.string().regex(/^[a-z0-9_]{2,80}$/).nullable(),
  year: z.number().int().min(1990).max(2100).nullable(),
  /** REQUIRED for tax-return types (draft_never_visible): "filed" freezes the file (an amended file is saved instead); "draft" can never be shown to the client */
  filingStatus: z.enum(["none", "draft", "filed", "amended"]).optional(),
})
export const PlanSchema = z.object({
  company: z.string().min(1).max(160),
  accountId: z.string().uuid(),
  items: z.array(PlanItemSchema).min(1).max(PLAN_MAX_ITEMS),
  /** Drive files deliberately NOT imported (drafts, loose pieces) — they stay on Drive, untouched */
  leaveInDrive: z.array(z.string()).default([]),
  /** Drive files on hold (an open question) */
  hold: z.array(z.string()).default([]),
  notes: z.string().max(2000).optional(),
})
export type Plan = z.infer<typeof PlanSchema>
export type PlanItem = z.infer<typeof PlanItemSchema>

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
  return v
}
/** SHA-256 of the plan in a canonical form (key order and spacing never change it). */
export function planSha(plan: Plan): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(plan))).digest("hex")
}

const nameKey = (n: string) => n.trim().normalize("NFC").toLowerCase()

/** The name in the storage: the plan's name plus the file's extension (a merged document is always a PDF). */
export function finalName(planName: string, driveName: string | undefined, merged: boolean): string {
  const ext = merged ? ".pdf" : (driveName?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "").toLowerCase()
  if (!ext || planName.toLowerCase().endsWith(ext)) return planName
  return planName + ext
}
export const ownerRef = (o: PlanItem["owner"]) => (o.kind === "company" ? `company:${o.accountId}` : `person:${o.contactId}`)

/** Pure checks of the plan itself. Returns the parsed plan, or every problem found. */
export function validatePlan(raw: unknown): { plan: Plan | null; errors: string[] } {
  const parsed = PlanSchema.safeParse(raw)
  if (!parsed.success) return { plan: null, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`) }
  const plan = parsed.data
  const errors: string[] = []
  const seenKeys = new Set<string>()
  const seenDrive = new Map<string, string>()
  const claim = (id: string, role: string) => {
    const prev = seenDrive.get(id)
    if (prev) errors.push(`Drive file ${id} is listed twice (${prev} and ${role}).`)
    else seenDrive.set(id, role)
  }
  const targets = new Map<string, string>()
  for (const it of plan.items) {
    if (seenKeys.has(it.key)) errors.push(`Item key "${it.key}" is used twice.`)
    seenKeys.add(it.key)
    claim(it.source.driveFileId, `item ${it.key}`)
    for (const a of it.appended) claim(a.driveFileId, `certificate of item ${it.key}`)
    if (it.source.size + it.appended.reduce((n, a) => n + a.size, 0) > PLAN_MAX_PART_BYTES) errors.push(`Item ${it.key}: the document and its certificates together are over ${PLAN_MAX_PART_BYTES / 1048576} MB.`)
    const allowed: readonly string[] = it.owner.kind === "company" ? COMPANY_FOLDER_KINDS : PERSON_FOLDER_KINDS
    if (!allowed.includes(it.folder.kind)) errors.push(`Item ${it.key}: a ${it.owner.kind}'s storage has no "${it.folder.kind}" folder.`)
    if (/[\\/\u0000-\u001f]/.test(it.name)) errors.push(`Item ${it.key}: the name contains a slash or control character.`)
    if (/\b\d{9,}\b/.test(it.name) || /\b\d{3}-\d{2}-\d{4}\b/.test(it.name) || /\b\d{2}-\d{7}\b/.test(it.name)) errors.push(`Item ${it.key}: a file name must never carry an ID or tax number.`)
    if (it.owner.kind === "company" && it.owner.accountId !== plan.accountId && !it.crossCompany) errors.push(`Item ${it.key} goes to another company (${it.owner.companyName}) — mark it crossCompany on purpose.`)
    const t = `${ownerRef(it.owner)}|${it.folder.kind}|${it.folder.path.map(nameKey).join("/")}|${nameKey(it.name)}`
    if (targets.has(t)) errors.push(`Items ${targets.get(t)} and ${it.key} would have the same name in the same folder.`)
    else targets.set(t, it.key)
  }
  for (const id of plan.leaveInDrive) claim(id, "leave in Drive")
  for (const id of plan.hold) claim(id, "on hold")
  return { plan: errors.length ? null : plan, errors }
}

// ─────────────────────────────────────────────────────────────── ledger encoding (items carry their placement)

export interface PlanItemRecord { sha: string; item: PlanItem }
/** store_import_items.drive_path = ["PLAN", planSha, JSON of the item] — the placement travels with the ledger row. */
export const encodeItem = (sha: string, item: PlanItem): string[] => [PLAN_MARK, sha, JSON.stringify(item)]
export function decodeItem(drivePath: unknown): PlanItemRecord | null {
  if (!Array.isArray(drivePath) || drivePath[0] !== PLAN_MARK || typeof drivePath[1] !== "string" || typeof drivePath[2] !== "string") return null
  try {
    const item = PlanItemSchema.parse(JSON.parse(drivePath[2]))
    return { sha: drivePath[1], item }
  } catch { return null }
}

export async function isPlanRun(runId: string): Promise<boolean> {
  const { data } = await db().from("store_import_items").select("drive_path").eq("run_id", runId).limit(1)
  const first = (data ?? [])[0] as { drive_path?: unknown } | undefined
  return Array.isArray(first?.drive_path) && first?.drive_path[0] === PLAN_MARK
}

// ─────────────────────────────────────────────────────────────── checks against the live system

export interface PlanReportItem {
  key: string; name: string; owner: string; folder: string; type: string | null; year: number | null
  merged: number; bytes: number; problems: string[]
}
export interface PrepareResult { errors: string[]; warnings: string[]; items: PlanReportItem[]; counts: { items: number; merges: number; leaveInDrive: number; hold: number; owners: number } }

export function planBuildEnabled(): boolean {
  return process.env.STORE_PLAN_BUILD === "1"
}

interface TypeInfo { personal: boolean; draftNeverVisible: boolean }
async function loadTypes(): Promise<Map<string, TypeInfo>> {
  const { data, error } = await db().from("catalog_entries").select("slug, metadata").eq("catalog_id", "storage_document_types").eq("status", "active")
  if (error) throw new Error(`Could not read the document types (${error.message}).`)
  return new Map(((data ?? []) as { slug: string; metadata: { personal?: boolean; draft_never_visible?: boolean } | null }[])
    .map((t) => [t.slug, { personal: t.metadata?.personal === true, draftNeverVisible: t.metadata?.draft_never_visible === true }]))
}

interface OwnerState { ref: string; label: string; ownerId: string | null; studyOnly: boolean | null; files: number; folderKinds: Set<string> | null; problems: string[] }

/** Everything that can be checked WITHOUT writing: the plan against Drive, the CRM and the storage. */
export async function prepare(plan: Plan): Promise<PrepareResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const { pilotEnvironmentAllowed } = await import("./formation-pilot")
  if (!pilotEnvironmentAllowed() && !planBuildEnabled()) throw new PlanError(["The plan-driven build is not switched on here."])

  const { data: acct, error: aErr } = await db().from("accounts").select("id, company_name, drive_folder_id").eq("id", plan.accountId).maybeSingle()
  if (aErr) throw new Error(`Could not read the company (${aErr.message}).`)
  if (!acct) throw new PlanError([`The company ${plan.accountId} does not exist.`])
  if (nameKey(acct.company_name as string) !== nameKey(plan.company)) errors.push(`The plan is for "${plan.company}" but that account is "${acct.company_name}".`)
  if (!acct.drive_folder_id) throw new PlanError(["This company has no Drive folder."])
  const folder = acct.drive_folder_id as string

  // another account or a contact on the same Drive folder → the files could belong to someone else
  const [{ count: others }, { count: contactHolders }] = await Promise.all([
    db().from("accounts").select("id", { count: "exact", head: true }).eq("drive_folder_id", folder).neq("id", plan.accountId),
    db().from("contacts").select("id", { count: "exact", head: true }).eq("drive_folder_id", folder),
  ])
  if ((others ?? 0) > 0 || (contactHolders ?? 0) > 0) errors.push("This company's Drive folder is shared with another account or a contact — it cannot be built from a plan.")

  // a start whose request died before it finished is closed after 10 minutes (as the copy tool does)
  await closeStaleScans(plan.accountId)
  // an earlier copy/move/build of this company that is still standing must be undone first
  const { data: runs } = await db().from("store_import_runs").select("id, mode, status").eq("account_id", plan.accountId).not("status", "in", "(rolled_back,failed)")
  if ((runs ?? []).length) errors.push("This company already has a copy or build in the new storage — remove (undo) it first, then build.")

  const { assertMayImportFrom, scanDrive } = await import("./drive-import")
  await assertMayImportFrom(folder, "copy")

  // every source file must be in a fresh scan of THIS company's own Drive folder with the md5 and size the plan expects
  const scan = await scanDrive(folder)
  const byId = new Map(scan.map((s) => [s.source_id, s]))
  const types = await loadTypes()

  // owners: who is touched, are they hidden/empty
  const owners = new Map<string, OwnerState>()
  const members = new Set<string>(((await db().from("account_contacts").select("contact_id").eq("account_id", plan.accountId)).data ?? []).map((r: { contact_id: string }) => r.contact_id))
  const ownerState = async (o: PlanItem["owner"]): Promise<OwnerState> => {
    const ref = ownerRef(o)
    const hit = owners.get(ref)
    if (hit) return hit
    const st: OwnerState = { ref, label: o.kind === "company" ? o.companyName : o.fullName, ownerId: null, studyOnly: null, files: 0, folderKinds: null, problems: [] }
    if (o.kind === "company") {
      const { data: a } = await db().from("accounts").select("company_name").eq("id", o.accountId).maybeSingle()
      if (!a) st.problems.push(`the company ${o.accountId} does not exist`)
      else if (nameKey(a.company_name as string) !== nameKey(o.companyName)) st.problems.push(`the plan says "${o.companyName}" but the account is "${a.company_name}"`)
    } else {
      const { data: c } = await db().from("contacts").select("full_name").eq("id", o.contactId).maybeSingle()
      if (!c) st.problems.push(`the person ${o.contactId} does not exist`)
      else if (nameKey(c.full_name as string) !== nameKey(o.fullName)) st.problems.push(`the plan says "${o.fullName}" but the contact is "${c.full_name}"`)
    }
    const q = db().from("store_owners").select("id, study_only")
    const { data: row } = o.kind === "company" ? await q.eq("kind", "company").eq("account_id", o.accountId).maybeSingle() : await q.eq("kind", "person").eq("contact_id", o.contactId).maybeSingle()
    if (row) {
      st.ownerId = row.id as string
      st.studyOnly = row.study_only as boolean
      const { count } = await db().from("store_files").select("id", { count: "exact", head: true }).eq("owner_id", row.id).eq("state", "live")
      st.files = count ?? 0
      const { data: fk } = await db().from("store_folders").select("kind").eq("owner_id", row.id).is("trashed_at", null)
      st.folderKinds = new Set(((fk ?? []) as { kind: string }[]).map((f) => f.kind))
      if (!st.studyOnly) {
        const { count: any } = await db().from("store_files").select("id", { count: "exact", head: true }).eq("owner_id", row.id)
        if ((any ?? 0) > 0) st.problems.push("its storage is already live (in use) — a plan can only build into a hidden or empty storage")
        else warnings.push(`${st.label}: its storage exists, is live and EMPTY — it will be hidden first.`)
      }
      // a company's storage holds only its own plan; a PERSON's hidden storage may already hold files of another company they belong to
      if (o.kind === "company" && st.files > 0) st.problems.push(`its storage already holds ${st.files} file(s) — remove the earlier copy (undo) first so the plan builds into an empty storage`)
    }
    owners.set(ref, st)
    return st
  }

  // the company's own storage is checked even when no item targets it
  const own = await ownerState({ kind: "company", accountId: plan.accountId, companyName: plan.company })
  for (const pr of own.problems) errors.push(`${own.label}: ${pr}`)
  const finalNames = new Map<string, string>()
  const items: PlanReportItem[] = []
  for (const it of plan.items) {
    const problems: string[] = []
    for (const part of [it.source, ...it.appended]) {
      const s = byId.get(part.driveFileId)
      if (!s) { problems.push(`Drive file ${part.driveFileId} is not in this company's Drive folder`); continue }
      if (s.source_md5 && s.source_md5 !== part.md5) problems.push(`Drive file ${s.name}: its content changed since the plan was made (md5 differs)`)
      if (s.size_bytes != null && Number(s.size_bytes) !== part.size) problems.push(`Drive file ${s.name}: its size changed since the plan was made`)
      if (!s.source_md5) problems.push(`Drive file ${s.name}: Drive gives no checksum for it (a Google-native file cannot be copied)`)
    }
    if (it.appended.length) {
      for (const part of [it.source, ...it.appended]) {
        const s = byId.get(part.driveFileId)
        if (s && s.mime_type !== "application/pdf") problems.push(`${s.name} is not a PDF — only PDFs can be merged`)
      }
    }
    const st = await ownerState(it.owner)
    if (st.ownerId !== own.ownerId || it.owner.kind === "person") for (const p of st.problems) problems.push(`${st.label}: ${p}`)
    // the folder must exist for that owner (an existing storage is read; a new one gets its template, checked in validatePlan)
    if (st.folderKinds && !st.folderKinds.has(it.folder.kind)) problems.push(`${st.label}'s storage has no "${it.folder.kind}" folder`)
    const drive0 = byId.get(it.source.driveFileId)
    const shown = finalName(it.name, drive0?.name, it.appended.length > 0)
    const nameSlot = `${ownerRef(it.owner)}|${it.folder.kind}|${it.folder.path.map(nameKey).join("/")}|${nameKey(shown)}`
    if (finalNames.has(nameSlot)) problems.push(`the same final name "${shown}" is used by item ${finalNames.get(nameSlot)}`)
    else finalNames.set(nameSlot, it.key)
    if (it.owner.kind === "person" && !members.has(it.owner.contactId) && !it.crossCompany) problems.push(`${it.owner.fullName} is not a member of ${plan.company} — mark it crossCompany on purpose`)
    // the document type: personal types only in a person's storage, and a person's storage takes only personal types
    if (it.documentType) {
      const t = types.get(it.documentType)
      if (!t) problems.push(`the document type "${it.documentType}" does not exist`)
      else if (t.personal && it.owner.kind !== "person") problems.push(`"${it.documentType}" is a personal type — it can only go in a person's storage`)
      else if (!t.personal && it.owner.kind === "person") problems.push(`"${it.documentType}" is not a personal type — a person's storage takes only personal documents`)
      if (t?.draftNeverVisible && !it.filingStatus) problems.push(`"${it.documentType}" is a tax-return type — say whether it is filed, a draft or amended (filingStatus)`)
    } else if (it.owner.kind === "person") warnings.push(`Item ${it.key} (${it.name}) has no type and goes in a person's storage — check it by hand.`)
    items.push({
      key: it.key, name: shown, owner: st.label, folder: [it.folder.kind, ...it.folder.path].join(" / "), type: it.documentType, year: it.year,
      merged: it.appended.length, bytes: it.source.size + it.appended.reduce((n, a) => n + a.size, 0), problems,
    })
    for (const p of problems) errors.push(`Item ${it.key} (${it.name}): ${p}`)
  }
  // the files the plan leaves in Drive / holds must exist in the folder too (a typo would hide a file)
  for (const id of [...plan.leaveInDrive, ...plan.hold]) if (!byId.has(id)) warnings.push(`Drive file ${id} (left in Drive / on hold) is not in this company's Drive folder.`)
  return { errors, warnings, items, counts: { items: plan.items.length, merges: plan.items.filter((i) => i.appended.length).length, leaveInDrive: plan.leaveInDrive.length, hold: plan.hold.length, owners: owners.size } }
}

// ─────────────────────────────────────────────────────────────── start

/** A "scanning" run whose request died is closed as failed after 10 minutes (so the company is never locked for good). */
async function closeStaleScans(accountId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString()
  await db().from("store_import_runs").update({ status: "failed", finished_at: new Date().toISOString(), report: { error: "The start stopped before it finished." } })
    .eq("account_id", accountId).eq("status", "scanning").lt("updated_at", cutoff)
}

/** A new storage must never be live: it is hidden at once (an EMPTY live storage is safe to hide; a used one is refused). */
async function ensureHidden(ownerId: string): Promise<void> {
  const { data, error } = await db().from("store_owners").select("study_only").eq("id", ownerId).maybeSingle()
  if (error || !data) throw new Error(`The storage could not be read (${error?.message ?? "missing"}).`)
  if (data.study_only === true) return
  const { count } = await db().from("store_files").select("id", { count: "exact", head: true }).eq("owner_id", ownerId)
  if ((count ?? 0) > 0) throw new Error("A storage that is already in use cannot be built into by a plan.")
  const { data: hid, error: uErr } = await db().from("store_owners").update({ study_only: true }).eq("id", ownerId).eq("study_only", false).select("id")
  if (uErr) throw new Error(`The storage could not be hidden (${uErr.message}).`)
  if (!(hid ?? []).length) { // someone else changed it meanwhile: read again, it must be hidden now
    const { data: again } = await db().from("store_owners").select("study_only").eq("id", ownerId).maybeSingle()
    if (again?.study_only !== true) throw new Error("The storage could not be hidden.")
  }
}

async function ensureOwnerHidden(o: PlanItem["owner"]): Promise<string> {
  const formation = await import("./formation-pilot")
  let ownerId: string
  if (o.kind === "company") {
    const { data: id, error } = await db().rpc("store_ensure_owner", { p_kind: "company", p_ref: o.accountId })
    if (error || !id) throw new Error(`The storage of ${o.companyName} could not be created (${error?.message ?? "no id"}).`)
    ownerId = id as string
    await ensureHidden(ownerId) // hidden BEFORE any folder or file exists
    const { error: tErr } = await db().rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: formation.COMPANY_TEMPLATE, p_root_name: formation.storeSafeFolderName(o.companyName) })
    if (tErr) throw new Error(`The folders of ${o.companyName} could not be created (${tErr.message}).`)
  } else {
    const { data: id, error } = await db().rpc("store_ensure_owner", { p_kind: "person", p_ref: o.contactId })
    if (error || !id) throw new Error(`The storage of ${o.fullName} could not be created (${error?.message ?? "no id"}).`)
    ownerId = id as string
    await ensureHidden(ownerId)
    await formation.ensurePersonOwner(o.contactId, o.fullName) // applies the personal template (idempotent)
  }
  await ensureHidden(ownerId)
  return ownerId
}

export type StartResult = { dryRun: true; planSha: string; report: PrepareResult } | { dryRun: false; planSha: string; run: RunView }

/** Dry run (read-only) or start: validates, pins the approved sha, checks, hides the storages, writes the ledger. */
export async function startPlanBuild(raw: unknown, opts: { approvedSha: string; actorId: string | null; dryRun: boolean }): Promise<StartResult> {
  const { plan, errors } = validatePlan(raw)
  if (!plan) throw new PlanError(errors)
  const sha = planSha(plan)
  if (sha !== opts.approvedSha) throw new PlanError([`This plan is not the one that was approved (its fingerprint is ${sha.slice(0, 12)}…, the approved one is ${opts.approvedSha.slice(0, 12)}…).`])
  const report = await prepare(plan)
  if (opts.dryRun) return { dryRun: true, planSha: sha, report }
  if (report.errors.length) throw new PlanError(report.errors)
  if (!opts.actorId) throw new PlanError(["Only a signed-in owner can start a build."])

  const { data: acct } = await db().from("accounts").select("drive_folder_id").eq("id", plan.accountId).maybeSingle()
  const { data: run, error: rErr } = await db().from("store_import_runs")
    .insert({ account_id: plan.accountId, drive_folder_id: acct?.drive_folder_id, status: "scanning", started_by: opts.actorId, mode: "copy" }).select("id").single()
  if (rErr) throw new Error(/uq_store_import_runs_open|duplicate/i.test(rErr.message) ? "A build of this company is already running." : `The build could not start (${rErr.message}).`)
  const made: string[] = []
  try {
    const refs = new Map<string, PlanItem["owner"]>()
    for (const it of plan.items) refs.set(ownerRef(it.owner), it.owner)
    // the company's own storage first (the run's owner), every owner hidden the moment it exists
    const companyOwner = await ensureOwnerHidden({ kind: "company", accountId: plan.accountId, companyName: plan.company })
    made.push(companyOwner)
    for (const [ref, o] of Array.from(refs.entries())) if (ref !== `company:${plan.accountId}`) made.push(await ensureOwnerHidden(o))
    const { scanDrive } = await import("./drive-import")
    const byId = new Map((await scanDrive(acct?.drive_folder_id as string)).map((s) => [s.source_id, s]))
    const rows = plan.items.map((it) => ({
      run_id: run.id, source: "drive", source_id: it.source.driveFileId, drive_path: encodeItem(sha, it), name: it.name,
      mime_type: byId.get(it.source.driveFileId)?.mime_type ?? null, size_bytes: it.source.size, source_md5: it.source.md5, status: "pending",
    }))
    // the ledger name is the FINAL name in the storage (with the file's extension)
    rows.forEach((r, i) => { r.name = finalName(plan.items[i].name, byId.get(plan.items[i].source.driveFileId)?.name, plan.items[i].appended.length > 0) })
    const { error } = await db().from("store_import_items").upsert(rows, { onConflict: "run_id,source,source_id", ignoreDuplicates: true })
    if (error) throw new Error(`The file list could not be saved (${error.message}).`)
    const { error: mErr } = await db().from("store_import_runs").update({ owner_id: companyOwner, status: "moving", updated_at: new Date().toISOString() }).eq("id", run.id)
    if (mErr) throw new Error(`The build could not be opened (${mErr.message}).`)
  } catch (e) {
    for (const id of made) { try { await ensureHidden(id) } catch { /* an owner that cannot be hidden stays refused by every write */ } }
    await db().from("store_import_runs").update({ status: "failed", finished_at: new Date().toISOString(), report: { error: e instanceof Error ? e.message : String(e) } }).eq("id", run.id)
    throw e
  }
  const { runView } = await import("./drive-import")
  return { dryRun: false, planSha: sha, run: await runView(run.id as string) }
}

// ─────────────────────────────────────────────────────────────── build (one batch)

const md5Hex = (b: Buffer) => createHash("md5").update(b).digest("hex")
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex")

async function folderOfKindIn(ownerId: string, kind: string): Promise<string> {
  const { data, error } = await db().from("store_folders").select("id, parent_id").eq("owner_id", ownerId).eq("kind", kind).is("trashed_at", null)
  if (error) throw new Error(`Could not read the folders (${error.message}).`)
  const rows = (data ?? []) as { id: string; parent_id: string | null }[]
  const hit = rows.find((r) => r.parent_id !== null) ?? rows[0]
  if (!hit) throw new Error(`The storage has no "${kind}" folder.`)
  return hit.id
}

async function ownerIdOf(o: PlanItem["owner"]): Promise<string> {
  const q = db().from("store_owners").select("id, study_only")
  const { data, error } = o.kind === "company" ? await q.eq("kind", "company").eq("account_id", o.accountId).maybeSingle() : await q.eq("kind", "person").eq("contact_id", o.contactId).maybeSingle()
  if (error || !data) throw new Error(`The storage of ${o.kind === "company" ? o.companyName : o.fullName} is missing.`)
  if (data.study_only !== true) throw new Error(`The storage of ${o.kind === "company" ? o.companyName : o.fullName} is not hidden — a plan never writes into a live storage.`)
  return data.id as string
}

async function downloadChecked(part: PlanItem["source"]): Promise<Buffer> {
  const { downloadBinaryAnyDrive } = await import("@/lib/google-drive")
  const bytes = await downloadBinaryAnyDrive(part.driveFileId)
  if (bytes.length !== part.size) throw new Error(`Drive gave ${bytes.length} bytes, the plan expects ${part.size} — the download is incomplete or the file changed.`)
  if (md5Hex(bytes) !== part.md5) throw new Error("Drive's file does not match the checksum in the plan — the file changed.")
  return bytes
}

async function buildOne(it: ImportItem, runId: string, actorId: string | null): Promise<Partial<ImportItem>> {
  const rec = decodeItem(it.drive_path)
  if (!rec) return { status: "failed", reason: "This ledger row does not carry a valid plan item." }
  const { item } = rec
  const ownerId = await ownerIdOf(item.owner)
  const { data: t } = item.documentType ? await db().from("catalog_entries").select("metadata").eq("catalog_id", "storage_document_types").eq("slug", item.documentType).eq("status", "active").maybeSingle() : { data: null }
  if (item.documentType && !t) return { status: "failed", reason: `The document type "${item.documentType}" does not exist.` }
  const personal = (t?.metadata as { personal?: boolean } | null)?.personal === true
  if (personal && item.owner.kind !== "person") return { status: "failed", reason: "A personal document can only go in a person's storage." }
  if (!personal && item.documentType && item.owner.kind === "person") return { status: "failed", reason: "A person's storage takes only personal documents." }

  // bytes: the document, checked against the plan; certificates appended into ONE deterministic PDF
  const main = await downloadChecked(item.source)
  let bytes = main
  let mime = it.mime_type
  const parts: Array<{ id: string; sha: string }> = [{ id: item.source.driveFileId, sha: sha256Hex(main) }]
  if (item.appended.length) {
    const certs: Buffer[] = []
    for (const a of item.appended) { const b = await downloadChecked(a); certs.push(b); parts.push({ id: a.driveFileId, sha: sha256Hex(b) }) }
    const { mergePdfs } = await import("./pdf-merge")
    bytes = (await mergePdfs([main, ...certs])).bytes
    mime = "application/pdf"
  }
  const { IMPORT_MAX_FILE_BYTES } = await import("./drive-import")
  if (bytes.length > IMPORT_MAX_FILE_BYTES) return { status: "failed", reason: `Too large for the new storage (${Math.round(bytes.length / 1048576)} MB).` }

  // the folder (sub-folders are made on the spot; a year inside Tax becomes a real tax-year folder)
  const base = await folderOfKindIn(ownerId, item.folder.kind)
  const { ensureFolderPath } = await import("./extras")
  const folderId = item.folder.path.length ? (await ensureFolderPath(base, item.folder.path, actorId)).id : base

  // the planned name must be free (a plan never renames silently)
  const callerKey = `drive-import:${runId}:drive:${item.source.driveFileId}`
  const { storeNameKey } = await import("./rules")
  const { data: live } = await db().from("store_files").select("name, caller_key").eq("folder_id", folderId).eq("state", "live")
  const finalNm = it.name // the ledger holds the final name (plan name + extension)
  const clash = ((live ?? []) as { name: string; caller_key: string | null }[]).find((f) => f.caller_key !== callerKey && storeNameKey(f.name) === storeNameKey(finalNm))
  if (clash) return { status: "failed", reason: `A file named "${finalNm}" is already in that folder.` }

  const { saveBytesToStore } = await import("./writer")
  const w = await saveBytesToStore({
    ownerId, folderId, name: finalNm, mimeType: mime, bytes, callerKey, contentChanged: true,
    documentType: item.documentType, published: false, actor: actorId, ...(item.year ? { periodYear: item.year } : {}),
    ...(item.filingStatus ? { filingStatus: item.filingStatus } : {}),
  })
  if (w.status === "versioned") return { status: "failed", reason: "An earlier attempt saved different content under this plan item — undo the build and run it again.", store_file_id: w.fileId }
  if (w.status !== "created" && w.status !== "unchanged") return { status: "failed", reason: `The new storage refused it (${w.status}).`, store_file_id: w.fileId }
  // it must really be where the plan put it (a retry of an edited plan must not report success for a file elsewhere)
  const { data: placed } = await db().from("store_files").select("owner_id, folder_id, name").eq("id", w.fileId).maybeSingle()
  if (!placed || placed.owner_id !== ownerId || placed.folder_id !== folderId || placed.name !== finalNm) {
    return { status: "failed", reason: "The file is not where the plan puts it (an earlier attempt left it elsewhere) — undo the build and run it again.", store_file_id: w.fileId }
  }
  const finalSha = sha256Hex(bytes)
  // the backup records the Drive original this file came from (one record per file: the DOCUMENT; the certificates' Drive
  // ids stay in the ledger row, which keeps the whole plan item). Everything on Drive is untouched.
  const merged = item.appended.length ? `Merged with ${item.appended.length} signing certificate(s) into one document (Drive originals: ${item.appended.map((a) => a.driveFileId).join(", ")}).` : null
  const { error: refErr } = await db().rpc("store_import_record_ref", { p_file_id: w.fileId, p_drive_file_id: parts[0].id, p_sha256: parts[0].sha, p_drive_path: { area: "plan", key: item.key } })
  const note = [merged, refErr ? `The backup could not record the Drive original (${refErr.message}).` : null].filter(Boolean).join(" ") || null
  return { status: "done", store_file_id: w.fileId, sha256: finalSha, landed_in: await landedIn(folderId, ownerId), repointed: [], reason: note }
}

async function landedIn(folderId: string, ownerId: string): Promise<string | null> {
  try { const { pathOf } = await import("./drive-import"); return await pathOf(folderId, ownerId) } catch { return null }
}

/** One batch of the build: claim, build, record; the last batch closes the run. Resumable (the claim hands a dead request's files on). */
export async function continuePlanBuild(runId: string, actorId: string | null, budget: { files: number; ms: number }): Promise<RunView> {
  const t0 = Date.now()
  const { runView, finishRun } = await import("./drive-import")
  const { data: run, error } = await db().from("store_import_runs").select("id, owner_id, status").eq("id", runId).maybeSingle()
  if (error || !run) throw new Error("Build not found.")
  if (run.status !== "moving") return runView(runId)
  const { data: claimed, error: pErr } = await db().rpc("store_import_claim", { p_run_id: runId, p_limit: budget.files })
  if (pErr) throw new Error(`Could not read the files to build (${pErr.message}).`)
  const list = (claimed ?? []) as ImportItem[]
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    if (Date.now() - t0 > budget.ms) {
      await db().from("store_import_items").update({ status: "pending", updated_at: new Date().toISOString() }).in("id", list.slice(i).map((x) => x.id)).eq("status", "working")
      break
    }
    let patch: Partial<ImportItem>
    try { patch = await buildOne(it, runId, actorId) } catch (e) { patch = { status: "failed", reason: e instanceof Error ? e.message : String(e) } }
    await db().from("store_import_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", it.id).eq("status", "working")
  }
  const { count } = await db().from("store_import_items").select("id", { count: "exact", head: true }).eq("run_id", runId).in("status", ["pending", "working"])
  if ((count ?? 0) === 0) await finishRun(runId, run.owner_id as string, "copy")
  return runView(runId)
}
