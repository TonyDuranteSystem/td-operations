/**
 * Address book: the one place that reads the CRM (READ ONLY) and reads/writes the address book's own tables.
 *   - contacts, accounts, account_contacts and partners are only ever SELECTed here. Nothing in this file inserts, updates or deletes them.
 *   - address_book_entries (the Company book's own people), address_book_crm_labels (the type Antonio confirmed for a CRM person) and the catalog 'address_book_types' are what it writes.
 * The Personal book (address_book_personal) is NOT here: it is encrypted and opens only for one login (personal-access.ts); it comes with the phone.
 * `lib/database.types.ts` does not know the new tables yet, so the client is used untyped; every column below is checked by the tests against the migration.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getEntryById, listEntries } from "@/lib/catalog/framework"
import { buildRows, crmMatches, kindOfContact, savedCountByType, type AccountIn, type ContactIn, type EntryIn, type LabelIn, type LinkIn, type PartnerIn } from "@/lib/address-book/build-rows"
import { CRM_KIND_TEXT, canRetype } from "@/lib/address-book/crm-kind"
import { AddressBookError } from "@/lib/address-book/errors"
import type { MatchDto, PersonRow, TypeDto } from "@/lib/address-book/people"
import { typeDto } from "@/lib/address-book/type-admin"
import { ADDRESS_BOOK_TYPES_CATALOG, cleanExtra, lookupKeys, normalizeEmail, parseTypeMeta, personInputSchema, phoneKeysOf, type PersonInput } from "@/lib/address-book/types"
import type { Who } from "@/lib/address-book/access"

// the three address book tables are not in lib/database.types.ts yet (regenerate through the CI artifact), so the client is used untyped here, the way lib/marketing does
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

interface PageQuery {
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
}

/** Reads every row of a query, a thousand at a time (the database never hands back more than that in one go). */
async function pageAll<T>(label: string, make: () => PageQuery): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999)
    if (error) throw new Error(`address book: could not read ${label}: ${error.message}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

/** The CRM, read only: who is a person we already have. Test and merged contacts and test accounts are left out. */
export async function readCrm(): Promise<{ contacts: ContactIn[]; accounts: AccountIn[]; links: LinkIn[]; partners: PartnerIn[] }> {
  const [contacts, accounts, links, partners] = await Promise.all([
    pageAll<ContactIn>("contacts", () =>
      db().from("contacts").select("id, full_name, email, email_2, alt_emails, phone, phone_2, phone_3, phone_4, portal_tier, created_at").is("merged_into", null).eq("is_test", false).order("id"),
    ),
    pageAll<AccountIn>("accounts", () => db().from("accounts").select("id, company_name, account_type, status").eq("is_test", false).order("id")),
    pageAll<LinkIn>("account links", () => db().from("account_contacts").select("account_id, contact_id, is_primary, ended_at").order("account_id").order("contact_id")),
    pageAll<PartnerIn>("partners", () =>
      db().from("partners").select("id, partner_name, company, partner_type, email, secondary_email, phone, service_area, created_at").order("id"),
    ),
  ])
  return { contacts, accounts, links, partners }
}

const ENTRY_COLUMNS = "id, full_name, company, job_title, website, phones, emails, address, notes, extra, type_entry_id, source, created_at"

async function readEntries(): Promise<EntryIn[]> {
  return pageAll<EntryIn>("people saved here", () => db().from("address_book_entries").select(ENTRY_COLUMNS).is("archived_at", null).order("id"))
}

async function readLabels(): Promise<LabelIn[]> {
  return pageAll<LabelIn>("confirmed types", () => db().from("address_book_crm_labels").select("subject_kind, subject_id, type_entry_id").order("id"))
}

export interface AddressBookData {
  rows: PersonRow[]
  types: TypeDto[]
}

/** Everything the page needs in one go. */
export async function loadAddressBook(): Promise<AddressBookData> {
  const [crm, labels, entries, typeEntries] = await Promise.all([readCrm(), readLabels(), readEntries(), listEntries(ADDRESS_BOOK_TYPES_CATALOG, { includeDeprecated: true })])
  const counts = savedCountByType(entries)
  const types = typeEntries.map((e) => typeDto(e, counts.get(e.id) ?? 0)).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
  return { rows: buildRows({ ...crm, labels, entries, types }), types }
}

// ───────────────────────────── "already here?" ─────────────────────────────

export interface MatchKeys {
  phones?: readonly string[]
  emails?: readonly string[]
  /** the saved person being edited: never a match for itself */
  exceptSavedId?: string
}

/** Who already holds one of these phone numbers or emails: CRM people first, then people saved here. */
export async function findMatches(input: MatchKeys): Promise<MatchDto[]> {
  const keys = lookupKeys({ phones: input.phones, emails: input.emails })
  if (keys.phone_keys.length === 0 && keys.emails.length === 0) return []
  const [crm, saved, typeEntries] = await Promise.all([
    readCrm(),
    (async () => {
      const found = new Map<string, { id: string; full_name: string; company: string | null; type_entry_id: string | null }>()
      const cols = "id, full_name, company, type_entry_id"
      const runs: PromiseLike<{ data: unknown; error: { message: string } | null }>[] = []
      if (keys.phone_keys.length) runs.push(db().from("address_book_entries").select(cols).is("archived_at", null).overlaps("phone_keys", keys.phone_keys))
      if (keys.emails.length) runs.push(db().from("address_book_entries").select(cols).is("archived_at", null).overlaps("emails", keys.emails))
      for (const r of await Promise.all(runs)) {
        if (r.error) throw new Error(`address book: could not check saved people: ${r.error.message}`)
        for (const row of (r.data ?? []) as { id: string; full_name: string; company: string | null; type_entry_id: string | null }[]) found.set(row.id, row)
      }
      return Array.from(found.values())
    })(),
    listEntries(ADDRESS_BOOK_TYPES_CATALOG, { includeDeprecated: true }),
  ])
  const typeName = new Map(typeEntries.map((e) => [e.id, e.display_name]))
  const out: MatchDto[] = crmMatches(crm, { phoneKeys: keys.phone_keys, emails: keys.emails }).map((m) => {
    const [kind, id] = m.key.split(":")
    return { key: m.key, source: "crm" as const, id, name: m.name, company: m.company, what: CRM_KIND_TEXT[m.crmKind].row, href: kind === "partner" ? `/partners/${id}` : `/contacts/${id}` }
  })
  for (const s of saved) {
    if (s.id === input.exceptSavedId) continue
    out.push({ key: `saved:${s.id}`, source: "saved", id: s.id, name: s.full_name, company: s.company, what: (s.type_entry_id && typeName.get(s.type_entry_id)) || "Saved here", href: null })
  }
  return out
}

// ───────────────────────────── saving a person ─────────────────────────────

function firstProblem(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0]
  const field = String(issue?.path?.[0] ?? "")
  if (field === "full_name") return "Enter the person's name."
  if (field === "phones") return "Check the phone numbers: at most 6, none empty or longer than 60 characters."
  if (field === "emails") return "Check the emails: at most 6."
  return "Some details are too long or not understood. Check them and try again."
}

interface Checked {
  input: PersonInput
  boxes: ReturnType<typeof parseTypeMeta>["boxes"]
  extra: Record<string, string | number | boolean>
  keys: ReturnType<typeof lookupKeys>
}

/** The person as it will be stored, or the plain-words reason it cannot be. */
async function check(raw: unknown): Promise<Checked> {
  const parsed = personInputSchema.safeParse(raw)
  if (!parsed.success) throw new AddressBookError(400, firstProblem(parsed.error))
  const input = parsed.data
  for (const e of input.emails) {
    if (!normalizeEmail(e)) throw new AddressBookError(400, `"${e}" is not an email address.`)
  }
  let boxes: Checked["boxes"] = []
  if (input.type_entry_id) {
    const entry = await getEntryById(input.type_entry_id)
    if (!entry || entry.catalog_id !== ADDRESS_BOOK_TYPES_CATALOG || entry.status !== "active") throw new AddressBookError(400, "That type is hidden or no longer exists. Choose another one.")
    boxes = parseTypeMeta(entry.metadata).boxes
  }
  const extra = cleanExtra(boxes, input.extra)
  if (extra.problems.length) throw new AddressBookError(400, extra.problems.join(". ") + ".")
  return { input, boxes, extra: extra.value, keys: lookupKeys({ phones: input.phones, emails: input.emails }) }
}

function columns(c: Checked) {
  return {
    full_name: c.input.full_name,
    company: c.input.company,
    job_title: c.input.job_title,
    website: c.input.website,
    phones: c.keys.phones,
    phone_keys: c.keys.phone_keys,
    emails: c.keys.emails,
    address: c.input.address,
    notes: c.input.notes,
    extra: c.extra,
    type_entry_id: c.input.type_entry_id ?? null,
  }
}

async function refuseDuplicates(c: Checked, force: boolean, exceptSavedId?: string): Promise<void> {
  if (force) return
  const matches = await findMatches({ phones: c.keys.phones, emails: c.keys.emails, exceptSavedId })
  if (matches.length === 0) return
  const m = matches[0]
  const where = m.source === "crm" ? `${m.what}, in the CRM` : m.what === "Saved here" ? "saved here" : `${m.what}, saved here`
  throw new AddressBookError(409, `${m.name} (${where}) already has this phone or email.`, { matches })
}

export const SAVED_SOURCES = ["typed", "email", "whatsapp", "card", "other"] as const

export async function createPerson(raw: unknown, who: Who, opts: { force?: boolean; source?: string } = {}): Promise<{ id: string }> {
  const c = await check(raw)
  await refuseDuplicates(c, opts.force === true)
  const source = (SAVED_SOURCES as readonly string[]).includes(opts.source ?? "") ? (opts.source as string) : "typed"
  const { data, error } = await db()
    .from("address_book_entries")
    .insert({ ...columns(c), source, created_by: who.id, created_by_email: who.email })
    .select("id")
    .single()
  if (error || !data) throw new Error(`address book: could not save the person: ${error?.message ?? "no row came back"}`)
  return { id: (data as { id: string }).id }
}

export async function updatePerson(id: string, raw: unknown, opts: { force?: boolean } = {}): Promise<void> {
  const c = await check(raw)
  const { data: current, error: readErr } = await db().from("address_book_entries").select("phone_keys, emails").eq("id", id).is("archived_at", null).maybeSingle()
  if (readErr) throw new Error(`address book: could not read the person: ${readErr.message}`)
  if (!current) throw new AddressBookError(404, "That person was not found. Reload the page.")
  // only a phone or email that is NEW on this person can be a duplicate: one already saved here is not asked about again every time the notes change
  const had = current as { phone_keys: string[] | null; emails: string[] | null }
  const knownKeys = new Set(had.phone_keys ?? [])
  const knownEmails = new Set(had.emails ?? [])
  const added = {
    ...c,
    keys: {
      ...c.keys,
      phones: c.keys.phones.filter((p) => !phoneKeysOf(p).some((k) => knownKeys.has(k))),
      emails: c.keys.emails.filter((e) => !knownEmails.has(e)),
    },
  }
  await refuseDuplicates(added, opts.force === true, id)
  const { data, error } = await db()
    .from("address_book_entries")
    .update({ ...columns(c), updated_at: new Date().toISOString() })
    .eq("id", id)
    .is("archived_at", null)
    .select("id")
  if (error) throw new Error(`address book: could not save the changes: ${error.message}`)
  if (!data || data.length === 0) throw new AddressBookError(404, "That person was not found. Reload the page.")
}

/** Takes a person out of the lists. The row is kept (archived_at), never deleted. */
export async function archivePerson(id: string): Promise<void> {
  const { data, error } = await db().from("address_book_entries").update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).is("archived_at", null).select("id")
  if (error) throw new Error(`address book: could not remove the person: ${error.message}`)
  if (!data || data.length === 0) throw new AddressBookError(404, "That person was not found. Reload the page.")
}

// ───────────────────────────── a type for a CRM person ─────────────────────────────

/**
 * Antonio's answer to "What is this person?" for a CRM person the CRM leaves unsorted. Kept only in address_book_crm_labels; the contact itself is never changed.
 * Only people the CRM calls "Not sorted yet" or "Other" can be given one: a client, lead or partner is sorted by the CRM and that stays the truth.
 * `typeId` null takes the answer back.
 */
export async function setCrmLabel(input: { kind: string; id: string; typeId: string | null }, who: Who): Promise<void> {
  if (input.kind !== "contact") throw new AddressBookError(400, "Only people from the Contacts page can be given a type. Partners are sorted by the Partners page.")
  const { data: contact, error } = await db()
    .from("contacts")
    .select("id, full_name, email, email_2, alt_emails, phone, phone_2, phone_3, phone_4, portal_tier, created_at")
    .eq("id", input.id)
    .is("merged_into", null)
    .eq("is_test", false)
    .maybeSingle()
  if (error) throw new Error(`address book: could not read the contact: ${error.message}`)
  if (!contact) throw new AddressBookError(404, "That person was not found. Reload the page.")
  const { data: links, error: lErr } = await db().from("account_contacts").select("account_id, contact_id, is_primary, ended_at").eq("contact_id", input.id)
  if (lErr) throw new Error(`address book: could not read the links: ${lErr.message}`)
  const accountIds = Array.from(new Set(((links ?? []) as LinkIn[]).map((l) => l.account_id)))
  const accounts = accountIds.length
    ? (((await db().from("accounts").select("id, company_name, account_type, status").in("id", accountIds).eq("is_test", false)).data ?? []) as AccountIn[])
    : []
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const items = ((links ?? []) as LinkIn[]).flatMap((l) => (byId.has(l.account_id) ? [{ link: l, account: byId.get(l.account_id) as AccountIn }] : []))
  const kind = kindOfContact(contact as ContactIn, items)
  if (!canRetype(kind)) throw new AddressBookError(409, `The CRM already sorts this person as "${CRM_KIND_TEXT[kind].row}", so that stays.`)

  if (input.typeId === null) {
    const { error: dErr } = await db().from("address_book_crm_labels").delete().eq("subject_kind", "contact").eq("subject_id", input.id)
    if (dErr) throw new Error(`address book: could not take the type back: ${dErr.message}`)
    return
  }
  const entry = await getEntryById(input.typeId)
  if (!entry || entry.catalog_id !== ADDRESS_BOOK_TYPES_CATALOG || entry.status !== "active") throw new AddressBookError(400, "That type is hidden or no longer exists. Choose another one.")
  const { error: uErr } = await db()
    .from("address_book_crm_labels")
    .upsert({ subject_kind: "contact", subject_id: input.id, type_entry_id: input.typeId, confirmed_by_email: who.email, updated_at: new Date().toISOString() }, { onConflict: "subject_kind,subject_id" })
  if (uErr) throw new Error(`address book: could not save the type: ${uErr.message}`)
}
