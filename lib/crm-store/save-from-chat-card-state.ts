/**
 * The "Save to Storage" card's per-file form and the rules that say when a file may be saved (dev job fb49265a). PURE — no React, no network —
 * so the rules are unit-tested; the card (components/portal-chats/save-to-storage-card.tsx) only draws them. The server re-checks all of it.
 */
import { checkIssueDate, isValidItin } from "@/lib/itin/read-itin-letter"
import { fileNameHasTaxNumber, type CardCandidate, type CardItem, type ClientChoice } from "./save-from-chat-rules"

export interface Form {
  include: boolean
  contactId: string
  fileName: string
  fileNameTouched: boolean
  itin: string
  issueDate: string
  client: ClientChoice
  replaceItin: boolean
  itinChecked: boolean
  dateChecked: boolean
  ownerChecked: boolean
  /** "I checked": the ITIN is on another contact's record but really is this person's (a duplicate contact) — asked only after the server said so */
  holderChecked: boolean
  showText: boolean
}

/**
 * The date of birth the reader saw on the letter — but only when it read it CLEARLY. An unsure one (the reader takes "the earlier date" for it)
 * could be the real notice date, and must never be a hard stop on the date staff typed from the scan.
 */
export function trustedLetterDateOfBirth(item: CardItem): string | null {
  return item.dateOfBirth?.status === "ok" ? item.dateOfBirth.value ?? null : null
}

export const normDigits = (s: string): string => s.replace(/\D/g, "")

export function initialForm(item: CardItem): Form {
  // already saved FOR THE PROPOSED PERSON → not ticked again by default (the key includes the person)
  const proposed = item.candidates.find((c) => c.contactId === item.proposedContactId)
  const readable = item.readable && !proposed?.alreadySaved
  return {
    include: readable && item.recognized,
    contactId: item.proposedContactId ?? "",
    fileName: item.proposedFileName,
    fileNameTouched: false,
    itin: item.itin?.value ?? "",
    issueDate: item.noticeDate?.value ?? "",
    client: "hidden",
    replaceItin: false,
    itinChecked: false,
    dateChecked: false,
    ownerChecked: false,
    holderChecked: false,
    showText: false,
  }
}

export function candidateOf(item: CardItem, form: Form): CardCandidate | undefined {
  return item.candidates.find((c) => c.contactId === form.contactId)
}

/** Why this file cannot be saved yet, in plain words (empty = it can). */
export function blockersFor(item: CardItem, form: Form): string[] {
  if (!form.include) return []
  const out: string[] = []
  const cand = candidateOf(item, form)
  if (!cand) out.push("Choose whose letter this is.")
  else {
    if (cand.waiting === null) out.push("Could not check whether an ITIN case is waiting for this letter — close the card and open it again.")
    else if (cand.waiting.length > 0) out.push(`${cand.waiting[0].who}'s ${cand.waiting[0].serviceType} case is at "${cand.waiting[0].stage}" and is waiting for this letter — use the workspace (it closes the case and tells the client).`)
    if (!cand.namedInLetter && !form.ownerChecked) out.push(`The letter does not name ${cand.name} — tick that you checked it is theirs.`)
  }
  const itin = form.itin.trim()
  if (itin && !isValidItin(itin)) out.push("The ITIN is not valid — it must look like 9XX-XX-XXXX with a valid middle (50–65, 70–88, 90–92, 94–99).")
  if (form.issueDate && !itin) out.push("Enter the ITIN together with its date, or clear the date.")
  if (form.issueDate) {
    // against the date of birth the READER saw on this letter, when it read it clearly (the server also checks the one the CRM holds)
    const d = checkIssueDate(form.issueDate, { dateOfBirth: trustedLetterDateOfBirth(item) })
    if (!d.ok) out.push(`Notice date: ${d.reason}`)
  }
  if (itin && item.itin?.status === "unsure" && item.itin.value === itin && !form.itinChecked) out.push("Tick that you checked the ITIN against the scan.")
  if (form.issueDate && item.noticeDate?.status === "unsure" && item.noticeDate.value === form.issueDate && !form.dateChecked) out.push("Tick that you checked the notice date against the scan.")
  if (fileNameHasTaxNumber(form.fileName)) out.push("The file name must not contain the ITIN or any tax number.")
  return out
}

/**
 * Rules that look at SEVERAL ticked files together: two files set for the same person must not carry two different ITINs (one record, one ITIN).
 */
export function crossItemBlockers(items: CardItem[], forms: Record<number, Form>): string[] {
  const byPerson: Record<string, Array<{ item: CardItem; form: Form }>> = {}
  for (const it of items) {
    const f = forms[it.index]
    if (f && f.include && f.contactId) (byPerson[f.contactId] = byPerson[f.contactId] ?? []).push({ item: it, form: f })
  }
  const out: string[] = []
  for (const id of Object.keys(byPerson)) {
    const group = byPerson[id]
    if (group.length < 2) continue
    const itins = Array.from(new Set(group.map((g) => normDigits(g.form.itin)).filter(Boolean)))
    if (itins.length > 1) {
      const name = candidateOf(group[0].item, group[0].form)?.name ?? "this person"
      out.push(`${group.length} files are set for ${name} with different ITINs — one record can hold only one ITIN. Untick one file or choose the right person.`)
    }
  }
  // one ITIN, two different people: an ITIN belongs to one person, so one of the two letters is on the wrong person
  const owners: Record<string, string> = {}
  for (const it of items) {
    const f = forms[it.index]
    const digits = f ? normDigits(f.itin) : ""
    if (!f || !f.include || !f.contactId || !digits) continue
    const first = owners[digits]
    if (first === undefined) owners[digits] = f.contactId
    else if (first !== f.contactId) {
      out.push("Two different people are set to receive the same ITIN — an ITIN belongs to one person. Check whose letter each file is.")
      break
    }
  }
  return out
}
