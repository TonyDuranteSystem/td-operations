/**
 * Address book: turns what the CRM and the address book tables hold into the rows the page draws. PURE (no database): the store reads, this decides.
 * It never writes and never changes the CRM data it is handed.
 */
import { canRetype, classifyContact, classifyPartner, type AccountLink, type CrmKind } from "@/lib/address-book/crm-kind"
import { buildSearch, firstOf, sortKey, type PersonRow, type SavedDetail, type TypeDto } from "@/lib/address-book/people"
import { normalizeEmail, phoneKeysOf, type ExtraValue } from "@/lib/address-book/types"

export interface ContactIn {
  id: string
  full_name: string | null
  email: string | null
  email_2: string | null
  alt_emails: string[] | null
  phone: string | null
  phone_2: string | null
  phone_3: string | null
  phone_4: string | null
  portal_tier: string | null
  created_at: string | null
}
export interface AccountIn {
  id: string
  company_name: string | null
  account_type: string | null
  status: string | null
}
export interface LinkIn {
  account_id: string
  contact_id: string
  is_primary: boolean | null
  ended_at: string | null
}
export interface PartnerIn {
  id: string
  partner_name: string | null
  company: string | null
  partner_type: string | null
  email: string | null
  secondary_email: string | null
  phone: string | null
  service_area: string | null
  created_at: string | null
}
export interface LabelIn {
  subject_kind: string
  subject_id: string
  type_entry_id: string | null
}
export interface EntryIn {
  id: string
  full_name: string
  company: string | null
  job_title: string | null
  website: string | null
  phones: string[] | null
  emails: string[] | null
  address: string | null
  notes: string | null
  extra: unknown
  type_entry_id: string | null
  source: string | null
  created_at: string | null
}

export interface CrmInputs {
  contacts: readonly ContactIn[]
  accounts: readonly AccountIn[]
  links: readonly LinkIn[]
  partners: readonly PartnerIn[]
}

/** The links of every contact, tied to their (non-test) account. A link to an account that was not loaded (a test account) is left out. */
export function linksByContact(accounts: readonly AccountIn[], links: readonly LinkIn[]): Map<string, { link: LinkIn; account: AccountIn }[]> {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const out = new Map<string, { link: LinkIn; account: AccountIn }[]>()
  for (const link of links) {
    const account = byId.get(link.account_id)
    if (!account) continue
    const list = out.get(link.contact_id) ?? []
    list.push({ link, account })
    out.set(link.contact_id, list)
  }
  return out
}

/** The company to show for a contact: a live Active client company first, the primary one first, then the first by name. */
export function companyOf(items: readonly { link: LinkIn; account: AccountIn }[]): string | null {
  const rank = (x: { link: LinkIn; account: AccountIn }) => (!x.link.ended_at && x.account.account_type === "Client" && x.account.status === "Active" ? 0 : !x.link.ended_at ? 1 : 2)
  const sorted = [...items].filter((x) => x.account.company_name).sort((a, b) => rank(a) - rank(b) || Number(!!b.link.is_primary) - Number(!!a.link.is_primary) || (a.account.company_name ?? "").localeCompare(b.account.company_name ?? ""))
  return sorted[0]?.account.company_name ?? null
}

/** What the CRM says about one contact. */
export function kindOfContact(c: ContactIn, items: readonly { link: LinkIn; account: AccountIn }[]): CrmKind {
  const links: AccountLink[] = items.map((x) => ({ accountType: x.account.account_type, accountStatus: x.account.status, ended: !!x.link.ended_at }))
  return classifyContact({ portalTier: c.portal_tier, links })
}

function extraOf(raw: unknown): Record<string, ExtraValue> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, ExtraValue> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v
  return out
}

/**
 * Every row of the address book, sorted by name. `types` is every type (hidden ones too): a person filed under a HIDDEN type, or under a type that is gone, shows as having no type,
 * and a confirmed type on a CRM person only counts while the CRM still calls them "Not sorted yet" or "Other" and the type is visible.
 */
export function buildRows(input: CrmInputs & { labels: readonly LabelIn[]; entries: readonly EntryIn[]; types: readonly TypeDto[] }): PersonRow[] {
  const visibleTypes = new Map(input.types.filter((t) => !t.hidden).map((t) => [t.id, t]))
  const labelOf = new Map<string, string | null>()
  for (const l of input.labels) labelOf.set(`${l.subject_kind}:${l.subject_id}`, l.type_entry_id)
  const linkMap = linksByContact(input.accounts, input.links)
  const rows: PersonRow[] = []

  for (const c of input.contacts) {
    const items = linkMap.get(c.id) ?? []
    const crmKind = kindOfContact(c, items)
    const labelled = labelOf.get(`contact:${c.id}`) ?? null
    const typeId = canRetype(crmKind) && labelled && visibleTypes.has(labelled) ? labelled : null
    const name = (c.full_name ?? "").trim() || "(no name)"
    const company = companyOf(items)
    const phones = [c.phone, c.phone_2, c.phone_3, c.phone_4]
    const emails = [c.email, c.email_2, ...(c.alt_emails ?? [])]
    rows.push({
      key: `contact:${c.id}`,
      source: "crm",
      id: c.id,
      name,
      company,
      phone: firstOf(phones),
      email: firstOf(emails),
      crmKind,
      typeId,
      serviceArea: null,
      extra: {},
      detail: null,
      search: buildSearch({ name, company, emails, phones }),
      createdAt: c.created_at,
    })
  }

  for (const p of input.partners) {
    const crmKind = classifyPartner(p.partner_type)
    const name = (p.partner_name ?? "").trim() || (p.company ?? "").trim() || "(no name)"
    rows.push({
      key: `partner:${p.id}`,
      source: "crm",
      id: p.id,
      name,
      company: p.company,
      phone: firstOf([p.phone]),
      email: firstOf([p.email, p.secondary_email]),
      crmKind,
      typeId: null,
      serviceArea: p.service_area,
      extra: {},
      detail: null,
      search: buildSearch({ name, company: p.company, emails: [p.email, p.secondary_email], phones: [p.phone], extra: p.service_area ? [p.service_area] : [] }),
      createdAt: p.created_at,
    })
  }

  for (const e of input.entries) {
    const typeId = e.type_entry_id && visibleTypes.has(e.type_entry_id) ? e.type_entry_id : null
    const extra = extraOf(e.extra)
    const phones = e.phones ?? []
    const emails = e.emails ?? []
    const detail: SavedDetail = { phones: [...phones], emails: [...emails], job_title: e.job_title, website: e.website, address: e.address, notes: e.notes, source: e.source ?? "typed" }
    rows.push({
      key: `saved:${e.id}`,
      source: "saved",
      id: e.id,
      name: e.full_name,
      company: e.company,
      phone: firstOf(phones),
      email: firstOf(emails),
      crmKind: null,
      typeId,
      serviceArea: null,
      extra,
      detail,
      search: buildSearch({ name: e.full_name, company: e.company, emails, phones, extra: [e.job_title ?? "", e.notes ?? "", ...Object.values(extra).map(String)] }),
      createdAt: e.created_at,
    })
  }

  return rows.sort((a, b) => (sortKey(a.name) < sortKey(b.name) ? -1 : sortKey(a.name) > sortKey(b.name) ? 1 : 0))
}

/** How many people are saved under each type (hidden types included), for "Manage types". */
export function savedCountByType(entries: readonly EntryIn[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of entries) if (e.type_entry_id) out.set(e.type_entry_id, (out.get(e.type_entry_id) ?? 0) + 1)
  return out
}

export interface Match {
  key: string
  source: "crm" | "saved"
  name: string
  company: string | null
  /** "Client with a company", the saved type's name, … filled by the caller */
  what: string
}

/** CRM people (contacts and partners) that already hold one of these phone numbers or emails. Pure; the caller supplies the lists. */
export function crmMatches(input: CrmInputs, keys: { phoneKeys: readonly string[]; emails: readonly string[] }): { key: string; name: string; company: string | null; crmKind: CrmKind }[] {
  const pk = new Set(keys.phoneKeys)
  const em = new Set(keys.emails)
  if (pk.size === 0 && em.size === 0) return []
  const linkMap = linksByContact(input.accounts, input.links)
  const out: { key: string; name: string; company: string | null; crmKind: CrmKind }[] = []
  const hit = (phones: readonly (string | null)[], emails: readonly (string | null)[]) =>
    phones.some((p) => phoneKeysOf(p).some((k) => pk.has(k))) ||
    emails.some((e) => {
      const n = normalizeEmail(e)
      return !!n && em.has(n)
    })
  for (const c of input.contacts) {
    if (!hit([c.phone, c.phone_2, c.phone_3, c.phone_4], [c.email, c.email_2, ...(c.alt_emails ?? [])])) continue
    const items = linkMap.get(c.id) ?? []
    out.push({ key: `contact:${c.id}`, name: (c.full_name ?? "").trim() || "(no name)", company: companyOf(items), crmKind: kindOfContact(c, items) })
  }
  for (const p of input.partners) {
    if (!hit([p.phone], [p.email, p.secondary_email])) continue
    out.push({ key: `partner:${p.id}`, name: (p.partner_name ?? "").trim() || (p.company ?? "").trim() || "(no name)", company: p.company, crmKind: classifyPartner(p.partner_type) })
  }
  return out
}
