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
  | { kind: "company"; typeName: string; personName: string; companies: Array<{ ownerId: string; name: string }> }
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
  /** the storage the staff member is looking at (a company page) — used as the answer when it is one of the choices */
  viewingOwnerId?: string | null
}

export interface SetTypeResult { typeName: string; movedTo: string | null; visible: boolean; notes: string[]; recordsFollowed: number }

interface FileRow {
  id: string; name: string; owner_id: string; folder_id: string; document_type: string | null; state: string; published: boolean
  filing_status: string | null; period_year: number | null
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
    return { kind: "company", typeName: p.typeName, personName: p.personName, companies: p.companies }
  }
  if (p.draftNeverVisible && p.published && p.filingStatus !== "filed" && !p.hasFiledAnswer) return { kind: "filed", typeName: p.typeName }
  return null
}

async function readFile(fileId: string): Promise<FileRow> {
  const { data, error } = await db().from("store_files")
    .select("id, name, owner_id, folder_id, document_type, state, published, filing_status, period_year, store_owners!inner(kind, account_id, contact_id)")
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
interface WaitingRow { itemId: string; runId: string; repointed: LedgerEntry[]; row: { id: string; drive_file_id: string; drive_link: string | null; portal_visible: boolean | null } }
const RECORD_FIELDS = "id, drive_file_id, drive_link, portal_visible, account_id, contact_id, category, category_name, document_type_id, document_type_name"
const beforeOf = (r: Record<string, unknown>) => ({ account_id: r.account_id ?? null, contact_id: r.contact_id ?? null, category: r.category ?? null, category_name: r.category_name ?? null, document_type_id: r.document_type_id ?? null, document_type_name: r.document_type_name ?? null })

/** The Drive moves that stored this file: refuses while one is being undone; returns the records they left on Drive
 *  (the move's own company's records only — the same filter the move uses). */
async function moveContext(fileId: string): Promise<{ waiting: WaitingRow[]; runIds: string[] }> {
  const { data: items, error } = await db().from("store_import_items").select("id, run_id, source, source_id, repointed, store_import_runs!inner(status, account_id)").eq("store_file_id", fileId)
  if (error) throw new Error(`Could not read the move's ledger — please try again (${error.message}).`)
  const list = (items ?? []) as { id: string; run_id: string; source: string; source_id: string; repointed: LedgerEntry[] | null; store_import_runs: { status: string; account_id: string } }[]
  if (list.some((i) => i.store_import_runs.status === "undoing")) throw new Error("This company's move is being undone — try again when it has finished.")
  const live = list.filter((i) => ["done", "incomplete", "moving"].includes(i.store_import_runs.status))
  const waiting: WaitingRow[] = []
  for (const it of live.filter((i) => i.source === "drive")) {
    const accountId = it.store_import_runs.account_id
    const { data: links, error: lErr } = await db().from("account_contacts").select("contact_id").eq("account_id", accountId)
    if (lErr) throw new Error(`Could not read the company's people — please try again (${lErr.message}).`)
    const memberIds = ((links ?? []) as { contact_id: string }[]).map((l) => l.contact_id)
    const { data: rows, error: rErr } = await db().from("documents").select("id, drive_file_id, drive_link, portal_visible, account_id, contact_id").eq("drive_file_id", it.source_id)
    if (rErr) throw new Error(`Could not read the CRM record — please try again (${rErr.message}).`)
    const mine = ((rows ?? []) as { id: string; drive_file_id: string; drive_link: string | null; portal_visible: boolean | null; account_id: string | null; contact_id: string | null }[])
      .filter((r) => r.account_id === accountId || (!r.account_id && r.contact_id && memberIds.includes(r.contact_id)))
    if (mine[0]) waiting.push({ itemId: it.id, runId: it.run_id, repointed: it.repointed ?? [], row: mine[0] })
  }
  return { waiting, runIds: Array.from(new Set(live.map((i) => i.run_id))) }
}

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
  // what the client sees today: the stored file, or a record the Drive move left on Drive
  const { waiting, runIds } = await moveContext(f.id)
  const clientSees = f.published || waiting.some((w) => w.row.portal_visible === true)

  // the answers the type needs — asked BEFORE anything changes
  const people = personal && ownerKind === "company" && f.store_owners.account_id ? await companyMembers(f.store_owners.account_id) : []
  const companies = !personal && ownerKind === "person" && f.store_owners.contact_id ? await personCompanies(f.store_owners.contact_id) : []
  let companyAnswer = p.companyOwnerId ?? null
  // opened from a company page and the person is in that company only → that is the answer; otherwise ask
  if (!companyAnswer && p.viewingOwnerId && companies.length === 1 && companies[0].ownerId === p.viewingOwnerId) companyAnswer = p.viewingOwnerId
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
  // a file its workspace always shows can't be hidden — refused NOW, before anything moves
  if (hideIt && f.published) {
    const { workspaceShownFiles, workspaceShownMessage } = await import("./client-visibility")
    const ws = (await workspaceShownFiles([f.id])).get(f.id)
    if (ws) throw new Error(workspaceShownMessage(f.name, ws))
  }

  // where the file goes (the SAME file is re-homed — its record, versions, ledger and backup stay attached)
  const { folderOfKind } = await import("./formation-pilot")
  const firstFolder = async (ownerId: string, kinds: Array<string | null>) => {
    for (const k of kinds.filter((x): x is string => !!x)) { try { return await folderOfKind(ownerId, k) } catch { /* next */ } }
    throw new Error("The storage has no folder for this type.")
  }
  const kind = typeof m.default_folder_kind === "string" ? m.default_folder_kind : null
  let target: { folderId: string; accountId: string | null; contactId: string | null } | null = null
  if (personal && ownerKind === "company") {
    const { ensurePersonOwner } = await import("./formation-pilot")
    const who = people.find((x) => x.contactId === p.personContactId)!
    const ownerId = await ensurePersonOwner(who.contactId, who.name)
    // the type's own personal folder (ITIN, the person's tax years …), else "Personal documents"
    const pk = kind && ["personal", "itin", "person_tax", "person_tax_year"].includes(kind) ? kind : null
    target = { folderId: await firstFolder(ownerId, [pk, pk === "person_tax_year" ? "person_tax" : null, "personal"]), accountId: f.store_owners.account_id, contactId: who.contactId }
  } else if (!personal && ownerKind === "person" && companyAnswer && companyAnswer !== "keep") {
    const ck = kind && kind !== "personal" ? kind : null
    const folderId = await firstFolder(companyAnswer, [ck, ck === "tax_year" || ck === "person_tax_year" ? "tax" : null, "correspondence"])
    target = { folderId, accountId: companies.find((c) => c.ownerId === companyAnswer)!.accountId, contactId: null }
  }
  let movedTo: string | null = null
  let folderId = f.folder_id
  if (target) {
    const name = await freeNameIn(target.folderId, f.name)
    const { renameStoreFile } = await import("./file-actions")
    if (name !== f.name) await renameStoreFile(f.id, name, p.actorId)
    const { error: rhErr } = await db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: target.folderId, p_actor: p.actorId, p_reason: `Set type: ${type.display_name}` })
    if (rhErr) {
      if (name !== f.name) await renameStoreFile(f.id, f.name, p.actorId).catch(() => undefined) // never half-done
      throw new Error(`The file could not be moved (${rhErr.message.replace(/^store: /, "")}).`)
    }
    if (name !== f.name) notes.push(`Renamed "${name}" — the folder already had a file called "${f.name}".`)
    folderId = target.folderId
    movedTo = await pathOf(target.folderId)
  }

  // hidden when the type says so (a file its workspace always shows is refused here, before its type changes)
  const { setClientVisibility } = await import("./browse")
  let visible = f.published
  if (visible && hideIt) {
    await setClientVisibility(f.id, false, p.actorId)
    visible = false
  }
  if (clientSees && hideIt) notes.push(staffOnly ? "Hidden from the client — this type is staff-only." : "Hidden from the client until the return is filed.")

  // a return's draft / filed state FIRST (a return type is never saved without its draft state), then the type
  if (draftNeverVisible && (f.filing_status === "none" || !f.filing_status)) {
    const { error: dErr } = await db().rpc("store_set_filing_status", { p_file_id: f.id, p_status: "draft", p_actor: p.actorId })
    if (dErr) throw new Error(`The return could not be marked as a draft (${dErr.message.replace(/^store: /, "")}) — the type was not changed.`)
  }
  if (draftNeverVisible && f.filing_status !== "filed" && p.filedAnswer === "filed") {
    const { error: fErr } = await db().rpc("store_set_filing_status", { p_file_id: f.id, p_status: "filed", p_actor: p.actorId })
    if (fErr) throw new Error(`The return could not be marked filed (${fErr.message.replace(/^store: /, "")}) — the type was not changed.`)
  }
  const patch: Record<string, unknown> = { document_type: type.slug }
  if (draftNeverVisible && !f.period_year) {
    const { nearestYear } = await import("./structure")
    const y = await nearestYear(folderId)
    if (y) patch.period_year = y
  }
  const { error: uErr } = await db().from("store_files").update(patch).eq("id", f.id).eq("state", "live")
  if (uErr) throw new Error(`The type could not be saved (${uErr.message}).`)

  // the CRM record follows; a record left on Drive comes over (ledger first, with what it said before — Undo restores it)
  const owner = { contactId: target ? target.contactId : ownerKind === "person" ? f.store_owners.contact_id : null, accountId: target && !target.contactId ? target.accountId : null }
  const fr = await followRecords(f, folderId, type, legacyId, personal, owner, waiting, notes)
  // the client keeps seeing what they saw — or it is hidden because the type says so; never the store and the
  // CRM record disagreeing
  if (wantVisible && !visible) {
    try {
      await setClientVisibility(f.id, true, p.actorId)
      visible = true
    } catch (e) {
      if (fr.repointed.length) {
        await putBackOnDrive(fr.repointed)
        notes.push(`Its CRM record still opens from Drive — the new storage cannot show it yet: ${e instanceof Error ? e.message : "it could not be shown"}`)
        fr.settled.clear()
      } else {
        notes.push(`Still hidden from the client: ${e instanceof Error ? e.message : "it could not be shown"}`)
      }
    }
  } else if (!wantVisible && fr.repointed.length) {
    const { error: hErr } = await db().from("documents").update({ portal_visible: false, updated_at: new Date().toISOString() }).eq("drive_file_id", storePointerOf(f.id))
    if (hErr) { await putBackOnDrive(fr.repointed); throw new Error(`The CRM record could not be hidden (${hErr.message}) — it still opens from Drive.`) }
  }
  // an Undo that started meanwhile wins: the records go back on Drive
  if (fr.repointed.length && runIds.length) {
    const { data: runs } = await db().from("store_import_runs").select("status").in("id", runIds)
    if (((runs ?? []) as { status: string }[]).some((r) => r.status === "undoing" || r.status === "rolled_back")) {
      await putBackOnDrive(fr.repointed)
      throw new Error("The move was undone meanwhile — the CRM record stays on Drive.")
    }
  }
  await settleMoveLedger(fr.settled, type.display_name, runIds, notes)
  await logEvent({ ...f, folder_id: folderId }, p.actorId, { from: f.document_type, to: type.slug, moved_to: movedTo })
  return { typeName: type.display_name, movedTo, visible, notes, recordsFollowed: fr.count }
}

function storePointerOf(fileId: string): string {
  return `store:${fileId}`
}

/** Records this call brought over from Drive go back to their Drive file (and out of the ledger). */
async function putBackOnDrive(moved: Array<{ itemId: string; entry: LedgerEntry }>): Promise<void> {
  for (const mv of moved) {
    await db().from("documents").update({ drive_file_id: mv.entry.drive_file_id, drive_link: mv.entry.drive_link, updated_at: new Date().toISOString() }).eq("id", mv.entry.id).like("drive_file_id", "store:%")
    const { data: it } = await db().from("store_import_items").select("repointed").eq("id", mv.itemId).maybeSingle()
    const rest = ((it?.repointed ?? []) as LedgerEntry[]).filter((r) => !(r.id === mv.entry.id && !r.created))
    await db().from("store_import_items").update({ repointed: rest, updated_at: new Date().toISOString() }).eq("id", mv.itemId)
  }
}

/** The move's report stops listing this file under "Waiting for a type" — only for the items whose record now opens
 *  from the new storage — and the reports of the moves concerned are rebuilt. */
async function settleMoveLedger(itemIds: Set<string>, typeName: string, runIds: string[], notes: string[]): Promise<void> {
  try {
    if (itemIds.size) {
      const { data, error } = await db().from("store_import_items").select("id, reason").in("id", Array.from(itemIds))
      if (error) throw new Error(error.message)
      for (const it of (data ?? []) as { id: string; reason: string | null }[]) {
        if (!/\(Needs a type\)/.test(it.reason ?? "")) continue
        const reason = (it.reason ?? "").replace(/\s*The client could see (this|it) but it has no type[^(]*\(Needs a type\)\.?/, "").trim()
        const { error: uErr } = await db().from("store_import_items").update({ reason: `${reason ? `${reason} ` : ""}Type set later: ${typeName}.`, updated_at: new Date().toISOString() }).eq("id", it.id)
        if (uErr) throw new Error(uErr.message)
      }
    }
    const { refreshRunReport } = await import("./drive-import")
    for (const r of runIds) await refreshRunReport(r)
  } catch (e) {
    console.error(`[crm-store] move report not refreshed after Set type: ${e instanceof Error ? e.message : e}`)
    notes.push("The type is saved; the move's report could not be refreshed — press Re-check types there.")
  }
}

/** The file's CRM record takes the type, the category and the person (a record in a person's storage is always that
 *  person's). A record the Drive move left on Drive (the file had no type, the client could see it) now opens from
 *  the new storage. Every record a move touched keeps what it said before in the move's ledger, so Undo restores it. */
async function followRecords(
  f: FileRow, folderId: string, type: TypeRow, legacyId: number | null, personal: boolean,
  owner: { contactId: string | null; accountId: string | null }, waiting: WaitingRow[], notes: string[],
): Promise<{ count: number; repointed: Array<{ itemId: string; entry: LedgerEntry }>; settled: Set<string> }> {
  const out = { count: 0, repointed: [] as Array<{ itemId: string; entry: LedgerEntry }>, settled: new Set<string>() }
  if (f.store_owners.kind === "business" || f.store_owners.kind === "private") return out
  const { storeDocumentLink } = await import("./document-pointer")
  const { categoryForFolder } = await import("./structure")
  const { categoryForKind } = await import("./browse")
  const pointer = storePointerOf(f.id)
  const cat = personal ? categoryForKind("personal") : await categoryForFolder(folderId)

  const { data: own, error: oErr } = await db().from("documents").select(RECORD_FIELDS).eq("drive_file_id", pointer)
  if (oErr) throw new Error(`Could not read the CRM listing — please try again (${oErr.message}).`)
  let ownRow = ((own ?? []) as Record<string, unknown>[])[0] ?? null
  // the items of THIS file's moves — a record they listed (hidden, "created") may give way to the real one
  const { data: fileItems, error: fiErr } = await db().from("store_import_items").select("id, repointed").eq("store_file_id", f.id)
  if (fiErr) throw new Error(`Could not read the move's ledger — please try again (${fiErr.message}).`)
  const items = (fileItems ?? []) as { id: string; repointed: LedgerEntry[] | null }[]
  for (const w of waiting) {
    if (ownRow) {
      const holder = items.find((i) => (i.repointed ?? []).some((r) => r.id === ownRow!.id && r.created))
      if (!holder) { notes.push(`"${f.name}" already has its own CRM record — the record still on Drive was left as it is.`); continue }
      const { error: dErr } = await db().from("documents").delete().eq("id", ownRow.id as string).eq("drive_file_id", pointer)
      if (dErr) throw new Error(`The CRM listing could not be updated (${dErr.message}).`)
      const rest = (holder.repointed ?? []).filter((r) => !(r.id === ownRow!.id && r.created))
      await db().from("store_import_items").update({ repointed: rest, updated_at: new Date().toISOString() }).eq("id", holder.id)
      holder.repointed = rest
      ownRow = null
    }
    const { data: full } = await db().from("documents").select(RECORD_FIELDS).eq("id", w.row.id).maybeSingle()
    const entry: LedgerEntry = { id: w.row.id, drive_file_id: w.row.drive_file_id, drive_link: w.row.drive_link, before: full ? beforeOf(full) : undefined }
    const { data: cur, error: cErr } = await db().from("store_import_items").select("repointed").eq("id", w.itemId).maybeSingle()
    if (cErr) throw new Error(`Could not read the move's ledger (${cErr.message}).`)
    const ledger = [...((cur?.repointed ?? []) as LedgerEntry[]).filter((r) => r.id !== entry.id || r.created), entry]
    const { error: lErr } = await db().from("store_import_items").update({ repointed: ledger, updated_at: new Date().toISOString() }).eq("id", w.itemId)
    if (lErr) throw new Error(`Could not update the move's ledger (${lErr.message}).`)
    const { data: moved, error: rErr } = await db().from("documents").update({ drive_file_id: pointer, drive_link: storeDocumentLink(w.row.id), updated_at: new Date().toISOString() })
      .eq("id", w.row.id).eq("drive_file_id", w.row.drive_file_id).select("id")
    if (rErr) throw new Error(`The CRM record could not be moved to the new storage (${rErr.message}).`)
    if (!(moved ?? []).length) continue // changed meanwhile — left as it is
    out.repointed.push({ itemId: w.itemId, entry })
    out.settled.add(w.itemId)
    ownRow = full ?? { id: w.row.id }
    notes.push("Its CRM record now opens from the new storage.")
  }
  // items whose record already opened from the store (hidden, typed-by-hand) are settled too
  if (ownRow) for (const i of items) if ((i.repointed ?? []).some((r) => r.id === ownRow!.id)) out.settled.add(i.id)

  // the record a move touched remembers what it said before (the first change wins) — Undo puts it back
  if (ownRow) {
    for (const i of items) {
      const entries = i.repointed ?? []
      const idx = entries.findIndex((r) => r.id === ownRow!.id && !r.created)
      if (idx < 0 || entries[idx].before) continue
      const next = entries.slice()
      next[idx] = { ...entries[idx], before: beforeOf(ownRow) }
      await db().from("store_import_items").update({ repointed: next, updated_at: new Date().toISOString() }).eq("id", i.id)
    }
  }

  const patch: Record<string, unknown> = {
    document_type_id: legacyId, document_type_name: type.display_name, category: cat.num, category_name: cat.name, updated_at: new Date().toISOString(),
  }
  if (owner.contactId) patch.contact_id = owner.contactId
  if (owner.accountId) { patch.account_id = owner.accountId; patch.contact_id = null }
  const { data: done, error } = await db().from("documents").update(patch).eq("drive_file_id", pointer).select("id")
  if (error) throw new Error(`The type is saved but the CRM record could not follow (${error.message}) — press Save again.`)
  out.count = (done ?? []).length
  return out
}
