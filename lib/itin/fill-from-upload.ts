/**
 * The Storage upload's automatic fill-in of a person's ITIN, made careful (dev job fb49265a; Antonio 2026-11-10: "fix at the source").
 *
 * Before this, saving a file typed "ITIN Letter" into a PERSON's storage read the file with the old reader and wrote the ITIN — and today's
 * date when no date was found — onto that person's record, never asking whose letter it was (the chat pop-up made that easy to hit: one chat
 * message can hold several people's letters). Now the SAME careful reader and rules the chat ITIN card uses decide:
 *  - the file must really be an IRS ITIN notice, and the ITIN must be read CLEARLY (an "unsure" read is never written: nobody is there to check it);
 *  - the letter must NAME this person (first and last word of the name) and its date of birth must not contradict the record's;
 *  - no other contact may already hold this ITIN;
 *  - a DIFFERENT ITIN already on the record is never replaced (and a different issue date is never replaced) — `decideItinWrite`, replace = false;
 *  - the issue date is written only when it was read clearly and makes sense — NEVER today's date;
 *  - in every "no" case the FILE stays saved; only the record is left alone, and the message says why in plain words.
 * `decideItinFill` is pure (unit-tested); `fillItinFromLetterText` adds the database reads/writes.
 */
import { checkIssueDate, formatItin, isValidItin, readItinLetter } from "./read-itin-letter"
import { candidateNamedIn, dateOfBirthContradicts, decideItinWrite } from "@/lib/crm-store/save-from-chat-rules"

export interface FillPerson {
  fullName: string | null
  dateOfBirth: string | null
  itin: string | null
  issueDate: string | null
}

export interface FillDecision {
  /** the ITIN to write on the record (formatted), or null */
  writeItin: string | null
  /** the issue date to write (yyyy-mm-dd), or null */
  writeDate: string | null
  /** "ok" = what staff expected happened; "warn" = the file is saved but the record was NOT (fully) filled — staff must look */
  level: "ok" | "warn"
  /** plain words for the toast */
  message: string
}

const NOT_FILLED = "so the record was not filled"

/**
 * Judge ONE letter's text against ONE person's record. Pure.
 * `holder`: the name of another contact that already holds this ITIN, null when nobody does, "error" when that could not be checked.
 */
export function decideItinFill(input: { text: string; person: FillPerson; holder: string | null | "error"; now?: Date }): FillDecision {
  const { text, person } = input
  const who = person.fullName?.trim() || "this person"
  const none = (message: string): FillDecision => ({ writeItin: null, writeDate: null, level: "warn", message })

  const reading = readItinLetter(text, input.now)
  if (!reading.isItinNotice) return none(`ITIN letter saved — it does not look like an IRS ITIN notice, ${NOT_FILLED}. Enter the ITIN on the contact if it is one.`)
  const itin = reading.itin.status === "ok" ? formatItin(reading.itin.value) : null
  if (!itin || !isValidItin(itin)) {
    return none(`ITIN letter saved — the ITIN could not be read clearly from the scan, ${NOT_FILLED}. Use the ITIN reader in Portal Chats, or enter it on the contact.`)
  }

  // whose letter is it: the letter must name this person, and its date of birth must not contradict the record's
  const letterDob = reading.dateOfBirth.value
  if (dateOfBirthContradicts(person.dateOfBirth, letterDob)) {
    return none(`ITIN letter saved — the date of birth on the letter is not the one on ${who}'s record, ${NOT_FILLED}. Check whose letter this is.`)
  }
  if (!candidateNamedIn(text, { contactId: "", name: person.fullName ?? "", dateOfBirth: person.dateOfBirth }, letterDob)) {
    return none(`ITIN letter saved — the letter does not name ${who}, ${NOT_FILLED}. Check whose letter this is (the ITIN reader in Portal Chats checks it and fills the record after you confirm).`)
  }

  if (input.holder === "error") return none(`ITIN letter saved — it could not be checked whether another contact already holds this ITIN, ${NOT_FILLED}. Try again, or use the ITIN reader.`)
  if (input.holder) return none(`ITIN letter saved — this ITIN is already on ${input.holder}'s record, ${NOT_FILLED}. Check whose letter this is.`)

  // the issue date: only when it was read clearly and is sensible; never today's date, never a guess
  let newDate: string | null = null
  if (reading.noticeDate.status === "ok" && reading.noticeDate.value) {
    const a = checkIssueDate(reading.noticeDate.value, { dateOfBirth: person.dateOfBirth, now: input.now })
    const b = checkIssueDate(reading.noticeDate.value, { dateOfBirth: letterDob, now: input.now })
    if (a.ok && b.ok) newDate = reading.noticeDate.value
  }

  // never over what the record holds (replace = false): a different ITIN or issue date is KEPT
  const d = decideItinWrite({ existingItin: person.itin, existingIssueDate: person.issueDate, newItin: itin, newDate, replace: false })
  if (!d.writeItin && !d.writeDate) {
    if (d.kept) return none(`ITIN letter saved — ${who}'s record already holds a different ${person.itin && person.itin.replace(/\D/g, "") !== itin.replace(/\D/g, "") ? "ITIN" : "issue date"}, which was kept. Use the ITIN reader in Portal Chats if it must be replaced.`)
    return { writeItin: null, writeDate: null, level: "ok", message: `ITIN letter saved — ${who}'s record already has this ITIN, nothing to change.` }
  }
  const parts = [d.writeItin ? "ITIN" : null, d.writeDate ? "issue date" : null].filter(Boolean).join(" and ")
  const dateNote = newDate ? "" : " No clear issue date was found on the letter, so none was written — enter it on the contact."
  const keptNote = d.kept && d.note ? ` ${d.note}` : ""
  return {
    writeItin: d.writeItin ? itin : null,
    writeDate: d.writeDate ? newDate : null,
    level: d.kept || !newDate ? "warn" : "ok",
    message: `ITIN letter saved — ${parts} filled in on ${who}'s record.${dateNote}${keptNote}`,
  }
}

// ───────────────────────────── the part that touches the database ─────────────────────────────

export interface FillDeps {
  loadPerson: (contactId: string) => Promise<FillPerson | null>
  findHolder: (itin: string, contactId: string) => Promise<string | null | "error">
  write: (contactId: string, fields: { itin_number?: string; itin_issue_date?: string }) => Promise<unknown>
}

async function defaultDeps(): Promise<FillDeps> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { otherHolderOfItin } = await import("./itin-holder")
  const { writeITINFields } = await import("./write-itin-fields")
  return {
    loadPerson: async (contactId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- contacts select is loose here
      const { data, error } = await (supabaseAdmin as any).from("contacts").select("full_name, date_of_birth, itin_number, itin_issue_date").eq("id", contactId).maybeSingle()
      if (error || !data) return null
      return { fullName: data.full_name ?? null, dateOfBirth: data.date_of_birth ?? null, itin: data.itin_number ?? null, issueDate: data.itin_issue_date ?? null }
    },
    findHolder: otherHolderOfItin,
    write: writeITINFields,
  }
}

/** Read one letter's text against the person's record and write only what is safe. Never throws: the message always says what happened. */
export async function fillItinFromLetterText(contactId: string, text: string, deps?: FillDeps, now?: Date): Promise<{ message: string; level: "ok" | "warn" }> {
  try {
    const d = deps ?? (await defaultDeps())
    const person = await d.loadPerson(contactId)
    if (!person) return { level: "warn", message: `ITIN letter saved — the person's record could not be read, ${NOT_FILLED}. Enter the ITIN on the contact.` }
    // the holder is only asked about when the letter really carries a clear ITIN
    const reading = readItinLetter(text, now)
    const itin = reading.isItinNotice && reading.itin.status === "ok" ? formatItin(reading.itin.value) : null
    const holder = itin && isValidItin(itin) ? await d.findHolder(itin, contactId) : null
    const decision = decideItinFill({ text, person, holder, now })
    if (decision.writeItin || decision.writeDate) {
      try {
        await d.write(contactId, {
          ...(decision.writeItin ? { itin_number: decision.writeItin } : {}),
          ...(decision.writeDate ? { itin_issue_date: decision.writeDate } : {}),
        })
      } catch (e) {
        return { level: "warn", message: `ITIN letter saved, but the record could not be filled (${e instanceof Error ? e.message : "error"}) — enter the ITIN on the contact.` }
      }
    }
    return { level: decision.level, message: decision.message }
  } catch (e) {
    return { level: "warn", message: `ITIN letter saved, but it could not be read (${e instanceof Error ? e.message : String(e)}) — ${NOT_FILLED}.` }
  }
}
