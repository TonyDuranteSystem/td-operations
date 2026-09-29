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

async function companyMembers(accountId: string): Promise<Array<{ contactId: string; name: string }>> {
  const { data, error } = await db().from("account_contacts").select("contact_id, contacts(full_name)").eq("account_id", accountId)
  if (error) throw new Error(`Could not read the company's people — please try again (${error.message}).`)
  return ((data ?? []) as { contact_id: string; contacts: { full_name: string | null } | null }[])
    .map((r) => ({ contactId: r.contact_id, name: r.contacts?.full_name || "Person" }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The companies this person belongs to that have a new storage (a company document can go there). */
async function personCompanies(contactId: string): Promise<Array<{ ownerId: string; name: string; accountId: string }>> {
  const { data: links, error } = await db().from("account_contacts").select("account_id, accounts(company_name)").eq("contact_id", contactId)
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

  // the answers the type needs — asked BEFORE anything changes
  const people = personal && ownerKind === "company" && f.store_owners.account_id ? await companyMembers(f.store_owners.account_id) : []
  const companies = !personal && ownerKind === "person" && f.store_owners.contact_id ? await personCompanies(f.store_owners.contact_id) : []
  let companyAnswer = p.companyOwnerId ?? null
  if (!companyAnswer && p.viewingOwnerId && companies.some((c) => c.ownerId === p.viewingOwnerId)) companyAnswer = p.viewingOwnerId
  let personName = "the person"
  if (ownerKind === "person" && f.store_owners.contact_id) {
    const { data: c } = await db().from("contacts").select("full_name").eq("id", f.store_owners.contact_id).maybeSingle()
    personName = (c?.full_name as string | undefined) || personName
  }
  const q = questionFor({
    ownerKind, personal, draftNeverVisible, published: f.published, filingStatus: f.filing_status, typeName: type.display_name,
    hasPerson: !!p.personContactId, hasCompanyAnswer: !!companyAnswer, hasFiledAnswer: !!p.filedAnswer, people, companies, personName,
  })
  if (q) throw new SetTypeQuestionError(q)
  if (personal && ownerKind === "company" && !people.some((x) => x.contactId === p.personContactId)) throw new Error("That person is not linked to this company.")
  if (companyAnswer && companyAnswer !== "keep" && !companies.some((c) => c.ownerId === companyAnswer)) throw new Error("That company is not one of this person's companies.")

  // staff-only type on a visible file → hidden first (a file its workspace always shows is refused there)
  const { setClientVisibility } = await import("./browse")
  let visible = f.published
  if (visible && (staffOnly || (draftNeverVisible && f.filing_status !== "filed" && p.filedAnswer === "hide"))) {
    await setClientVisibility(f.id, false, p.actorId)
    visible = false
    notes.push(staffOnly ? "Hidden from the client — this type is staff-only." : "Hidden from the client until the return is filed.")
  }

  // where the file goes (the SAME file is re-homed — its record, versions, ledger and backup stay attached)
  let target: { folderId: string; accountId: string | null; contactId: string | null } | null = null
  if (personal && ownerKind === "company") {
    const { ensurePersonOwner, folderOfKind } = await import("./formation-pilot")
    const who = people.find((x) => x.contactId === p.personContactId)!
    const ownerId = await ensurePersonOwner(who.contactId, who.name)
    target = { folderId: await folderOfKind(ownerId, "personal"), accountId: f.store_owners.account_id, contactId: who.contactId }
  } else if (!personal && ownerKind === "person" && companyAnswer && companyAnswer !== "keep") {
    const { folderOfKind } = await import("./formation-pilot")
    const kind = typeof m.default_folder_kind === "string" && m.default_folder_kind !== "personal" ? m.default_folder_kind : "correspondence"
    // the type's folder; a year folder that isn't there yet → "3. Tax"; anything missing → "5. Correspondence"
    let folderId: string | null = null
    for (const k of [kind, kind === "tax_year" || kind === "person_tax_year" ? "tax" : null, "correspondence"].filter((x): x is string => !!x)) {
      try { folderId = await folderOfKind(companyAnswer, k); break } catch { /* next */ }
    }
    if (!folderId) throw new Error("The company's storage has no folder for this type.")
    target = { folderId, accountId: companies.find((c) => c.ownerId === companyAnswer)!.accountId, contactId: null }
  }
  let movedTo: string | null = null
  let folderId = f.folder_id
  if (target) {
    const name = await freeNameIn(target.folderId, f.name)
    if (name !== f.name) {
      const { renameStoreFile } = await import("./file-actions")
      await renameStoreFile(f.id, name, p.actorId)
      notes.push(`Renamed "${name}" — the folder already had a file called "${f.name}".`)
    }
    const { error: rhErr } = await db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: target.folderId, p_actor: p.actorId, p_reason: `Set type: ${type.display_name}` })
    if (rhErr) throw new Error(`The file could not be moved (${rhErr.message.replace(/^store: /, "")}).`)
    folderId = target.folderId
    movedTo = await pathOf(target.folderId)
  }

  // the type (and a return's year / draft state)
  const patch: Record<string, unknown> = { document_type: type.slug }
  if (draftNeverVisible && !f.period_year) {
    const { nearestYear } = await import("./structure")
    const y = await nearestYear(folderId)
    if (y) patch.period_year = y
  }
  const { error: uErr } = await db().from("store_files").update(patch).eq("id", f.id).eq("state", "live")
  if (uErr) throw new Error(`The type could not be saved (${uErr.message}).`)
  if (draftNeverVisible && (f.filing_status === "none" || !f.filing_status)) {
    await db().rpc("store_set_filing_status", { p_file_id: f.id, p_status: "draft", p_actor: p.actorId })
    if (p.filedAnswer === "filed") {
      const { error: fErr } = await db().rpc("store_set_filing_status", { p_file_id: f.id, p_status: "filed", p_actor: p.actorId })
      if (fErr) throw new Error(`The type is saved but the return could not be marked filed (${fErr.message.replace(/^store: /, "")}).`)
    }
  } else if (draftNeverVisible && f.filing_status === "draft" && p.filedAnswer === "filed") {
    const { error: fErr } = await db().rpc("store_set_filing_status", { p_file_id: f.id, p_status: "filed", p_actor: p.actorId })
    if (fErr) throw new Error(`The type is saved but the return could not be marked filed (${fErr.message.replace(/^store: /, "")}).`)
  }

  // the CRM record follows
  const recordsFollowed = await followRecords(f, folderId, type, legacyId, personal, target, p.actorId, notes)
  if (recordsFollowed.showNow && !visible) {
    try {
      await setClientVisibility(f.id, true, p.actorId)
      visible = true
    } catch (e) {
      notes.push(`Still hidden from the client: ${e instanceof Error ? e.message : "it could not be shown"}`)
    }
  }
  await settleMoveLedger(f.id, type.display_name)
  await logEvent({ ...f, folder_id: folderId }, p.actorId, { from: f.document_type, to: type.slug, moved_to: movedTo })
  return { typeName: type.display_name, movedTo, visible, notes, recordsFollowed: recordsFollowed.count }
}

/** The Drive move's report stops listing this file under "Waiting for a type" (its note says the type was set). */
async function settleMoveLedger(fileId: string, typeName: string): Promise<void> {
  const { data } = await db().from("store_import_items").select("id, reason").eq("store_file_id", fileId).ilike("reason", "%(Needs a type)%")
  for (const it of (data ?? []) as { id: string; reason: string }[]) {
    const reason = it.reason.replace(/\s*The client could see (this|it) but it has no type[^(]*\(Needs a type\)\.?/, "").trim()
    await db().from("store_import_items").update({ reason: `${reason ? `${reason} ` : ""}Type set later: ${typeName}.`, updated_at: new Date().toISOString() }).eq("id", it.id)
  }
}

/** The file's CRM record takes the type, the category and the person. A record the Drive move left on Drive (the
 *  file had no type, the client could see it) now opens from the new storage — the old pointer is written to the
 *  move's ledger first, so Undo still puts it back. */
async function followRecords(
  f: FileRow, folderId: string, type: TypeRow, legacyId: number | null, personal: boolean,
  target: { accountId: string | null; contactId: string | null } | null, actorId: string | null, notes: string[],
): Promise<{ count: number; showNow: boolean }> {
  if (f.store_owners.kind === "business" || f.store_owners.kind === "private") return { count: 0, showNow: false }
  const { storePointer, storeDocumentLink } = await import("./document-pointer")
  const { categoryForFolder } = await import("./structure")
  const { categoryForKind } = await import("./browse")
  const pointer = storePointer(f.id)
  const cat = personal ? categoryForKind("personal") : await categoryForFolder(folderId)
  let showNow = false

  // records still on Drive for this file (moved while it had no type)
  const { data: waiting, error: wErr } = await db().from("store_import_items").select("id, source_id, repointed").eq("store_file_id", f.id).eq("source", "drive")
  if (wErr) throw new Error(`Could not read the move's ledger — please try again (${wErr.message}).`)
  const { data: own, error: oErr } = await db().from("documents").select("id, portal_visible").eq("drive_file_id", pointer)
  if (oErr) throw new Error(`Could not read the CRM listing — please try again (${oErr.message}).`)
  let ownRow = ((own ?? []) as { id: string; portal_visible: boolean | null }[])[0] ?? null
  for (const it of (waiting ?? []) as { id: string; source_id: string; repointed: Array<{ id: string; drive_file_id: string; drive_link: string | null; created?: boolean }> }[]) {
    const { data: rows } = await db().from("documents").select("id, drive_file_id, drive_link, portal_visible").eq("drive_file_id", it.source_id)
    const row = ((rows ?? []) as { id: string; drive_file_id: string; drive_link: string | null; portal_visible: boolean | null }[])[0]
    if (!row) continue
    // the file already has its own record: one the move listed (hidden) gives way to the real one; anything else stays
    if (ownRow) {
      const { data: placeholder } = await db().from("store_import_items").select("id").filter("repointed", "cs", JSON.stringify([{ id: ownRow.id, created: true }])).limit(1)
      if (!(placeholder ?? []).length) { notes.push(`"${f.name}" already has its own CRM record — the record still on Drive was left as it is.`); continue }
      const { error: dErr } = await db().from("documents").delete().eq("id", ownRow.id)
      if (dErr) throw new Error(`The CRM listing could not be updated (${dErr.message}).`)
      ownRow = null
    }
    const ledger = [...(it.repointed ?? []), { id: row.id, drive_file_id: row.drive_file_id, drive_link: row.drive_link }]
    const { error: lErr } = await db().from("store_import_items").update({ repointed: ledger, updated_at: new Date().toISOString() }).eq("id", it.id)
    if (lErr) throw new Error(`Could not update the move's ledger (${lErr.message}).`)
    const { error: rErr } = await db().from("documents").update({ drive_file_id: pointer, drive_link: storeDocumentLink(row.id), updated_at: new Date().toISOString() }).eq("id", row.id)
    if (rErr) throw new Error(`The CRM record could not be moved to the new storage (${rErr.message}).`)
    ownRow = { id: row.id, portal_visible: row.portal_visible }
    if (row.portal_visible) showNow = true
    notes.push("Its CRM record now opens from the new storage.")
  }

  const patch: Record<string, unknown> = {
    document_type_id: legacyId, document_type_name: type.display_name, category: cat.num, category_name: cat.name, updated_at: new Date().toISOString(),
  }
  if (target?.contactId) patch.contact_id = target.contactId
  if (target && !target.contactId && target.accountId) { patch.account_id = target.accountId; patch.contact_id = null }
  const { data: done, error } = await db().from("documents").update(patch).eq("drive_file_id", pointer).select("id")
  if (error) throw new Error(`The type is saved but the CRM record could not follow (${error.message}) — press Set type again.`)
  void actorId
  return { count: (done ?? []).length, showNow }
}
