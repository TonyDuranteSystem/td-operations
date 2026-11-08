import { describe, it, expect } from "vitest"
import { readItinLetter, isValidItin, formatItin, isValidItinMiddle, checkIssueDate, personNamedInText, namesCouldBeSamePerson, nameWords } from "@/lib/itin/read-itin-letter"

// MADE-UP letters (no real person, no real number). They copy the SHAPE and the scan noise of two real IRS notices:
//  - "CP565A": loose notice-date line (no label), "Date of Birth:" at the top right, the date of birth printed again in the table;
//  - "CP565" : a header box that prints the labels first and the values later, then "We assigned you … (ITIN)".
// Scan noise seen on the real files: "October 1. 2025" (period for comma), "December 10,2025" (no space), "(TIN" for "ITIN", "PAPiK".
const NOW = new Date("2026-11-07T12:00:00Z")

const CP565A = `
Department of the Treasury
IRS Notice CP565A
Internal Revenue Service
PO Box 149342
Case Reference Number: 20294-245-01413-5
Date of Birth: March 3,1990
Austin, TX 78714-9342

006197.598014.192215.18852
JANE SAMPLEi
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

const CP565 = `
Department of the Treasury
Notice
CP565
Internal Revenue Service
Notice date
December 10, 2025
To contact us
Phone 800-908-9982
Austin, TX 78714-9342
International calls:
+1-267-941-1000
Case reference number 20294-261-06414-5
Date of birth
004806.618994.268658.20974
1 MB
0.672
June 9, 1985
Page 1 of 2
JOHN EXAMPLE
14 HUGHES STE B200
IRVINE CA 92618
We assigned you Individual Taxpayer Identification Number
(ITIN) 901-54-5678
This notice confirms your assigned
ITIN 901-54-5678.
Your ITIN and personal information
ITIN
901-54-5678
Full name
JOHN
Date of birth
June 9, 1985
Notice
CP565
Notice date
December 10, 2025
Page 2 of 2
`

describe("readItinLetter — the two known layouts, clean text", () => {
  it("CP565A: ITIN, notice date by elimination of the date of birth, kind and name", () => {
    const r = readItinLetter(CP565A, NOW)
    expect(r.isItinNotice).toBe(true)
    expect(r.noticeKind).toBe("CP565A")
    expect(r.itin).toMatchObject({ value: "900-70-1234", status: "ok" })
    expect(r.noticeDate).toMatchObject({ value: "2025-10-07", status: "ok" })
    expect(r.dateOfBirth).toMatchObject({ value: "1990-03-03" })
    expect(r.nameOnLetter).toBe("JANE SAMPLEi")
    expect(r.problems).toEqual([])
  })

  it("CP565: the labelled notice date wins; the date of birth printed apart from its label is still kept out", () => {
    const r = readItinLetter(CP565, NOW)
    expect(r.noticeKind).toBe("CP565")
    expect(r.itin).toMatchObject({ value: "901-54-5678", status: "ok" })
    expect(r.noticeDate).toMatchObject({ value: "2025-12-10", status: "ok" })
    expect(r.dateOfBirth.value).toBe("1985-06-09")
    expect(r.nameOnLetter).toBe("JOHN EXAMPLE")
  })
})

describe("readItinLetter — scan noise (what went wrong with the old reader)", () => {
  it("CP565A with the notice date misread as 'October 1. 2025': the date of birth is NEVER taken; the noisy date is offered as UNSURE", () => {
    const noisy = CP565A.replace("October 7, 2025", "October 1. 2025").replace("March 3,1990", "March 3,1990")
    const r = readItinLetter(noisy, NOW)
    expect(r.noticeDate.value).toBe("2025-10-01")
    expect(r.noticeDate.status).toBe("unsure")
    expect(r.noticeDate.note).toMatch(/garbled|scan/i)
    expect(r.noticeDate.value).not.toBe("1990-03-03")
    expect(r.problems.length).toBeGreaterThan(0)
  })

  it("CP565A whose notice date is not found at all: no date is offered — never the date of birth, never today", () => {
    const noDate = CP565A.replace("October 7, 2025", "")
    const r = readItinLetter(noDate, NOW)
    expect(r.noticeDate.value).toBeNull()
    expect(r.noticeDate.status).not.toBe("ok")
    expect(r.noticeDate.value).not.toBe("1990-03-03")
    expect(r.noticeDate.value).not.toBe("2026-11-07")
  })

  it("CP565 with 'December 10,2025' and 'December 10. 2025' on its two pages: they agree, so it is read as OK", () => {
    const noisy = CP565.replace("December 10, 2025\nTo contact us", "December 10,2025\nTo contact us").replace("Notice date\nDecember 10, 2025\nPage 2", "Notice date\nDecember 10. 2025\nPage 2")
    const r = readItinLetter(noisy, NOW)
    expect(r.noticeDate).toMatchObject({ value: "2025-12-10", status: "ok" })
  })

  it("a scanner that turned 'ITIN' into '(TIN' in the table does not matter — the number is read by its shape", () => {
    expect(readItinLetter(CP565A, NOW).itin.value).toBe("900-70-1234")
  })

  it("the labels read apart from their values (no label can be tied to a date): the later date is the notice date, marked UNSURE", () => {
    const loose = `IRS Notice CP565\nYou've been assigned an Individual Taxpayer Identification Number\nITIN 902-91-4321 and ITIN 902-91-4321\nJuly 4, 1992\nSeptember 2, 2025\nSEPTEMBER 2025`
    const r = readItinLetter(loose, NOW)
    expect(r.noticeDate).toMatchObject({ value: "2025-09-02", status: "unsure" })
    expect(r.dateOfBirth.value).toBe("1992-07-04")
  })

  it("a header box read as 'all the labels, then all the values' (what Document AI returns): both labels printed + exactly two clean dates → the later is the notice date, read OK", () => {
    const columns = `IRS\nNotice CP565\nNotice\nNotice date\nTo contact us\nCP565 December 10, 2025 Phone 800-908-9982\nCase reference number\nDate of birth\n20294-261-06414-5 June 9, 1985\nPage 1 of 2\nJOHN EXAMPLE\n14 HUGHES STE B200\nWe assigned you Individual Taxpayer Identification Number (ITIN) 901-54-5678\nThis notice confirms your assigned ITIN 901-54-5678.\nPage 2 of 2\nNotice\nNotice date\nPage 2 of 2\nCP565 December 10, 2025`
    const r = readItinLetter(columns, NOW)
    expect(r.noticeDate).toMatchObject({ value: "2025-12-10", status: "ok" })
    expect(r.dateOfBirth).toMatchObject({ value: "1985-06-09", status: "ok" })
  })

  it("the same, but one of the two dates is garbled: back to UNSURE", () => {
    const columns = `IRS Notice CP565\nNotice date\nDate of birth\nDecember 10,2025 June 9. 1985\nassigned ITIN 901-54-5678 901-54-5678`
    const r = readItinLetter(columns, NOW)
    expect(r.noticeDate.value).toBe("2025-12-10")
    expect(r.noticeDate.status).toBe("unsure")
  })

  it("three or more unlabelled dates: nothing is chosen", () => {
    const messy = `IRS Notice CP565\nassigned ITIN 902-91-4321 902-91-4321\nJuly 4, 1992\nSeptember 2, 2025\nAugust 9, 2024`
    const r = readItinLetter(messy, NOW)
    expect(r.noticeDate.value).toBeNull()
    expect(r.noticeDate.status).toBe("unsure")
    expect(r.noticeDate.others.length).toBe(3)
  })

  it("a date in the future is not accepted as OK", () => {
    const future = CP565.replace(/December 10, 2025/g, "December 10, 2031")
    const r = readItinLetter(future, NOW)
    expect(r.noticeDate.status).toBe("unsure")
    expect(r.noticeDate.note).toMatch(/future|wrong/i)
  })
})

describe("readItinLetter — the ITIN number", () => {
  it("ignores phone numbers, case numbers and ZIP+4 (none is an ITIN shape with a valid middle)", () => {
    const r = readItinLetter("IRS Notice CP565 assigned\nPhone 800-908-9982 International 1-267-941-1000\nCase 20294-245-01413-5 Austin TX 78714-9342\nITIN 900-70-1234 900-70-1234", NOW)
    expect(r.itin.value).toBe("900-70-1234")
  })

  it("two different ITIN-like numbers with the same count: UNSURE, the other one listed", () => {
    const r = readItinLetter("IRS Notice CP565 assigned ITIN 900-70-1234 and 901-54-5678", NOW)
    expect(r.itin.status).toBe("unsure")
    expect(r.itin.others.length).toBe(1)
  })

  it("a number that survived the scan only ONCE is UNSURE (it could be a misread digit); printed twice is OK", () => {
    expect(readItinLetter("IRS Notice CP565 assigned ITIN 900-70-1234", NOW).itin.status).toBe("unsure")
    expect(readItinLetter("IRS Notice CP565 assigned ITIN 900-70-1234 and 900-70-1234", NOW).itin.status).toBe("ok")
    expect(readItinLetter("IRS Notice CP565 assigned ITIN 900-70-1234 and also 901-54-5678 901-54-5678", NOW).itin.value).toBe("901-54-5678")
  })

  it("a ZIP+4 after a state abbreviation is an address, not an ITIN (95650-1234 has a valid-looking middle)", () => {
    const r = readItinLetter("IRS Notice CP565 assigned\nIRVINE CA 95650-1234", NOW)
    expect(r.itin.value).toBeNull()
    expect(r.itin.status).toBe("missing")
    // the real ITIN printed twice still wins when a ZIP+4 is on the page too
    expect(readItinLetter("IRS Notice CP565 assigned\nIRVINE CA 95650-1234\nITIN 900-70-1234 and 900-70-1234", NOW).itin).toMatchObject({ value: "900-70-1234", status: "ok" })
  })

  it("a number with an impossible middle (e.g. 900-66-1234) is not an ITIN", () => {
    const r = readItinLetter("IRS Notice CP565 assigned ITIN 900-66-1234", NOW)
    expect(r.itin.value).toBeNull()
    expect(r.itin.status).toBe("missing")
  })

  it("is not fooled by an ITIN-shaped number sitting inside a longer digit string", () => {
    const r = readItinLetter("IRS Notice CP565 assigned 19007012345 and 8900701234", NOW)
    expect(r.itin.value).toBeNull()
  })
})

describe("readItinLetter — not an ITIN notice", () => {
  it("a passport page or an invoice is reported as not an ITIN notice and nothing is read", () => {
    const r = readItinLetter("INVOICE 2026 Total due 900-70-1234 March 3, 1990", NOW)
    expect(r.isItinNotice).toBe(false)
    expect(r.itin.value).toBeNull()
    expect(r.noticeDate.value).toBeNull()
    expect(r.problems[0]).toMatch(/does not look like/i)
  })

  it("empty text", () => {
    expect(readItinLetter("", NOW).isItinNotice).toBe(false)
  })
})

describe("readItinLetter — fixes from the bug hunt (2026-11-07)", () => {
  it("the notice kind: 'CP565 and …' / 'CP565 Austin' are plain CP565; only a word-ending A is CP565A", () => {
    expect(readItinLetter("Notice CP565 and the IRS wrote\nITIN 900-70-1234 900-70-1234", NOW).noticeKind).toBe("CP565")
    expect(readItinLetter("Notice CP565\nAustin TX\nITIN 900-70-1234 900-70-1234", NOW).noticeKind).toBe("CP565")
    expect(readItinLetter("IRS Notice CP565A\nITIN 900-70-1234 900-70-1234", NOW).noticeKind).toBe("CP565A")
    expect(readItinLetter("IRS Notice CP-565a\nITIN 900-70-1234 900-70-1234", NOW).noticeKind).toBe("CP565A")
  })

  it("without 'CP565', only the notice's own sentences count — an expiry reminder that says 'ITIN assigned in 2019' is not an assignment notice", () => {
    expect(readItinLetter("Your ITIN assigned in 2019 will expire. ITIN 900-70-1234\nExpires December 31, 2026", NOW).isItinNotice).toBe(false)
    expect(readItinLetter("You've been assigned an Individual Taxpayer Identification Number (ITIN)\nITIN 900-70-1234 900-70-1234", NOW).isItinNotice).toBe(true)
    expect(readItinLetter("We assigned you Individual Taxpayer Identification Number (ITIN) 900-70-1234", NOW).isItinNotice).toBe(true)
  })

  it("a LONE date after a 'Notice date' label is never read OK — it could be a date of birth with the real notice date unreadable", () => {
    // labels first, values later: the first value after the LAST label is not that label's value
    const r = readItinLetter("IRS Notice CP565\nassigned ITIN 900-70-1234 900-70-1234\nDate of birth\nNotice date\nMay 5, 1998\nDecember 1O. 2025", NOW)
    expect(r.noticeDate.status).not.toBe("ok")
    const lone = readItinLetter("IRS Notice CP565 assigned ITIN 900-70-1234 900-70-1234\nNotice date: October 7, 2025", NOW)
    expect(lone.noticeDate).toMatchObject({ value: "2025-10-07", status: "unsure" })
    expect(lone.noticeDate.note).toMatch(/only once/i)
  })

  it("the same label read on two pages (agreeing) is OK", () => {
    const two = "IRS Notice CP565 assigned ITIN 900-70-1234 900-70-1234\nNotice date: October 7, 2025\nPage 2\nNotice date: October 7, 2025\nJune 9, 1985 date of birth"
    expect(readItinLetter(two, NOW).noticeDate.status).toBe("ok")
  })

  it("two dates only days apart (a date of birth read twice, one copy misread) are never OK", () => {
    const r = readItinLetter("IRS Notice CP565 assigned ITIN 900-70-1234 900-70-1234\nDate of birth: May 5, 1998\nDate of birth May 6, 1998\nDecember 1O. 2025", NOW)
    expect(r.noticeDate.status).toBe("unsure")
    expect(r.noticeDate.note).toMatch(/very close together/i)
  })

  it("a long run of blanks neither slows the reader nor changes what it reads", () => {
    const text = `IRS Notice CP565 assigned May 5${" ".repeat(200000)}x\nITIN 900-70-1234 900-70-1234`
    const t0 = Date.now()
    const r = readItinLetter(text, NOW)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(r.itin.value).toBe("900-70-1234")
  })

  it("ONE date only is never read OK, whatever label it sits under (a notice prints two: birth and notice)", () => {
    // 'Notice date' directly before what is really the date of birth, on both pages, with the real notice date unread
    const text = "IRS Notice CP565 assigned ITIN 900-70-1234 900-70-1234\nDate of birth\nNotice date\nMay 5, 1998\nPage 2\nNotice date\nMay 5, 1998"
    const r = readItinLetter(text, NOW)
    expect(r.noticeDate.value).toBe("1998-05-05")
    expect(r.noticeDate.status).toBe("unsure")
    expect(r.noticeDate.note).toMatch(/only one date/i)
  })

  it("a ZIP+4 after a state abbreviation is skipped even with a comma (', CA, 95650-1234')", () => {
    expect(readItinLetter("IRS Notice CP565 assigned\nIRVINE, CA, 95650-1234", NOW).itin.value).toBeNull()
    expect(readItinLetter("IRS Notice CP565 assigned\nIRVINE CA 95650-1234", NOW).itin.value).toBeNull()
  })

  it("a long run of LINE BREAKS (or mixed blanks and breaks) is as harmless as a run of spaces", () => {
    for (const filler of ["\n".repeat(200000), " \n".repeat(100000), "\t \n".repeat(60000)]) {
      const t0 = Date.now()
      const r = readItinLetter(`IRS Notice CP565 assigned May 5${filler}x\nITIN 900-70-1234 900-70-1234`, NOW)
      expect(Date.now() - t0).toBeLessThan(500)
      expect(r.itin.value).toBe("900-70-1234")
    }
  })

  it("checkIssueDate refuses a date before the date of birth", () => {
    expect(checkIssueDate("2005-01-01", { now: NOW, dateOfBirth: "2010-01-01" }).ok).toBe(false)
    expect(checkIssueDate("2025-01-01", { now: NOW, dateOfBirth: "2010-01-01" }).ok).toBe(true)
  })
})

describe("validators the save route uses on what staff confirmed", () => {
  it("isValidItinMiddle / isValidItin / formatItin", () => {
    for (const m of ["50", "65", "70", "88", "90", "92", "94", "99"]) expect(isValidItinMiddle(m)).toBe(true)
    for (const m of ["49", "66", "69", "89", "93", "00", "5", "abc"]) expect(isValidItinMiddle(m)).toBe(false)
    expect(isValidItin("900-70-1234")).toBe(true)
    expect(isValidItin("900 70 1234")).toBe(true)
    expect(isValidItin("900701234")).toBe(true)
    expect(isValidItin("800-70-1234")).toBe(false)
    expect(isValidItin("900-66-1234")).toBe(false)
    expect(isValidItin(null)).toBe(false)
    expect(formatItin("900701234")).toBe("900-70-1234")
    expect(formatItin("123")).toBeNull()
  })

  it("checkIssueDate: real date, from 1996, not in the future, not the date of birth", () => {
    expect(checkIssueDate("2025-10-07", { now: NOW }).ok).toBe(true)
    expect(checkIssueDate("2025-02-30", { now: NOW }).ok).toBe(false)
    expect(checkIssueDate("1995-12-31", { now: NOW }).ok).toBe(false)
    expect(checkIssueDate("2027-01-01", { now: NOW }).ok).toBe(false)
    expect(checkIssueDate("1990-03-03", { now: NOW, dateOfBirth: "1990-03-03" }).ok).toBe(false)
    expect(checkIssueDate("", { now: NOW }).ok).toBe(false)
    expect(checkIssueDate(null, { now: NOW }).ok).toBe(false)
    expect(checkIssueDate("10/07/2025", { now: NOW }).ok).toBe(false)
  })
})

describe("personNamedInText — whose letter is it", () => {
  const text = "JANE SAMPLEi\n14 HUGHES STE B200\nFull name JANE, SAMPLE"
  it("matches by first AND last word, ignoring case, accents and order", () => {
    expect(personNamedInText(text, "Jane Sample")).toBe(true)
    expect(personNamedInText(text, "Sample, Jane")).toBe(true)
    expect(personNamedInText("JOSÉ ÁLVAREZ", "Jose Alvarez")).toBe(true)
    expect(personNamedInText("JANE Q SAMPLE", "Jane Quincy Sample")).toBe(true) // a middle name may be left out
  })
  it("does not match another person of the same company", () => {
    expect(personNamedInText(text, "John Example")).toBe(false)
    expect(personNamedInText(text, "Jane Other")).toBe(false)
  })
  it("a name with one word has no usable match (null — the caller asks)", () => {
    expect(personNamedInText(text, "Jane")).toBeNull()
    expect(personNamedInText(text, "")).toBeNull()
    expect(personNamedInText(text, null)).toBeNull()
  })
  it("whole words only: 'sam' does not match 'sample'", () => {
    expect(personNamedInText("JANE SAMPLE", "Jane Sam")).toBe(false)
  })
  it("the IRS's own return address ('Austin, TX') is never somebody's name — a member 'Austin Jackson' is not named by a street called Jackson", () => {
    const letter = "Internal Revenue Service\nAustin, TX 78714-9342\nNotice CP565\nJANE SAMPLE\n100 JACKSON ST"
    expect(personNamedInText(letter, "Austin Jackson")).toBe(false)
    expect(personNamedInText("Austin TX 78714\nJANE SAMPLE\n100 JACKSON ST", "Austin Jackson")).toBe(false)
    // but a person who really is called Austin Jackson is still found by the name in the letter's own name block
    expect(personNamedInText(`Austin, TX 78714-9342\nAUSTIN JACKSON\n100 MAIN ST`, "Austin Jackson")).toBe(true)
  })
})

describe("namesCouldBeSamePerson — could two spellings be the same person", () => {
  it("two words in common, or the same first name spelled longer or shorter → the same person", () => {
    expect(namesCouldBeSamePerson("Pete Papik", "Peter Papik")).toBe(true)
    expect(namesCouldBeSamePerson("Giulia Rossi", "Giuliana Maria Rossi")).toBe(true)
    expect(namesCouldBeSamePerson("JOSÉ Álvarez", "Jose Alvarez")).toBe(true)
    expect(namesCouldBeSamePerson("Amato Biagio", "Biagio Amato")).toBe(true)
    expect(namesCouldBeSamePerson("Mark Eke", "Mark Botond Eke")).toBe(true)
    expect(namesCouldBeSamePerson("Nemeskeri Peter Marton", "Peter Marton Nemeskeri")).toBe(true)
  })
  it("a family name alone is NOT enough: a wife and a husband (one e-mail, one surname) are two people", () => {
    expect(namesCouldBeSamePerson("Mary Smith", "John Smith")).toBe(false)
    expect(namesCouldBeSamePerson("Anna Rossi", "Marco Rossi")).toBe(false)
    // a first name that merely STARTS the same is not a spelling of it when it is too short to say anything
    expect(namesCouldBeSamePerson("Al Smith", "Alan Smith")).toBe(false)
  })
  it("nothing in common → two different people", () => {
    expect(namesCouldBeSamePerson("Gaia Suriano", "Auralba Grifa")).toBe(false)
    expect(namesCouldBeSamePerson("Radomir Knapec", "Peter Papik")).toBe(false)
  })
  it("empty or one-letter words never match; a one-word name matches only itself", () => {
    expect(namesCouldBeSamePerson("", "Peter Papik")).toBe(false)
    expect(namesCouldBeSamePerson(null, "Peter Papik")).toBe(false)
    expect(namesCouldBeSamePerson("J Q", "Q J")).toBe(false)
    expect(namesCouldBeSamePerson("Smith", "John Smith")).toBe(false)
    expect(namesCouldBeSamePerson("J Smith", "Mary Smith")).toBe(false)
    expect(namesCouldBeSamePerson("Madonna", "madonna")).toBe(true)
  })
  it("names in other alphabets still have words: the same Cyrillic name is the same person, a different one is not", () => {
    expect(nameWords("Иван Петров")).toEqual(["иван", "петров"])
    expect(namesCouldBeSamePerson("Иван Петров", "Петров Иван")).toBe(true)
    expect(namesCouldBeSamePerson("Иван Петров", "Мария Петрова")).toBe(false)
    expect(namesCouldBeSamePerson("王伟", "王伟")).toBe(true)
  })
  it("letters that do not split into base + accent are spelled as an English letter spells them", () => {
    expect(nameWords("Paweł Nowak")).toEqual(["pawel", "nowak"])
    expect(nameWords("Søren Jørgensen")).toEqual(["soren", "jorgensen"])
    expect(namesCouldBeSamePerson("Søren Jørgensen", "Soren Jorgensen")).toBe(true)
    expect(personNamedInText("PAWEL NOWAK\n12 MAIN ST", "Paweł Nowak")).toBe(true)
  })
})
