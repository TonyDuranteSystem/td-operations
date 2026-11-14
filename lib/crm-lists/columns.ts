/**
 * Which extra fields the Accounts and Contacts lists show, and how the saved choice is read.
 *
 * Each person picks their own fields with the "Columns" dropdown; the choice is saved with their login (see prefs.ts) so it follows them
 * to every computer. The fields that are always there (name, companies, 1st Inst, 2nd Inst, Per year) are not in this list.
 *
 * Pure and client-safe: no database, no React.
 */

export type ListId = 'contacts' | 'accounts'

export interface ColumnDef {
  id: string
  /** Full name, used in the Columns dropdown. */
  label: string
  /** Shorter header when the full name would not fit over the column. */
  short?: string
  /** Heading in the Columns dropdown. */
  group: string
  /** The column's width on a wide window (a CSS grid track). Unused by a flag. */
  track: string
  /** Shown after the money columns instead of before them (Accounts "Overdue"). */
  tail?: boolean
  /** Not a column of its own: switches something inside the row on or off (Contacts "Company status"). */
  flag?: boolean
}

export const CONTACT_COLUMNS: readonly ColumnDef[] = [
  { id: 'email', label: 'Email', group: 'Contact details', track: 'minmax(140px,230px)' },
  { id: 'phone', label: 'Phone', group: 'Contact details', track: '130px' },
  { id: 'language', label: 'Language', group: 'Contact details', track: '90px' },
  { id: 'citizenship', label: 'Citizenship', group: 'About the person', track: '100px' },
  { id: 'passport_on_file', label: 'Passport on file', short: 'Passport', group: 'Documents', track: '84px' },
  { id: 'itin_on_file', label: 'ITIN on file', short: 'ITIN', group: 'Documents', track: '64px' },
  { id: 'portal_stage', label: 'Portal stage', group: 'Portal and record', track: '100px' },
  { id: 'portal_role', label: 'Portal role', group: 'Portal and record', track: '100px' },
  { id: 'added_on', label: 'Added on', group: 'Portal and record', track: '104px' },
  { id: 'company_count', label: 'Number of companies', short: 'Companies', group: 'Portal and record', track: '90px' },
  { id: 'company_status', label: 'Company status (the Active chip)', group: 'Portal and record', track: '0px', flag: true },
]

export const ACCOUNT_COLUMNS: readonly ColumnDef[] = [
  { id: 'type', label: 'Company type', short: 'Type', group: 'The company', track: '72px' },
  { id: 'kind', label: 'Kind (Client / One-time / Partner)', short: 'Kind', group: 'The company', track: '84px' },
  { id: 'status', label: 'Status', group: 'The company', track: '100px' },
  { id: 'state_of_formation', label: 'State of formation', short: 'State', group: 'The company', track: '110px' },
  { id: 'formation_date', label: 'Formation date', short: 'Formed', group: 'The company', track: '104px' },
  { id: 'client_since', label: 'Client since', group: 'The company', track: '104px' },
  { id: 'onboarding_date', label: 'Onboarding date', short: 'Onboarded', group: 'The company', track: '104px' },
  { id: 'member_count', label: 'Number of members', short: 'Members', group: 'The company', track: '78px' },
  { id: 'ein', label: 'EIN', group: 'Identity and address', track: '104px' },
  { id: 'suite_number', label: 'Suite number', short: 'Suite', group: 'Identity and address', track: '72px' },
  { id: 'physical_address', label: 'Physical address', short: 'Address', group: 'Identity and address', track: 'minmax(170px,250px)' },
  { id: 'registered_agent', label: 'Registered agent', short: 'Agent', group: 'Identity and address', track: 'minmax(120px,170px)' },
  { id: 'ra_renewal_date', label: 'Registered agent renewal date', short: 'Agent renewal', group: 'Identity and address', track: '104px' },
  { id: 'annual_report_due_date', label: 'Annual report due date', short: 'Annual report', group: 'Identity and address', track: '104px' },
  { id: 'contact', label: 'Main contact', short: 'Contact', group: 'People and source', track: 'minmax(110px,180px)' },
  { id: 'contact_email', label: 'Contact email', group: 'People and source', track: 'minmax(150px,220px)' },
  { id: 'lead_source', label: 'Lead source', group: 'People and source', track: '104px' },
  { id: 'referrer', label: 'Referrer', group: 'People and source', track: '110px' },
  { id: 'portal_stage', label: 'Portal stage', group: 'Portal', track: '96px' },
  { id: 'overdue', label: 'Overdue invoices', short: 'Overdue', group: 'Money', track: '72px', tail: true },
]

/** What a list shows until the person chooses: exactly what the lists showed before the dropdown existed. */
const DEFAULTS: Record<ListId, readonly string[]> = {
  contacts: ['email', 'citizenship', 'portal_stage'],
  accounts: ['contact', 'type', 'status', 'state_of_formation', 'overdue'],
}

export function columnDefs(list: ListId): readonly ColumnDef[] {
  return list === 'contacts' ? CONTACT_COLUMNS : ACCOUNT_COLUMNS
}

export function defaultColumns(list: ListId): string[] {
  return [...DEFAULTS[list]]
}

/** Key under which a person's choice is kept in their saved preferences. */
export function columnPrefKey(list: ListId): string {
  return `crm.columns.${list}`
}

/**
 * Check a list of field ids: only known ids, each once, always in the dropdown's own order (not the order they were ticked).
 * Returns the cleaned list (it may be empty: "no extra fields" is a valid choice).
 */
export function cleanColumns(list: ListId, ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const wanted = new Set(ids.filter((x): x is string => typeof x === 'string'))
  return columnDefs(list)
    .map((c) => c.id)
    .filter((id) => wanted.has(id))
}

/** A stored preference -> the saved list, or null when nothing valid is saved (the person then gets the standard set). */
export function parseColumnPref(list: ListId, raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object') return null
  const cols = (raw as { cols?: unknown }).cols
  if (!Array.isArray(cols)) return null
  return cleanColumns(list, cols)
}

export function resolveColumns(list: ListId, saved: string[] | null | undefined): string[] {
  return saved ? cleanColumns(list, saved) : defaultColumns(list)
}

/** The chosen fields that take a column of their own (a flag does not), split into the ones before and after the money columns. */
export function chosenColumns(list: ListId, selected: string[]): { before: ColumnDef[]; tail: ColumnDef[] } {
  const defs = columnDefs(list).filter((c) => selected.includes(c.id) && !c.flag)
  return { before: defs.filter((c) => !c.tail), tail: defs.filter((c) => c.tail) }
}

export function hasColumn(selected: string[], id: string): boolean {
  return selected.includes(id)
}

/** Width of the people column and of the money columns on a wide window. */
const CONTACT_NAME_TRACK = 'minmax(180px,260px)'
const CONTACT_COMPANIES_TRACK = 'minmax(520px,1fr)'
const ACCOUNT_NAME_TRACK = 'minmax(180px,1fr)'
const MONEY_TRACK = '132px'
const PER_YEAR_TRACK = '84px'

/** The CSS grid columns for a wide window, built from the chosen fields. */
export function gridTemplate(list: ListId, selected: string[]): string {
  const { before, tail } = chosenColumns(list, selected)
  if (list === 'contacts') {
    return [CONTACT_NAME_TRACK, ...before.map((c) => c.track), CONTACT_COMPANIES_TRACK].join(' ')
  }
  return [ACCOUNT_NAME_TRACK, ...before.map((c) => c.track), MONEY_TRACK, MONEY_TRACK, PER_YEAR_TRACK, ...tail.map((c) => c.track)].join(' ')
}

/** The space between wide-window columns, in pixels (matches `md:gap-2.5` in the tables). */
const COLUMN_GAP = 10

/** The smallest a track can be, in pixels ("minmax(150px,230px)" -> 150, "130px" -> 130, "1fr" -> 0). */
function trackMin(track: string): number {
  const m = /^(?:minmax\()?(\d+(?:\.\d+)?)px/.exec(track)
  return m ? Number(m[1]) : 0
}

/**
 * The narrowest width the wide layout needs, so the list scrolls sideways (with a scrollbar) ONLY when the chosen fields really do not
 * fit, instead of cutting columns off. Counts the row padding (2 x 16px) and the gap between columns (10px).
 */
export function gridMinWidth(list: ListId, selected: string[]): number {
  const tracks = gridTemplate(list, selected).split(' ')
  const widths = tracks.reduce((sum, t) => sum + trackMin(t), 0)
  return Math.ceil(widths + (tracks.length - 1) * COLUMN_GAP + 32)
}
