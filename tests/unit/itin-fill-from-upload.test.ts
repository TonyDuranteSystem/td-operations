import { describe, it, expect, vi } from "vitest"
import { decideItinFill, fillItinFromLetterText, type FillDeps, type FillPerson } from "@/lib/itin/fill-from-upload"

/**
 * The Storage upload's automatic ITIN fill-in, made careful (lib/itin/fill-from-upload.ts; dev job fb49265a, Antonio 2026-11-10).
 * MADE-UP letters and people (no real person, no real number), in the shape of the real IRS CP565A notice. What is proved: the letter must
 * name THIS person, the date of birth must not contradict, no other contact may hold the ITIN, a different value on the record is kept,
 * an unclear read is never written, and today's date is never guessed.
 */
const NOW = new Date("2026-11-10T12:00:00Z")

const JANE_LETTER = `
Department of the Treasury
IRS Notice CP565A
Internal Revenue Service
PO Box 149342
Case Reference Number: 20294-245-01413-5
Date of Birth: March 3,1990
Austin, TX 78714-9342

006197.598014.192215.18852
JANE SAMPLE
14 HUGHES STE B200
IRVINE CA 92618

October 7, 2025

You've been assigned an Individual Taxpayer Identification Number (ITIN)
This notice confirms your assigned ITIN 900-70-1234. Review your ITIN and personal information in the table below.
Your ITIN and personal information
(TIN
900-70-1234
Full name {First, Middle, Last)
JANE, SAMPLE
Date of Birth
March 3, 1990
`

/** the same letter with the notice date line removed: no clear issue date anywhere */
const JANE_NO_DATE = JANE_LETTER.replace("October 7, 2025\n", "")
/** the ITIN printed only once, with no label: a read a person must check — never written by itself */
const JANE_ONCE = JANE_LETTER.replace("This notice confirms your assigned ITIN 900-70-1234. Review your ITIN and personal information in the table below.", "Review your personal information in the table below.")

const jane = (over: Partial<FillPerson> = {}): FillPerson => ({ fullName: "Jane Sample", dateOfBirth: null, itin: null, issueDate: null, ...over })
const fill = (text: string, person: FillPerson, holder: string | null | "error" = null) => decideItinFill({ text, person, holder, now: NOW })

describe("decideItinFill — the letter is Jane's and everything is clear", () => {
  it("fills the ITIN and the clearly read notice date on an empty record", () => {
    const d = fill(JANE_LETTER, jane())
    expect(d.writeItin).toBe("900-70-1234")
    expect(d.writeDate).toBe("2025-10-07")
    expect(d.level).toBe("ok")
    expect(d.message).toContain("filled in on Jane Sample's record")
  })
  it("agrees with a date of birth the record already holds", () => {
    expect(fill(JANE_LETTER, jane({ dateOfBirth: "1990-03-03" })).writeItin).toBe("900-70-1234")
  })
  it("fills only the missing date when the record already has this very ITIN", () => {
    const d = fill(JANE_LETTER, jane({ itin: "900-70-1234" }))
    expect(d.writeItin).toBeNull()
    expect(d.writeDate).toBe("2025-10-07")
  })
  it("says 'nothing to change' when the record already has this ITIN and this date", () => {
    const d = fill(JANE_LETTER, jane({ itin: "900-70-1234", issueDate: "2025-10-07" }))
    expect(d).toMatchObject({ writeItin: null, writeDate: null, level: "ok" })
    expect(d.message).toContain("nothing to change")
  })
})

describe("decideItinFill — whose letter is it", () => {
  it("never fills somebody else's record (the letter names another person)", () => {
    const d = fill(JANE_LETTER, jane({ fullName: "John Example" }))
    expect(d).toMatchObject({ writeItin: null, writeDate: null, level: "warn" })
    expect(d.message).toContain("does not name John Example")
    expect(d.message).toContain("record was not filled")
  })
  it("a person with no usable name cannot be matched, so nothing is written", () => {
    expect(fill(JANE_LETTER, jane({ fullName: null })).writeItin).toBeNull()
    expect(fill(JANE_LETTER, jane({ fullName: "Jane" })).writeItin).toBeNull()
  })
  it("a date of birth that differs from the record's stops it, even when the name matches", () => {
    const d = fill(JANE_LETTER, jane({ dateOfBirth: "1991-01-01" }))
    expect(d.writeItin).toBeNull()
    expect(d.message).toContain("date of birth on the letter is not the one")
  })
  it("another contact already holds this ITIN: nothing is written and that contact is named", () => {
    const d = fill(JANE_LETTER, jane(), "Jane Sample (older record)")
    expect(d.writeItin).toBeNull()
    expect(d.message).toContain("already on Jane Sample (older record)'s record")
  })
  it("when the holder check fails, nothing is written (never 'nobody holds it')", () => {
    const d = fill(JANE_LETTER, jane(), "error")
    expect(d.writeItin).toBeNull()
    expect(d.message).toContain("could not be checked")
  })
})

describe("decideItinFill — never over what the record holds, never a guess", () => {
  it("a DIFFERENT ITIN already on the record is kept", () => {
    const d = fill(JANE_LETTER, jane({ itin: "901-54-5678" }))
    expect(d).toMatchObject({ writeItin: null, writeDate: null, level: "warn" })
    expect(d.message).toContain("different ITIN")
    expect(d.message).toContain("kept")
  })
  it("a different issue date on the record (same ITIN) is kept", () => {
    const d = fill(JANE_LETTER, jane({ itin: "900-70-1234", issueDate: "2024-01-15" }))
    expect(d.writeDate).toBeNull()
    expect(d.message).toContain("issue date")
  })
  it("no clear notice date: the ITIN is filled, the date is NOT (never today's date)", () => {
    const d = fill(JANE_NO_DATE, jane())
    expect(d.writeItin).toBe("900-70-1234")
    expect(d.writeDate).toBeNull()
    expect(d.level).toBe("warn")
    expect(d.message).toContain("No clear issue date")
  })
  it("an ITIN read only once (unsure) is never written", () => {
    const d = fill(JANE_ONCE, jane())
    expect(d).toMatchObject({ writeItin: null, writeDate: null, level: "warn" })
    expect(d.message).toContain("could not be read clearly")
  })
  it("a file that is not an IRS ITIN notice writes nothing", () => {
    const d = fill("Invoice 123\nTotal due 100.00\nThank you", jane())
    expect(d).toMatchObject({ writeItin: null, writeDate: null, level: "warn" })
    expect(d.message).toContain("does not look like an IRS ITIN notice")
  })
})

function deps(over: Partial<FillDeps> = {}) {
  const write = vi.fn(async () => ({}))
  const findHolder = vi.fn(async () => null as string | null | "error")
  const d: FillDeps = { loadPerson: async () => jane(), findHolder, write, ...over }
  return { d, write, findHolder }
}

describe("fillItinFromLetterText — what is read, asked and written", () => {
  it("writes exactly the decided fields", async () => {
    const { d, write } = deps()
    const r = await fillItinFromLetterText("contact-1", JANE_LETTER, d, NOW)
    expect(r.level).toBe("ok")
    expect(write).toHaveBeenCalledWith("contact-1", { itin_number: "900-70-1234", itin_issue_date: "2025-10-07" })
  })
  it("writes only the ITIN when no date was clear — the date key is not even sent", async () => {
    const { d, write } = deps()
    await fillItinFromLetterText("contact-1", JANE_NO_DATE, d, NOW)
    expect(write).toHaveBeenCalledWith("contact-1", { itin_number: "900-70-1234" })
  })
  it("writes nothing for somebody else's letter, and does not even look for a holder when there is no clear ITIN", async () => {
    const wrong = deps({ loadPerson: async () => jane({ fullName: "John Example" }) })
    expect((await fillItinFromLetterText("c", JANE_LETTER, wrong.d, NOW)).level).toBe("warn")
    expect(wrong.write).not.toHaveBeenCalled()
    const unclear = deps()
    await fillItinFromLetterText("c", JANE_ONCE, unclear.d, NOW)
    expect(unclear.findHolder).not.toHaveBeenCalled()
    expect(unclear.write).not.toHaveBeenCalled()
  })
  it("asks the holder check with the clear ITIN and this contact's id", async () => {
    const { d, findHolder } = deps()
    await fillItinFromLetterText("contact-9", JANE_LETTER, d, NOW)
    expect(findHolder).toHaveBeenCalledWith("900-70-1234", "contact-9")
  })
  it("says so when the record cannot be read, or the write fails — never throws, the file stays saved", async () => {
    const noPerson = deps({ loadPerson: async () => null })
    expect((await fillItinFromLetterText("c", JANE_LETTER, noPerson.d, NOW)).message).toContain("record could not be read")
    expect(noPerson.write).not.toHaveBeenCalled()
    const failing = deps({ write: vi.fn(async () => { throw new Error("db down") }) })
    const r = await fillItinFromLetterText("c", JANE_LETTER, failing.d, NOW)
    expect(r.level).toBe("warn")
    expect(r.message).toContain("could not be filled (db down)")
    const exploding = deps({ loadPerson: async () => { throw new Error("boom") } })
    expect((await fillItinFromLetterText("c", JANE_LETTER, exploding.d, NOW)).message).toContain("could not be read (boom)")
  })
})
