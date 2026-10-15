/**
 * Storage check — what the CRM and the storage disagree about for ONE company (dev job ad09ea91, Antonio 2026-10-15).
 *
 * Shown as a pop-up in the CRM after a save and as a banner on the company page. The findings are COMPUTED LIVE from the
 * CRM and the storage every time (nothing to go stale, nothing double-fires, every writer is covered — the CRM, the portal
 * and the jobs alike). Only two things are stored (`storage_check_notes`): "X was removed from the company" (written just
 * before a CRM remove button acts) and "staff said this finding is not an issue".
 *
 * Phase 1 only TELLS and does the harmless things staff tick: create a person's storage, rename the company's folder,
 * move a misfiled document. Nothing here ends anyone's access or sends an email.
 *   · a person's storage holds only that person's documents — nothing moves between people on its own;
 *   · a suggested move is NEVER pre-ticked (a name on a file can match the wrong person);
 *   · everything is re-checked against the live state at the moment staff press Apply.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* / storage_check_notes are not in the generated types
const db = () => supabaseAdmin as any

// ───────────────────────────────────────────────────────────── types

export type FindingKind = "person_without_storage" | "folder_name_differs" | "member_without_link" | "misfiled_document" | "person_left"

export interface Finding {
  /** stable id of this finding (kind + subject) — what "Apply" and "Not an issue" refer to */
  key: string
  kind: FindingKind
  title: string
  detail: string
  /** what staff can tick; empty = information only */
  actions: Array<{ id: string; label: string; defaultOn: boolean }>
  /** a reason the action is blocked right now */
  blocked?: string | null
  data: Record<string, unknown>
}

export interface CheckPerson {
  contactId: string; name: string; hasStorage: boolean; ownerId: string | null; roles: string[]
  /** shown in the company's "2. Contacts" (or an individual member); a representative who is not shown is still compared for misfiled documents but never told to get a storage */
  listed?: boolean
}
export interface CheckMember { memberId: string; name: string; type: "individual" | "company"; contactId: string | null; linked: boolean }
export interface CheckFile { fileId: string; name: string; ownerContactId: string }
export interface LeftNote { id: string; contactId: string | null; name: string; createdAt: string }

export interface CheckSnapshot {
  accountId: string
  companyName: string
  /** the company has a LIVE storage (a hidden study copy or no storage at all → no check) */
  ownerId: string | null
  rootName: string | null
  rootCollision: boolean
  people: CheckPerson[]
  members: CheckMember[]
  files: CheckFile[]
  leftNotes: LeftNote[]
  dismissed: Set<string>
}

// ───────────────────────────────────────────────────────────── pure rules (unit-tested)

/** lower-case, accents removed, hyphens/underscores/dots as spaces */
export function normalizeForMatch(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

/** the words of a name that can identify a person (4+ letters, letters only) */
export function nameTokens(name: string): string[] {
  return Array.from(new Set(normalizeForMatch(name).split(" ").filter((t) => t.length >= 4 && /^[a-z]+$/.test(t))))
}

/**
 * Pure: who a file name seems to be for. A match = the file name has a word of THAT person's name and none of the owner's;
 * and only one person matches. Anything unclear gives null — the check never guesses.
 */
export function guessFileOwner(fileName: string, ownerName: string, others: Array<{ contactId: string; name: string }>): string | null {
  const words = new Set(normalizeForMatch(fileName).split(" ").filter(Boolean))
  if (nameTokens(ownerName).some((t) => words.has(t))) return null
  const hits = others.filter((o) => nameTokens(o.name).some((t) => words.has(t)))
  return hits.length === 1 ? hits[0].contactId : null
}

export function findingKey(kind: FindingKind, subject: string): string {
  return `${kind}:${subject}`
}

/** Pure: the findings for one company. Empty when the company is not in the new storage. */
export function evaluateStorageCheck(s: CheckSnapshot, safeName: (n: string) => string = (n) => n.trim()): Finding[] {
  if (!s.ownerId) return []
  const out: Finding[] = []

  // 1. a person on the company without a storage of their own
  for (const p of s.people) {
    if (p.hasStorage || p.listed === false) continue
    out.push({
      key: findingKey("person_without_storage", p.contactId), kind: "person_without_storage",
      title: `${p.name} has no storage of their own`,
      detail: `${p.name} is on ${s.companyName}${p.roles.length ? ` (${p.roles.join(", ")})` : ""} but their personal documents (passport, ITIN, personal tax) have no place yet.`,
      actions: [{ id: "create_person_storage", label: `Create ${p.name}'s storage`, defaultOn: true }], data: { contactId: p.contactId, name: p.name },
    })
  }

  // 2. the storage folder still has an old company name
  const want = safeName(s.companyName)
  if (s.rootName && s.rootName !== want) {
    out.push({
      key: findingKey("folder_name_differs", s.ownerId), kind: "folder_name_differs",
      title: "The storage folder has a different name than the company",
      detail: `The CRM says "${want}"; the storage folder is called "${s.rootName}". Documents keep their names.`,
      actions: [{ id: "rename_folder", label: `Rename the folder to "${want}"`, defaultOn: !s.rootCollision }],
      blocked: s.rootCollision ? "Another company folder already has that name — rename it by hand after checking." : null,
      data: { ownerId: s.ownerId, from: s.rootName, to: want },
    })
  }

  // 3. a member that is a person but is not linked to a person record / not linked to the company
  for (const m of s.members) {
    if (m.type !== "individual") continue // a company member has no person: nothing to show
    if (!m.contactId) {
      out.push({
        key: findingKey("member_without_link", m.memberId), kind: "member_without_link",
        title: `${m.name} is a member but is not linked to a person`,
        detail: "Without the link the person has no storage and does not show in 2. Contacts. Link the member to a person in the Members section.",
        actions: [], data: { memberId: m.memberId, name: m.name },
      })
    } else if (!m.linked) {
      out.push({
        key: findingKey("member_without_link", m.memberId), kind: "member_without_link",
        title: `${m.name} is a member but is not linked to the company's people`,
        detail: "The member is in the Members list but not in the company's people list, so they do not show in 2. Contacts.",
        actions: [], data: { memberId: m.memberId, name: m.name, contactId: m.contactId },
      })
    }
  }

  // 4. a document that looks like it belongs to another person of the company
  const byId = new Map(s.people.map((p) => [p.contactId, p]))
  for (const f of s.files) {
    const owner = byId.get(f.ownerContactId)
    if (!owner) continue
    const others = s.people.filter((p) => p.contactId !== owner.contactId).map((p) => ({ contactId: p.contactId, name: p.name }))
    const to = guessFileOwner(f.name, owner.name, others)
    if (!to) continue
    const target = byId.get(to)!
    out.push({
      key: findingKey("misfiled_document", f.fileId), kind: "misfiled_document",
      title: `"${f.name}" looks like ${target.name}'s, not ${owner.name}'s`,
      detail: `It is filed in ${owner.name}'s storage but the file name points to ${target.name}. This is a suggestion from the name only — check the file first.`,
      actions: [{ id: "move_document", label: `Move it to ${target.name}`, defaultOn: false }],
      data: { fileId: f.fileId, fileName: f.name, fromContactId: owner.contactId, toContactId: to, toName: target.name },
    })
  }

  // 5. someone was removed from the company by a CRM button
  for (const n of s.leftNotes) {
    out.push({
      key: findingKey("person_left", n.id), kind: "person_left",
      title: `${n.name} was removed from ${s.companyName}`,
      detail: `Their personal storage and documents stay with them; nothing was moved. What happens to their access to the company's stored documents and whether they get an email with their documents is decided in the next step — for now this only records the removal.`,
      actions: [{ id: "mark_seen", label: "Mark as seen", defaultOn: false }], data: { noteId: n.id, contactId: n.contactId, name: n.name },
    })
  }

  return out.filter((f) => !s.dismissed.has(f.key))
}

// ───────────────────────────────────────────────────────────── the live snapshot

async function selectAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await build(from, from + 999)
    if (error) throw new Error(`Storage check: could not read ${what} (${error.message}).`)
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  return out
}

export async function loadSnapshot(accountId: string): Promise<CheckSnapshot> {
  const d = db()
  const { data: acct, error: aErr } = await d.from("accounts").select("id, company_name").eq("id", accountId).maybeSingle()
  if (aErr || !acct) throw new Error("Storage check: company not found.")
  const { data: owner } = await d.from("store_owners").select("id, study_only").eq("account_id", accountId).eq("kind", "company").maybeSingle()
  const live = !!owner && owner.study_only === false
  const base: CheckSnapshot = { accountId, companyName: acct.company_name as string, ownerId: live ? (owner!.id as string) : null, rootName: null, rootCollision: false, people: [], members: [], files: [], leftNotes: [], dismissed: new Set() }
  if (!live) return base

  const { storeSafeFolderName } = await import("./formation-pilot")
  const want = storeSafeFolderName(base.companyName)
  // the independent reads go out together (a company page asks for this on every open)
  const [{ data: root }, { data: links }, { data: acRows }, { data: mRows }, notesRes] = await Promise.all([
    d.from("store_folders").select("name").eq("owner_id", owner!.id).is("parent_id", null).is("trashed_at", null).maybeSingle(),
    d.rpc("store_company_contacts", { p_account_id: accountId }),
    d.from("account_contacts").select("contact_id, role").eq("account_id", accountId).is("ended_at", null),
    d.from("members").select("id, member_type, full_name, company_name, contact_id, end_date").eq("account_id", accountId),
    Promise.resolve(d.from("storage_check_notes").select("id, kind, key, contact_id, person_name, created_at").eq("account_id", accountId).is("resolved_at", null)).catch(() => ({ data: null })),
  ])
  base.rootName = (root?.name as string | undefined) ?? null
  if (base.rootName && base.rootName !== want) {
    const { data: clash } = await d.from("store_folders").select("owner_id").is("parent_id", null).is("trashed_at", null).eq("name", want).neq("owner_id", owner!.id).limit(1)
    base.rootCollision = (clash ?? []).length > 0
  }

  // the company's people: the live "2. Contacts" list + the individual members that have a person record
  const linkedIds = new Set<string>(((links ?? []) as Array<{ contact_id: string }>).map((l) => l.contact_id))
  const rolesByContact = new Map<string, string[]>()
  for (const r of (acRows ?? []) as Array<{ contact_id: string; role: string | null }>) rolesByContact.set(r.contact_id, [...(rolesByContact.get(r.contact_id) ?? []), ...(r.role ? [r.role] : [])])
  const members = ((mRows ?? []) as Array<{ id: string; member_type: string; full_name: string | null; company_name: string | null; contact_id: string | null; end_date: string | null }>)
    .filter((m) => !m.end_date)
  const allLinked = new Set<string>((acRows ?? []).map((r: { contact_id: string }) => r.contact_id))
  base.members = members.map((m) => ({
    memberId: m.id, type: m.member_type === "company" ? "company" : "individual", name: m.member_type === "company" ? (m.company_name ?? "A company") : (m.full_name ?? "A member"),
    contactId: m.contact_id, linked: !!m.contact_id && allLinked.has(m.contact_id),
  }))
  const listedIds = new Set<string>(Array.from(linkedIds).concat(members.filter((m) => m.member_type !== "company" && m.contact_id).map((m) => m.contact_id as string)))
  // every person currently linked to the company is compared for misfiled documents (a representative's file can belong to the owner)
  const contactIds = Array.from(new Set<string>(Array.from(listedIds).concat(Array.from(allLinked))))
  if (contactIds.length) {
    const [{ data: cs }, { data: pos }] = await Promise.all([
      d.from("contacts").select("id, full_name").in("id", contactIds),
      d.from("store_owners").select("id, contact_id").eq("kind", "person").in("contact_id", contactIds),
    ])
    const nameOf = new Map<string, string>(((cs ?? []) as Array<{ id: string; full_name: string | null }>).map((c) => [c.id, c.full_name ?? "Person"]))
    const ownerOf = new Map<string, string>(((pos ?? []) as Array<{ id: string; contact_id: string }>).map((o) => [o.contact_id, o.id]))
    base.people = contactIds.map((id) => ({ contactId: id, name: nameOf.get(id) ?? "Person", hasStorage: ownerOf.has(id), ownerId: ownerOf.get(id) ?? null, roles: rolesByContact.get(id) ?? [], listed: listedIds.has(id) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // files of those people (names only) — to look for a document that seems to belong to another of them
    const ownerIds = base.people.map((p) => p.ownerId).filter((x): x is string => !!x)
    if (ownerIds.length) {
      const rows = await selectAll<{ id: string; name: string; owner_id: string }>((from, to) => d.from("store_files").select("id, name, owner_id").in("owner_id", ownerIds).eq("state", "live").order("id").range(from, to), "the people's files")
      const contactOfOwner = new Map(base.people.filter((p) => p.ownerId).map((p) => [p.ownerId as string, p.contactId]))
      base.files = rows.map((r) => ({ fileId: r.id, name: r.name, ownerContactId: contactOfOwner.get(r.owner_id) as string }))
    }
  }

  // stored notes (the table may not exist yet in an environment — then there are simply none)
  try {
    for (const n of ((notesRes.data ?? []) as Array<{ id: string; kind: string; key: string | null; contact_id: string | null; person_name: string | null; created_at: string }>)) {
      if (n.kind === "left") base.leftNotes.push({ id: n.id, contactId: n.contact_id, name: n.person_name ?? "A person", createdAt: n.created_at })
    }
    // a dismissed finding stays hidden: read those separately (they are resolved-null rows of kind 'dismissed')
    const { data: dis } = await d.from("storage_check_notes").select("key").eq("account_id", accountId).eq("kind", "dismissed")
    for (const x of (dis ?? []) as Array<{ key: string | null }>) if (x.key) base.dismissed.add(x.key)
  } catch { /* no notes table here yet */ }
  return base
}

export async function storageCheckFor(accountId: string): Promise<{ inStorage: boolean; findings: Finding[] }> {
  const snap = await loadSnapshot(accountId)
  const { storeSafeFolderName } = await import("./formation-pilot")
  return { inStorage: !!snap.ownerId, findings: evaluateStorageCheck(snap, storeSafeFolderName) }
}

// ───────────────────────────────────────────────────────────── notes (written by the CRM remove buttons)

/**
 * Just BEFORE a CRM button removes a person from a company: remember who they were. Never throws — the removal must go on
 * even if the note cannot be saved (a missing table, a double click).
 */
export async function recordPersonLeaving(p: { accountId: string; contactId: string | null; personName: string | null; actorId: string | null; via: string }): Promise<void> {
  try {
    if (!p.contactId) return
    const d = db()
    const { data: owner } = await d.from("store_owners").select("id").eq("account_id", p.accountId).eq("kind", "company").maybeSingle()
    if (!owner) return // the company is not in the new storage: nothing to tell
    await d.from("storage_check_notes").insert({ account_id: p.accountId, kind: "left", contact_id: p.contactId, person_name: p.personName, details: { via: p.via }, created_by: p.actorId })
  } catch { /* the removal goes on */ }
}

// ───────────────────────────────────────────────────────────── apply (re-checked against the live state)

export interface ApplyRequest { key: string; action: string }
export interface ApplyResult { key: string; action: string; ok: boolean; message: string }

export async function applyStorageCheck(accountId: string, requests: ApplyRequest[], actorId: string | null): Promise<ApplyResult[]> {
  const results: ApplyResult[] = []
  const d = db()
  for (const req of requests) {
    // every action starts from the LIVE state: the finding must still be there, exactly as shown
    const { findings } = await storageCheckFor(accountId)
    const f = findings.find((x) => x.key === req.key)
    if (!f) { results.push({ ...req, ok: false, message: "This was already handled or changed — nothing was done." }); continue }
    if (f.blocked) { results.push({ ...req, ok: false, message: f.blocked }); continue }
    if (!f.actions.some((a) => a.id === req.action)) { results.push({ ...req, ok: false, message: "That option is not available for this item." }); continue }
    try {
      if (req.action === "create_person_storage") {
        const { ensurePersonOwner } = await import("./formation-pilot")
        await ensurePersonOwner(f.data.contactId as string, f.data.name as string)
        results.push({ ...req, ok: true, message: `${f.data.name}'s storage was created.` })
      } else if (req.action === "rename_folder") {
        const { storeSafeFolderName } = await import("./formation-pilot")
        const snap = await loadSnapshot(accountId)
        const to = storeSafeFolderName(snap.companyName)
        const { data: renamed, error } = await d.rpc("store_rename_root", { p_owner_id: f.data.ownerId, p_name: to, p_actor: actorId })
        if (error) throw new Error(error.message.replace(/^store: /, ""))
        results.push({ ...req, ok: true, message: renamed ? `The folder is now called "${to}".` : "The folder already had that name." })
      } else if (req.action === "move_document") {
        const { changeFilePerson } = await import("./change-person")
        const r = await changeFilePerson(f.data.fileId as string, f.data.toContactId as string, actorId)
        results.push({ ...req, ok: true, message: `Moved to ${r.person}.` })
      } else if (req.action === "mark_seen") {
        await d.from("storage_check_notes").update({ resolved_at: new Date().toISOString(), resolved_by: actorId }).eq("id", f.data.noteId as string).is("resolved_at", null)
        results.push({ ...req, ok: true, message: "Marked as seen." })
      } else {
        results.push({ ...req, ok: false, message: "Unknown option." })
      }
    } catch (e) {
      results.push({ ...req, ok: false, message: e instanceof Error && e.message ? e.message : "It could not be done — please try again." })
    }
  }
  return results
}

/** "This is not an issue": the finding stops showing for this company. Reversible by deleting the note. */
export async function dismissFinding(accountId: string, key: string, actorId: string | null): Promise<void> {
  const d = db()
  const { error } = await d.from("storage_check_notes").insert({ account_id: accountId, kind: "dismissed", key, created_by: actorId })
  if (error && !/duplicate key|uq_storage_check_dismissed/i.test(error.message)) throw new Error(`Could not save that — ${error.message}`)
  if (key.startsWith("person_left:")) await d.from("storage_check_notes").update({ resolved_at: new Date().toISOString(), resolved_by: actorId }).eq("id", key.slice("person_left:".length)).is("resolved_at", null)
}
