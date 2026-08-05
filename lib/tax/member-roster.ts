/**
 * WHERE THE MEMBER LIST COMES FROM. One reader, used by every categorisation
 * path, so they cannot disagree (see lib/tax/member-names.ts for why any
 * disagreement becomes a permanent flip-flop rather than a one-off difference).
 *
 * TWO SOURCES, UNIONED — and the union is the whole point (Antonio, 2026-08-04:
 * "we have the members written in the crm").
 *
 *  1. THE CURATED MEMBERS LIST (`members`). Real full names with ownership
 *     percentages, entered by the client or staff. Where it exists it is the
 *     better source: verified names, and company members ("F.INVEST LLC holds
 *     40%") that the contact links do not carry at all.
 *
 *  2. THE LINKED CONTACTS (`account_contacts`). Kept as a FALLBACK, not
 *     replaced — switching wholesale was the first plan and it was wrong twice:
 *
 *     - COVERAGE. The curated list is written for multi-member LLCs; 47 of 330
 *       accounts have one, 283 have none (production, 2026-08-04). A
 *       single-owner company's owner exists only as a linked contact. Dropping
 *       that source turns their every draw into a deducted business expense —
 *       invisibly, because nothing tells you a roster was empty.
 *     - HISTORY. The curated list is CURRENT state with no dates: the
 *       client-facing form DELETES every row for the account and re-inserts the
 *       new set. A member who left mid-year vanishes from it (Titan 2025: one
 *       member left in June, another joined in July). Contact links are never
 *       unlinked, so they retain the people a tax year still needs. Categorising
 *       a year off a roster that only knows today would flip that member's
 *       first-half draws to expenses on the next sweep.
 *
 * A name present in only one source is still a member. Over-including costs a
 * visible, correctable review card; under-including costs a silent deduction on
 * a filed return. The risk is asymmetric, so this favours recall.
 *
 * WHAT PROTECTS THE UNION from the extra names: `isUsableMemberName` — a real
 * first AND last name, never a blank. Ten linked contacts across six companies
 * with bank data have no name at all; without that guard one of them matches
 * every row of the year. See member-names.ts.
 */
import { buildMemberNames, filterMemberNames, dedupeMemberNames, isUsableMemberName } from "./member-names"

/** Minimal client shape — DI'd so unit tests stay database-free. */
export interface RosterDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any
}

export interface MemberRoster {
  /** Names safe to auto-book owner draws / contributions against. */
  names: string[]
  /** Curated rows found (diagnostics — a zero here with names>0 means fallback only). */
  fromMembers: number
  /** Linked-contact names that cleared the bar. */
  fromContacts: number
  /**
   * Linked people with NO usable name — blank records, almost always. Surfaced
   * rather than swallowed: it is a CRM data defect that silently weakens owner
   * detection for that company, and nothing else in the system reports it.
   */
  unusable: number
}

interface MemberRow {
  full_name: string | null
  company_name: string | null
  member_type: string | null
}

interface ContactLink {
  contacts: { first_name: string | null; last_name: string | null } | null
}

/**
 * Build the member roster for an account. Curated list first, linked contacts
 * appended, duplicates folded by normalised name.
 *
 * AN EMPTY SOURCE IS NORMAL; A FAILED SOURCE IS NOT. A company with no curated
 * members is the ordinary case (283 of 330 accounts), so one empty read is fine
 * and the other source carries the roster. But if BOTH reads fail this THROWS,
 * because an empty roster produced by an outage is indistinguishable from
 * "this company genuinely has no owners on file" — and that second reading is
 * acted on: every owner draw for the year books as a deducted business expense,
 * silently, on a return somebody then signs. Failing the run is recoverable;
 * quietly filing wrong numbers is not. Same posture as the categorisation-rules
 * read, which also refuses to continue without its data.
 *
 * NOTE ON ERROR SHAPE: supabase-js RESOLVES with `{ data: null, error }` rather
 * than rejecting, so `data ?? []` is what actually handles a failure — a bare
 * try/catch here would be dead code and would have logged nothing.
 */
export async function fetchMemberRoster(db: RosterDb, accountId: string): Promise<MemberRoster> {
  const [members, contacts] = await Promise.all([
    (async () => {
      try {
        const { data, error } = await db.from("members").select("full_name, company_name, member_type").eq("account_id", accountId)
        return { rows: (data ?? []) as MemberRow[], error: error ?? null }
      } catch (e) {
        return { rows: [] as MemberRow[], error: e }
      }
    })(),
    (async () => {
      try {
        const { data, error } = await db.from("account_contacts").select("contacts(first_name, last_name)").eq("account_id", accountId)
        return { rows: (data ?? []) as unknown as ContactLink[], error: error ?? null }
      } catch (e) {
        return { rows: [] as ContactLink[], error: e }
      }
    })(),
  ])

  if (members.error && contacts.error) {
    throw new Error(
      `member roster unavailable for account ${accountId} — refusing to categorise with no owners: ` +
      `${String((members.error as { message?: string })?.message ?? members.error)}`,
    )
  }
  // One source down is survivable, but never in silence: the roster is now
  // narrower than the truth and some owner draws will book as expenses.
  if (members.error) console.warn(`[member-roster] account ${accountId}: curated members read FAILED, using linked contacts only`)
  if (contacts.error) console.warn(`[member-roster] account ${accountId}: linked contacts read FAILED, using curated members only`)

  const memberRows = members.rows
  const contactRows = contacts.rows

  // A company member carries its name in company_name and has no full_name;
  // a person carries full_name. Take whichever is present rather than trusting
  // member_type, which is free-ish text and not what identifies the payee.
  const curated = filterMemberNames(memberRows.map(m => m.full_name || m.company_name))

  const contactNames = buildMemberNames(contactRows.map(l => l.contacts))

  // Every record on EITHER source that cannot produce a usable name. Counted
  // before dedupe so the number means "records needing a fix", not "names
  // lost". The curated side is counted too: a members row whose name is a
  // single word (a one-word trading name) is dropped exactly like a blank
  // contact, and counting only contacts made that drop invisible.
  const unusable =
    contactRows.filter(l => {
      const c = l.contacts
      return !isUsableMemberName(`${c?.first_name ?? ""} ${c?.last_name ?? ""}`.trim())
    }).length +
    memberRows.filter(m => !isUsableMemberName(m.full_name || m.company_name)).length

  const names = dedupeMemberNames([...curated, ...contactNames])

  // SAY SOMETHING. Both of these weaken owner detection for a real company, and
  // both are invisible otherwise — the categoriser just quietly books fewer
  // draws, and an owner withdrawal deducted as a business cost is the error
  // nobody notices until the return is filed. A blank contact record is a CRM
  // data defect somebody can fix in a minute, once they know it exists.
  if (unusable > 0) {
    console.warn(
      `[member-roster] account ${accountId}: ${unusable} member/contact record(s) have no usable name ` +
      `(blank, or a single word) — owner draws to them cannot be detected. Fix the record.`,
    )
    // REPORTED, not just logged. A console line in a serverless function is not
    // a signal anybody receives, and this failure is silent by construction:
    // that member's draws simply book as business costs and every gate stays
    // green. Ten such records exist on production today.
    void reportRosterProblem(accountId, `${unusable} member/contact record(s) have no usable name — owner draws to them cannot be detected`, { unusable })
  }
  if (members.error || contacts.error) {
    // One source down means a NARROWER roster than the truth, which is the
    // silently-wrong direction. It survived as a console line only.
    void reportRosterProblem(accountId, `member roster read partially failed — the roster is narrower than the truth, some owner draws will book as expenses`, {
      members_error: String((members.error as { message?: string })?.message ?? members.error ?? ""),
      contacts_error: String((contacts.error as { message?: string })?.message ?? contacts.error ?? ""),
    })
  }
  if (names.length === 0) {
    console.warn(
      `[member-roster] account ${accountId}: NO members and NO usable linked contacts. ` +
      `Every owner draw will be treated as a business expense until somebody is on file.`,
    )
    // REPORT IT WHERE A HUMAN LOOKS. A console line in a serverless log is not
    // a signal anybody receives; this is the one failure the whole owner-roster
    // design creates, and it is silent by construction — the categoriser simply
    // books every draw as a business cost and every gate stays green.
    //
    // Reported, NOT thrown: an empty roster is a legitimate state for a brand
    // new company, and 283 of 330 accounts have no curated members at all, so
    // throwing here would fail the client's own statement upload for a data gap
    // that is ours to fix, not theirs.
    void reportRosterProblem(accountId, "No usable owner names on file — owner draws will be booked as business expenses", { unusable })
  }

  return { names, fromMembers: curated.length, fromContacts: contactNames.length, unusable }
}

/**
 * One reporting path for every way the roster can be quietly wrong.
 *
 * Fire-and-forget by design: a reporting failure must never break a client's
 * statement upload. But it must REACH somebody — every failure mode here is
 * invisible otherwise, because a narrower roster just books fewer owner draws
 * and no gate can tell the difference.
 */
function reportRosterProblem(accountId: string, message: string, context: Record<string, unknown>): void {
  void import("@/lib/system-errors")
    .then(({ reportSystemError }) => reportSystemError({
      source: "server",
      // The account id lives in the ROUTE, deliberately. The dedup fingerprint
      // normalizes UUIDs out of the MESSAGE but uses the route verbatim — with
      // a bare route, three different companies' roster problems merged into
      // ONE feed entry pinned to whichever company was reported first, so staff
      // fixed that company and the entry kept re-occurring under the fixed
      // company's name for ever. Per-account routes give each company its own
      // entry and its own resolve lifecycle.
      route: `lib/tax/member-roster:${accountId}`,
      message: `${message} (account ${accountId})`,
      context: { account_id: accountId, ...context },
    }))
    .catch(() => {})
}
