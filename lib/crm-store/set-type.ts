/**
 * "Set type" on a file in the NEW CRM store (job 685467b5) — give a file its document type, or CORRECT a wrong one
 * (Antonio 2026-09-29: the Drive folders hold documents labelled wrongly). One place for every rule a type brings:
 *   - a PERSONAL type (passport, ID …) on a company's file → asks whose it is and re-homes the SAME file into that
 *     person's storage (store_rehome_file: record, versions, move ledger and backup stay attached);
 *   - a company type on a file in a person's storage → asks: move it to one of the person's companies, or keep it;
 *   - a staff-only type on a file the client sees → hidden first (refused if its workspace always shows it);
 *   - a tax-return type (draft_never_visible) on a file the client already sees → asks: it is the filed copy, or hide it;
 *   - a filed return keeps its type (frozen);
 *   - the file's CRM record follows (type, category, person); a record the Drive move left on Drive because the file
 *     had no type now opens from the new storage, with the same visibility.
 * A needed answer comes back as a question (SetTypeQuestionError) — nothing has changed when it is asked.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export type SetTypeQuestion =
  | { kind: "person"; typeName: string; people: Array<{ contactId: string; name: string }> }
  | { kind: "company"; typeName: string; personName: string; companies: Array<{ ownerId: string; name: string }>; clientSees: boolean }
  | { kind: "filed"; typeName: string }

export class SetTypeQuestionError extends Error {
  constructor(public readonly question: SetTypeQuestion) {
    super("An answer is needed before the type can be set.")
    this.name = "SetTypeQuestionError"
  }
}

export interface SetTypeInput {
  fileId: string
  typeSlug: string
  actorId: string | null
  /** answer to "whose document is it?" */
  personContactId?: string | null
  /** answer to "move it to which company?" — "keep" keeps it in the person's storage */
  companyOwnerId?: string | null
  /** answer to "the client already sees this return" */
  filedAnswer?: "filed" | "hide" | null
  /** the storage the staff member is looking at (a company page) — the answer only when nobody can be surprised */
  viewingOwnerId?: string | null
  /** Re-check types refreshes the move's report once at the end */
  skipReportRefresh?: boolean
}

export interface SetTypeResult { typeName: string; movedTo: string | null; visible: boolean; notes: string[]; recordsFollowed: number }

interface FileRow {
  id: string; name: string; owner_id: string; folder_id: string; document_type: string | null; state: string; published: boolean
  filing_status: string | null; period_year: number | null; needs_review_at: string | null
  store_owners: { kind: string; account_id: string | null; contact_id: string | null }
}
interface TypeRow { id: string; slug: string; display_name: string; status: string; metadata: Record<string, unknown> | null }

/** Pure: the question a type change needs before anything may change, or null. Unit-tested. */
export function questionFor(p: {
  ownerKind: string; personal: boolean; draftNeverVisible: boolean; published: boolean; filingStatus: string | null; typeName: string
  hasPerson: boolean; hasCompanyAnswer: boolean; hasFiledAnswer: boolean
  people: Array<{ contactId: string; name: string }>; companies: Array<{ ownerId: string; name: string }>; personName: string
}): SetTypeQuestion | null {
  if (p.personal && p.ownerKind === "company" && !p.hasPerson) return { kind: "person", typeName: p.typeName, people: p.people }
  if (!p.personal && p.ownerKind === "person" && !p.hasCompanyAnswer && p.companies.length > 0) {
    return { kind: "company", typeName: p.typeName, personName: p.personName, companies: p.companies, clientSees: p.published }
  }
  if (p.draftNeverVisible && p.published && p.filingStatus !== "filed" && !p.hasFiledAnswer) return { kind: "filed", typeName: p.typeName }
  return null
}

/** Pure: may "the company page it is opened from" answer the company question? Only when nobody can be surprised:
 *  the person is in that one company and the client does not see the file (else every co-member would). */
export function autoCompanyAnswer(companies: Array<{ ownerId: string }>, viewingOwnerId: string | null | undefined, clientSees: boolean): string | null {
  if (!viewingOwnerId || clientSees || companies.length !== 1 || companies[0].ownerId !== viewingOwnerId) return null
  return viewingOwnerId
}

async function readFile(fileId: string): Promise<FileRow> {
  const { data, error } = await db().from("store_files")
    .select("id, name, owner_id, folder_id, document_type, state, published, filing_status, period_year, needs_review_at, store_owners!inner(kind, account_id, contact_id)")
    .eq("id", fileId).maybeSingle()
  if (error) throw new Error(`Could not read the file — please try again (${error.message}).`)
  if (!data) throw new Error("File not found.")
  if (data.state !== "live") throw new Error("Restore the file from the trash first.")
  return data as FileRow
}

/** The company's people as its "2. Contacts" shows them (live links whose role appears there) — never a former member. */
async function companyMembers(accountId: string): Promise<Array<{ contactId: string; name: string }>> {
  const { data: links, error } = await db().rpc("store_company_contacts", { p_account_id: accountId })
  if (error) throw new Error(`Could not read the company's people — please try again (${error.message}).`)
  const ids = Array.from(new Set(((links ?? []) as { contact_id: string }[]).map((l) => l.contact_id)))
  if (ids.length === 0) return []
  const { data: cs, error: cErr } = await db().from("contacts").select("id, full_name").in("id", ids)
  if (cErr) throw new Error(`Could not read the company's people — please try again (${cErr.message}).`)
  return ((cs ?? []) as { id: string; full_name: string | null }[]).map((c) => ({ contactId: c.id, name: c.full_name || "Person" })).sort((a, b) => a.name.localeCompare(b.name))
}

/** The companies this person is in today (link not ended) that have a new storage (a company document can go there). */
async function personCompanies(contactId: string): Promise<Array<{ ownerId: string; name: string; accountId: string }>> {
  const { data: links, error } = await db().from("account_contacts").select("account_id, accounts(company_name)").eq("contact_id", contactId).is("ended_at", null)
  if (error) throw new Error(`Could not read the person's companies — please try again (${error.message}).`)
  const rows = (links ?? []) as { account_id: string; accounts: { company_name: string | null } | null }[]
  if (rows.length === 0) return []
  const { data: owners, error: oErr } = await db().from("store_owners").select("id, account_id").eq("kind", "company").in("account_id", rows.map((r) => r.account_id))
  if (oErr) throw new Error(`Could not read the companies' storage — please try again (${oErr.message}).`)
  const byAccount = new Map(((owners ?? []) as { id: string; account_id: string }[]).map((o) => [o.account_id, o.id]))
  return rows.filter((r) => byAccount.has(r.account_id))
    .map((r) => ({ ownerId: byAccount.get(r.account_id)!, name: r.accounts?.company_name || "Company", accountId: r.account_id }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

interface LedgerEntry { id: string; drive_file_id: string; drive_link: string | null; created?: boolean; before?: Record<string, unknown> }
interface WaitingRow { itemId: string; runId: string; row: { id: string; drive_file_id: string; drive_link: string | null; portal_visible: boolean | null; tax_year: number | null } }
const RECORD_FIELDS = "id, drive_file_id, drive_link, portal_visible, account_id, contact_id, category, category_name, document_type_id, document_type_name, tax_year"
const beforeOf = (r: Record<string, unknown>) => ({ account_id: r.account_id ?? null, contact_id: r.contact_id ?? null, category: r.category ?? null, category_name: r.category_name ?? null, document_type_id: r.document_type_id ?? null, document_type_name: r.document_type_name ?? null })

async function freeNameIn(folderId: string, name: string): Promise<string> {
  const { data, error } = await db().from("store_files").select("name").eq("folder_id", folderId).eq("state", "live")
  if (error) throw new Error(`Could not read the folder (${error.message}).`)
  const names = ((data ?? []) as { name: string }[]).map((f) => f.name)
  const { storeNameKey } = await import("./rules")
  if (!names.some((n) => storeNameKey(n) === storeNameKey(name))) return name
  const { keepBothName } = await import("./names")
  return keepBothName(name, names)
}

async function pathOf(folderId: string): Promise<string> {
  const parts: string[] = []
  let id: string | null = folderId
  for (let i = 0; id && i < 25; i++) {
    const { data } = await db().from("store_folders").select("name, parent_id").eq("id", id).maybeSingle()
    if (!data || !data.parent_id) break
    parts.unshift(data.name as string)
    id = data.parent_id as string | null
  }
  return parts.join(" › ")
}

async function logEvent(f: { id: string; owner_id: string; folder_id: string; name: string }, actor: string | null, details: Record<string, unknown>) {
  const { error } = await db().from("store_events").insert({ event: "type_changed", actor, owner_id: f.owner_id, file_id: f.id, folder_id: f.folder_id, name_snapshot: f.name, details })
  if (error) console.error(`[crm-store] type_changed not logged for ${f.id}: ${error.message}`)
}

/** The Drive moves that stored this file: refused while one is running or being undone; the items, and the first
 *  record per item the move left on Drive (the move's own company's records only — the same filter the move uses). */
async function moveContext(fileId: string): Promise<{ items: Array<{ id: string; repointed: LedgerEntry[] }>; waiting: WaitingRow[]; runIds: string[] }> {
  const { data, error } = await db().from("store_import_items").select("id, run_id, source, source_id, repointed, store_import_runs!inner(status, account_id)").eq("store_file_id", fileId)
  if (error) throw new Error(`Could not read the move's ledger — please try again (${error.message}).`)
  const list = (data ?? []) as { id: string; run_id: string; source: string; source_id: string; repointed: LedgerEntry[] | null; store_import_runs: { status: string; account_id: string } }[]
  if (list.some((i) => i.store_import_runs.status === "undoing")) throw new Error("This company's move is being undone — try again when it has finished.")
  if (list.some((i) => ["scanning", "moving"].includes(i.store_import_runs.status))) throw new Error("This company's move is still running — try again when it has finished.")
  const live = list.filter((i) => ["done", "incomplete"].includes(i.store_import_runs.status))
  const waiting: WaitingRow[] = []
  for (const it of live.filter((i) => i.source === "drive")) {
    const accountId = it.store_import_runs.account_id
    const { data: links, error: lErr } = await db().from("account_contacts").select("contact_id").eq("account_id", accountId)
    if (lErr) throw new Error(`Could not read the company's people — please try again (${lErr.message}).`)
    const memberIds = ((links ?? []) as { contact_id: string }[]).map((l) => l.contact_id)
    const { data: rows, error: rErr } = await db().from("documents").select("id, drive_file_id, drive_link, portal_visible, account_id, contact_id, tax_year").eq("drive_file_id", it.source_id)
    if (rErr) throw new Error(`Could not read the CRM record — please try again (${rErr.message}).`)
    const mine = ((rows ?? []) as Array<WaitingRow["row"] & { account_id: string | null; contact_id: string | null }>)
      .filter((r) => r.account_id === accountId || (!r.account_id && r.contact_id && memberIds.includes(r.contact_id)))
    if (mine[0]) waiting.push({ itemId: it.id, runId: it.run_id, row: mine[0] })
  }
  return { items: live.map((i) => ({ id: i.id, repointed: i.repointed ?? [] })), waiting, runIds: Array.from(new Set(live.map((i) => i.run_id))) }
}

const YEAR_KINDS = new Set(["tax_year", "person_tax_year"])

/** A folder of this kind in this storage — a year folder only for THAT year; null when there is none (a read error
 *  stops, never a silent fallback). */
async function folderOf(ownerId: string, kind: string, year: number | null): Promise<string | null> {
  if (YEAR_KINDS.has(kind) && !year) return null
  const { data, error } = await db().from("store_folders").select("id, name, parent_id").eq("owner_id", ownerId).eq("kind", kind).is("trashed_at", null)
  if (error) throw new Error(`Could not read the folders — please try again (${error.message}).`)
  const rows = ((data ?? []) as { id: string; name: string; parent_id: string | null }[]).filter((r) => r.parent_id !== null)
  const hit = YEAR_KINDS.has(kind) ? rows.find((r) => r.name.trim() === String(year)) : rows[0]
  return hit?.id ?? null
}
async function firstFolder(ownerId: string, kinds: Array<string | null>, year: number | null): Promise<{ id: string; kind: string }> {
  for (const k of kinds.filter((x): x is string => !!x)) {
    const id = await folderOf(ownerId, k, year)
    if (id) return { id, kind: k }
  }
  throw new Error("The storage has no folder for this type.")
}

export async function setStoreFileType(p: SetTypeInput): Promise<SetTypeResult> {
  const f = await readFile(p.fileId)
  const { data: t, error: tErr } = await db().from("catalog_entries").select("id, slug, display_name, status, metadata")
    .eq("catalog_id", "storage_document_types").eq("slug", p.typeSlug).maybeSingle()
  if (tErr) throw new Error(`Could not read the document types — please try again (${tErr.message}).`)
  const type = t as TypeRow | null
  if (!type || type.status !== "active") throw new Error("That document type is not available.")
  const m = type.metadata ?? {}
  const personal = m.personal === true, staffOnly = m.staff_only === true, draftNeverVisible = m.draft_never_visible === true
  const legacyId = typeof m.legacy_document_type_id === "number" ? m.legacy_document_type_id : null
  const ownerKind = f.store_owners.kind
  const notes: string[] = []

  if (f.filing_status === "filed" && f.document_type !== type.slug) throw new Error("This return is filed and frozen — its type cannot change. Save an amended file instead.")
  if (personal && (ownerKind === "business" || ownerKind === "private" || ownerKind === "formation")) {
    throw new Error("A personal document (passport, ID …) belongs in a person's own storage — move it from a company's \"2. Contacts\".")
  }

  // the file's own CRM record, and the record a Drive move left on Drive that will come over (ONLY when the file
  // has no record of its own, or just the hidden one the move listed) — what the client sees is decided by those
  const ctx = await moveContext(f.id)
  const pointer = storePointerOf(f.id)
  const { data: ownRows, error: oErr } = await db().from("documents").select(RECORD_FIELDS).eq("drive_file_id", pointer)
  if (oErr) throw new Error(`Could not read the CRM listing — please try again (${oErr.message}).`)
  const own = ((ownRows ?? []) as Record<string, unknown>[])[0] ?? null
  const placeholderHolder = own ? ctx.items.find((i) => i.repointed.some((r) => r.id === own.id && r.created)) ?? null : null
  let bring: WaitingRow | null = (!own || placeholderHolder) ? ctx.waiting[0] ?? null : null
  const clientSees = f.published || bring?.row.portal_visible === true

  // the answers the type needs — asked BEFORE anything changes
  const people = personal && ownerKind === "company" && f.store_owners.account_id ? await companyMembers(f.store_owners.account_id) : []
  const companies = !personal && ownerKind === "person" && f.store_owners.contact_id ? await personCompanies(f.store_owners.contact_id) : []
  const companyAnswer = p.companyOwnerId ?? autoCompanyAnswer(companies, p.viewingOwnerId, clientSees)
  let personName = "the person"
  if (ownerKind === "person" && f.store_owners.contact_id) {
    const { data: c } = await db().from("contacts").select("full_name").eq("id", f.store_owners.contact_id).maybeSingle()
    personName = (c?.full_name as string | undefined) || personName
  }
  const q = questionFor({
    ownerKind, personal, draftNeverVisible, published: clientSees, filingStatus: f.filing_status, typeName: type.display_name,
    hasPerson: !!p.personContactId, hasCompanyAnswer: !!companyAnswer, hasFiledAnswer: !!p.filedAnswer, people, companies, personName,
  })
  if (q) throw new SetTypeQuestionError(q)
  if (personal && ownerKind === "company" && !people.some((x) => x.contactId === p.personContactId)) throw new Error("That person is not in this company's \"2. Contacts\".")
  if (companyAnswer && companyAnswer !== "keep" && !companies.some((c) => c.ownerId === companyAnswer)) throw new Error("That company is not one of this person's companies.")
  const hideIt = staffOnly || (draftNeverVisible && f.filing_status !== "filed" && p.filedAnswer === "hide")
  const wantVisible = clientSees && !hideIt
  // checked BEFORE anything changes: a file its workspace always shows can't be hidden; a file marked "Needs review"
  // can't be shown — its Drive record then stays where it is (the client keeps it)
  if (hideIt && f.published) {
    const { workspaceShownFiles, workspaceShownMessage } = await import("./client-visibility")
    const ws = (await workspaceShownFiles([f.id])).get(f.id)
    if (ws) throw new Error(workspaceShownMessage(f.name, ws))
  }
  if (bring && wantVisible && !f.published && f.needs_review_at) {
    bring = null
    notes.push("Its CRM record still opens from Drive — the file is marked \"Needs review\": settle it (Mark reviewed), then Save again.")
  }

  // where the file goes: the SAME file is re-homed (record, versions, ledger, backup stay attached); a return goes
  // into ITS year folder (the file's or its record's year), never a year folder picked at random
  const year = f.period_year ?? (typeof own?.tax_year === "number" ? own.tax_year : null) ?? bring?.row.tax_year ?? null
  const kind = typeof m.default_folder_kind === "string" ? m.default_folder_kind : null
  let target: { folderId: string; folderKind: string; accountId: string | null; contactId: string | null } | null = null
  if (personal && ownerKind === "company") {
    const { ensurePersonOwner } = await import("./formation-pilot")
    const who = people.find((x) => x.contactId === p.personContactId)!
    const ownerId = await ensurePersonOwner(who.contactId, who.name)
    const pk = kind && ["personal", "itin", "person_tax", "person_tax_year"].includes(kind) ? kind : null
    const fo = await firstFolder(ownerId, [pk, pk === "person_tax_year" ? "person_tax" : null, "personal"], year)
    target = { folderId: fo.id, folderKind: fo.kind, accountId: f.store_owners.account_id, contactId: who.contactId }
  } else if (!personal && ownerKind === "person" && companyAnswer && companyAnswer !== "keep") {
    const ck = kind && kind !== "personal" ? kind : null
    const fo = await firstFolder(companyAnswer, [ck, ck && YEAR_KINDS.has(ck) ? "tax" : null, "correspondence"], year)
    target = { folderId: fo.id, folderKind: fo.kind, accountId: companies.find((c) => c.ownerId === companyAnswer)!.accountId, contactId: null }
  }

  let movedTo: string | null = null
  let folderId = f.folder_id
  let renamedTo: string | null = null
  if (target) {
    const name = await freeNameIn(target.folderId, f.name)
    const { renameStoreFile } = await import("./file-actions")
    if (name !== f.name) { await renameStoreFile(f.id, name, p.actorId); renamedTo = name }
    const { error: rhErr } = await db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: target.folderId, p_actor: p.actorId, p_reason: `Set type: ${type.display_name}` })
    if (rhErr) {
      if (renamedTo) await renameStoreFile(f.id, f.name, p.actorId).catch(() => undefined)
      throw new Error(`The file could not be moved (${rhErr.message.replace(/^store: /, "")}).`)
    }
    if (renamedTo) notes.push(`Renamed "${renamedTo}" — the folder already had a file called "${f.name}".`)
    folderId = target.folderId
    movedTo = await pathOf(target.folderId)
  }
  // a later step failing puts the file back where it was (never half-done)
  const moveBack = async () => {
    if (!target) return
    await db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: f.folder_id, p_actor: p.actorId, p_reason: "Set type failed — put back" })
    if (renamedTo) {
      const { renameStoreFile } = await import("./file-actions")
      await renameStoreFile(f.id, f.name, p.actorId).catch(() => undefined)
    }
  }

  const { setClientVisibility } = await import("./browse")
  let visible = f.published
  let fr: FollowResult
  try {
    if (visible && hideIt) {
      await setClientVisibility(f.id, false, p.actorId)
      visible = false
    }
    // the type, then its filing state in ONE forward step (none → draft, or straight to filed); a failed step puts
    // the type back, so a return is never saved without its draft/filed state and never frozen under the old type
    const patch: Record<string, unknown> = { document_type: type.slug }
    if (draftNeverVisible && !f.period_year) {
      if (year) patch.period_year = year
      else if (!target) {
        const { nearestYear } = await import("./structure")
        const y = await nearestYear(folderId) // the folder staff put it in, not one this call picked
        if (y) patch.period_year = y
      }
    }
    const { error: uErr } = await db().from("store_files").update(patch).eq("id", f.id).eq("state", "live")
    if (uErr) throw new Error(`The type could not be saved (${uErr.message}).`)
    const toStatus = draftNeverVisible && f.filing_status !== "filed" ? (p.filedAnswer === "filed" ? "filed" : (f.filing_status === "draft" ? null : "draft")) : null
    if (toStatus) {
      const { error: sErr } = await db().rpc("store_set_filing_status", { p_file_id: f.id, p_status: toStatus, p_actor: p.actorId })
      if (sErr) {
        await db().from("store_files").update({ document_type: f.document_type, period_year: f.period_year }).eq("id", f.id)
        throw new Error(`The return could not be marked ${toStatus} (${sErr.message.replace(/^store: /, "")}) — the type was not changed.`)
      }
    }
    // the CRM record follows; a record left on Drive comes over (ledger first, with what it said before — Undo restores it)
    const owner = { contactId: target ? target.contactId : ownerKind === "person" ? f.store_owners.contact_id : null, accountId: target && !target.contactId ? target.accountId : null }
    fr = await followRecords(f, folderId, type, legacyId, personal, owner, bring, own, placeholderHolder, ctx.items, notes)
  } catch (e) {
    await moveBack().catch(() => undefined)
    if (f.published && !visible) await setClientVisibility(f.id, true, p.actorId).catch(() => undefined) // as it was
    throw e
  }
  if (clientSees && hideIt) notes.push(staffOnly ? "Hidden from the client — this type is staff-only." : "Hidden from the client until the return is filed.")

  // the client keeps seeing what they saw — or it is hidden because the type says so; the store and the CRM record
  // never disagree
  if (wantVisible && !visible) {
    try {
      await setClientVisibility(f.id, true, p.actorId)
      visible = true
    } catch (e) {
      if (fr.brought) {
        await putBackOnDrive(fr.brought)
        fr.settled.clear()
        notes.push(`Its CRM record still opens from Drive — the new storage cannot show it yet: ${e instanceof Error ? e.message : "it could not be shown"}`)
      } else {
        notes.push(`Still hidden from the client: ${e instanceof Error ? e.message : "it could not be shown"}`)
      }
    }
  }
  if (fr.brought && fr.settled.size) {
    const { error: vErr } = await db().from("documents").update({ portal_visible: visible, updated_at: new Date().toISOString() }).eq("drive_file_id", pointer)
    if (vErr) { await putBackOnDrive(fr.brought); throw new Error(`The CRM record could not be lined up with the file (${vErr.message}) — it still opens from Drive.`) }
  }
  // an Undo that started meanwhile wins: the record goes back on Drive
  if (fr.brought && fr.settled.size && ctx.runIds.length) {
    const { data: runs } = await db().from("store_import_runs").select("status").in("id", ctx.runIds)
    if (((runs ?? []) as { status: string }[]).some((r) => r.status === "undoing" || r.status === "rolled_back")) {
      await putBackOnDrive(fr.brought)
      throw new Error("The move was undone meanwhile — the CRM record stays on Drive.")
    }
  }
  await settleMoveLedger(fr.settled, type.display_name, p.skipReportRefresh ? [] : ctx.runIds, notes)
  await logEvent({ ...f, folder_id: folderId }, p.actorId, { from: f.document_type, to: type.slug, moved_to: movedTo })
  return { typeName: type.display_name, movedTo, visible, notes, recordsFollowed: fr.count }
}

function storePointerOf(fileId: string): string {
  return `store:${fileId}`
}

interface Brought { itemId: string; entry: LedgerEntry; placeholder: { holderId: string; row: Record<string, unknown>; entry: LedgerEntry } | null }
interface FollowResult { count: number; brought: Brought | null; settled: Set<string> }

/** The record this call brought over from Drive goes back exactly as it was (pointer AND what it said), out of the
 *  ledger; the hidden record the move had listed (removed to make room) comes back too. Errors stop loudly. */
async function putBackOnDrive(b: Brought): Promise<void> {
  const { error } = await db().from("documents").update({ ...(b.entry.before ?? {}), drive_file_id: b.entry.drive_file_id, drive_link: b.entry.drive_link, updated_at: new Date().toISOString() }).eq("id", b.entry.id)
  if (error) throw new Error(`The CRM record could not be put back on Drive (${error.message}) — tell an owner before the move is undone.`)
  const { data: it, error: rErr } = await db().from("store_import_items").select("repointed").eq("id", b.itemId).maybeSingle()
  if (rErr) throw new Error(`Could not read the move's ledger (${rErr.message}).`)
  const rest = ((it?.repointed ?? []) as LedgerEntry[]).filter((r) => !(r.id === b.entry.id && !r.created))
  const { error: lErr } = await db().from("store_import_items").update({ repointed: rest, updated_at: new Date().toISOString() }).eq("id", b.itemId)
  if (lErr) throw new Error(`Could not update the move's ledger (${lErr.message}).`)
  if (b.placeholder) {
    const { error: iErr } = await db().from("documents").insert(b.placeholder.row)
    if (iErr) throw new Error(`The listed CRM record could not be put back (${iErr.message}).`)
    const { data: h } = await db().from("store_import_items").select("repointed").eq("id", b.placeholder.holderId).maybeSingle()
    const back = [...((h?.repointed ?? []) as LedgerEntry[]), b.placeholder.entry]
    const { error: hErr } = await db().from("store_import_items").update({ repointed: back, updated_at: new Date().toISOString() }).eq("id", b.placeholder.holderId)
    if (hErr) throw new Error(`Could not update the move's ledger (${hErr.message}).`)
  }
}

/** The move's report stops listing this file as still opening from Drive — only for the items whose record now
 *  opens from the new storage — and the reports of the moves concerned are rebuilt. */
async function settleMoveLedger(itemIds: Set<string>, typeName: string, runIds: string[], notes: string[]): Promise<void> {
  try {
    const { WAITING_RE, WAITING_SENTENCE_RE, refreshRunReport } = await import("./drive-import")
    if (itemIds.size) {
      const { data, error } = await db().from("store_import_items").select("id, reason").in("id", Array.from(itemIds))
      if (error) throw new Error(error.message)
      for (const it of (data ?? []) as { id: string; reason: string | null }[]) {
        if (!WAITING_RE.test(it.reason ?? "")) continue
        const reason = (it.reason ?? "").replace(WAITING_SENTENCE_RE, "").trim()
        const { error: uErr } = await db().from("store_import_items").update({ reason: `${reason ? `${reason} ` : ""}Type set later: ${typeName}.`, updated_at: new Date().toISOString() }).eq("id", it.id)
        if (uErr) throw new Error(uErr.message)
      }
    }
    for (const r of runIds) await refreshRunReport(r)
  } catch (e) {
    console.error(`[crm-store] move report not refreshed after Set type: ${e instanceof Error ? e.message : e}`)
    notes.push("The type is saved; the move's report could not be refreshed — press Re-check types there.")
  }
}

/** The file's CRM record takes the type, the category and the person (a record in a person's storage is always that
 *  person's). The record a Drive move left on Drive comes over. Every record a move touched keeps what it said
 *  before in the move's ledger (the first change wins), so Undo restores it. */
async function followRecords(
  f: FileRow, folderId: string, type: TypeRow, legacyId: number | null, personal: boolean,
  owner: { contactId: string | null; accountId: string | null }, bring: WaitingRow | null, own: Record<string, unknown> | null,
  placeholderHolder: { id: string; repointed: LedgerEntry[] } | null, items: Array<{ id: string; repointed: LedgerEntry[] }>, notes: string[],
): Promise<FollowResult> {
  const out: FollowResult = { count: 0, brought: null, settled: new Set<string>() }
  if (f.store_owners.kind === "business" || f.store_owners.kind === "private") return out
  const { storeDocumentLink } = await import("./document-pointer")
  const { categoryForFolder } = await import("./structure")
  const { categoryForKind } = await import("./browse")
  const pointer = storePointerOf(f.id)
  const cat = personal ? categoryForKind("personal") : await categoryForFolder(folderId)
  let record = own

  if (bring) {
    let placeholder: Brought["placeholder"] = null
    if (own && placeholderHolder) {
      // the hidden record the move listed gives way to the real one (kept in memory: a put-back re-lists it)
      const { data: snap, error: sErr } = await db().from("documents").select("*").eq("id", own.id as string).maybeSingle()
      if (sErr || !snap) throw new Error(`Could not read the listed CRM record (${sErr?.message ?? "missing"}).`)
      const entry = placeholderHolder.repointed.find((r) => r.id === own.id && r.created)!
      const { error: dErr } = await db().from("documents").delete().eq("id", own.id as string).eq("drive_file_id", pointer)
      if (dErr) throw new Error(`The CRM listing could not be updated (${dErr.message}).`)
      const rest = placeholderHolder.repointed.filter((r) => !(r.id === own.id && r.created))
      const { error: hErr } = await db().from("store_import_items").update({ repointed: rest, updated_at: new Date().toISOString() }).eq("id", placeholderHolder.id)
      if (hErr) throw new Error(`Could not update the move's ledger (${hErr.message}).`)
      placeholder = { holderId: placeholderHolder.id, row: snap as Record<string, unknown>, entry }
    }
    const { data: full, error: fErr } = await db().from("documents").select(RECORD_FIELDS).eq("id", bring.row.id).maybeSingle()
    if (fErr || !full) throw new Error(`Could not read the CRM record (${fErr?.message ?? "missing"}).`)
    const entry: LedgerEntry = { id: bring.row.id, drive_file_id: bring.row.drive_file_id, drive_link: bring.row.drive_link, before: beforeOf(full) }
    const { data: cur, error: cErr } = await db().from("store_import_items").select("repointed").eq("id", bring.itemId).maybeSingle()
    if (cErr) throw new Error(`Could not read the move's ledger (${cErr.message}).`)
    const ledger = [...((cur?.repointed ?? []) as LedgerEntry[]).filter((r) => r.id !== entry.id || r.created), entry]
    const { error: lErr } = await db().from("store_import_items").update({ repointed: ledger, updated_at: new Date().toISOString() }).eq("id", bring.itemId)
    if (lErr) throw new Error(`Could not update the move's ledger (${lErr.message}).`)
    const { data: moved, error: rErr } = await db().from("documents").update({ drive_file_id: pointer, drive_link: storeDocumentLink(bring.row.id), updated_at: new Date().toISOString() })
      .eq("id", bring.row.id).eq("drive_file_id", bring.row.drive_file_id).select("id")
    if (rErr) throw new Error(`The CRM record could not be moved to the new storage (${rErr.message}).`)
    out.brought = { itemId: bring.itemId, entry, placeholder }
    if ((moved ?? []).length) {
      out.settled.add(bring.itemId)
      record = full
      notes.push("Its CRM record now opens from the new storage.")
    } else {
      await putBackOnDrive(out.brought) // changed meanwhile — everything back as it was
      out.brought = null
    }
  }
  // items whose record already opened from the store are settled too
  if (record) for (const i of items) if (i.repointed.some((r) => r.id === record!.id)) out.settled.add(i.id)

  // the record a move touched remembers what it said before (the first change wins) — Undo puts it back
  if (record && !out.brought) {
    for (const i of items) {
      const idx = i.repointed.findIndex((r) => r.id === record!.id && !r.created)
      if (idx < 0 || i.repointed[idx].before) continue
      const next = i.repointed.slice()
      next[idx] = { ...i.repointed[idx], before: beforeOf(record) }
      const { error: bErr } = await db().from("store_import_items").update({ repointed: next, updated_at: new Date().toISOString() }).eq("id", i.id)
      if (bErr) throw new Error(`Could not update the move's ledger (${bErr.message}) — the type was not changed on the record.`)
    }
  }

  const patch: Record<string, unknown> = {
    document_type_id: legacyId, document_type_name: type.display_name, category: cat.num, category_name: cat.name, updated_at: new Date().toISOString(),
  }
  if (owner.contactId) patch.contact_id = owner.contactId
  if (owner.accountId) { patch.account_id = owner.accountId; patch.contact_id = null }
  const { data: done, error } = await db().from("documents").update(patch).eq("drive_file_id", pointer).select("id")
  if (error) {
    if (out.brought) await putBackOnDrive(out.brought).catch(() => undefined)
    throw new Error(`The CRM record could not follow (${error.message}) — press Save again.`)
  }
  out.count = (done ?? []).length
  return out
}
