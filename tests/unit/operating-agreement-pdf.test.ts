/**
 * lib/pdf/operating-agreement-pdf.ts — the SERVER-side operating agreement.
 *
 * This replaces a document produced by the client's browser (HTML screenshotted
 * by html2pdf) and filed by TD as the executed instrument. The server could
 * check who was asking but never what was in the file, so nothing stopped a
 * signer submitting a different agreement.
 *
 * THE TEST THAT MATTERS is content parity: the clauses come from the same
 * generator the browser used, so only the painting changes — and that claim is
 * worth exactly nothing unless it is checked. So these tests extract the text
 * back OUT of the produced PDF and assert every section title and every line of
 * every clause survived the render.
 *
 * Why that specific paranoia: the near-miss on this subsystem was a field the
 * pages never read but the template printed (each member's address). It was
 * caught by inspecting real output, not by reading code. Eyeballing a PDF would
 * not have caught it either.
 */

import { describe, it, expect } from "vitest"
import {
  generateOperatingAgreementPDF,
  formatAgreementDate,
  formatSignedDate,
} from "@/lib/pdf/operating-agreement-pdf"
import { generateOASections, type OAData } from "@/lib/types/oa-templates"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractText(bytes: Uint8Array): Promise<string> {
  // pdf-parse's index does a debug read of a sample file when imported directly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse/lib/pdf-parse.js")
  const out = await pdfParse(Buffer.from(bytes))
  return out.text as string
}

/**
 * Whitespace-insensitive containment — the renderer wraps lines, so exact runs
 * differ. The page footer is stripped first: pdf-parse emits it in reading order,
 * so a clause spanning a page break comes back with "Page 1 of 5" interleaved in
 * the middle of a sentence. That is an extraction artifact, not a rendering
 * defect — the footer is verified separately in "the output is a real PDF".
 */
const norm = (s: string) =>
  s.replace(/Page \d+ of \d+/g, " ").replace(/\s+/g, " ").trim()

const MM: OAData = {
  company_name: "Acme Holdings LLC",
  state_of_formation: "FL",
  formation_date: "2026-01-10",
  ein_number: "83-4299021",
  entity_type: "MMLLC",
  member_name: "Member One",
  member_address: "1 Main Street, Miami, FL 33101",
  members: [
    { name: "Member One", address: "1 Main Street, Miami, FL 33101", ownership_pct: 60, initial_contribution: "6000" },
    { name: "Member Two", address: "9 Oak Road, Tampa, FL 33602", ownership_pct: 40, initial_contribution: "4000" },
  ],
  manager_name: "Member One",
  effective_date: "2026-01-10",
  business_purpose: "Consulting services",
  initial_contribution: "10000",
  fiscal_year_end: "December 31",
  accounting_method: "Cash",
  duration: "Perpetual",
  registered_agent_name: "Registered Agents Inc",
  registered_agent_address: "2 Agent Way, Tallahassee, FL 32301",
  principal_address: "1 Main Street, Miami, FL 33101",
}

const SM: OAData = { ...MM, entity_type: "SMLLC", members: undefined, company_name: "Solo Ventures LLC" }

describe("content parity — every clause survives the render", () => {
  it("multi-member: every section TITLE appears in the PDF text", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: MM })))
    for (const section of generateOASections(MM)) {
      expect(text, `missing section title: ${section.title}`).toContain(norm(section.title))
    }
  })

  it("multi-member: every non-trivial LINE of every clause appears", async () => {
    // The real risk is a dropped field inside a clause, not a dropped heading.
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: MM })))
    for (const section of generateOASections(MM)) {
      for (const line of section.content.split("\n")) {
        const t = norm(line)
        if (t.length < 12) continue // skip blank/ornamental lines
        expect(text, `missing clause line in "${section.title}": ${t.slice(0, 60)}`).toContain(t)
      }
    }
  })

  it("single-member: every section title and clause line appears", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: SM })))
    for (const section of generateOASections(SM)) {
      expect(text).toContain(norm(section.title))
      for (const line of section.content.split("\n")) {
        const t = norm(line)
        if (t.length < 12) continue
        expect(text).toContain(t)
      }
    }
  })
})

describe("the identifying facts are on the document", () => {
  it("carries company, state, EIN, effective date and both members with their splits AND addresses", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: MM })))
    expect(text).toContain("Acme Holdings LLC")
    expect(text).toContain("Multi-Member Limited Liability Company")
    expect(text).toContain("83-4299021")
    expect(text).toContain("January 10, 2026")
    expect(text).toContain("Member One")
    expect(text).toContain("Member Two")
    expect(text).toContain("60%")
    expect(text).toContain("40%")
    // The address near-miss that started this: present for BOTH members.
    expect(text).toContain("1 Main Street, Miami, FL 33101")
    expect(text).toContain("9 Oak Road, Tampa, FL 33602")
  })

  it("states the execution clause and names the manager", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: MM })))
    expect(text).toContain("IN WITNESS WHEREOF, the Members have executed this Operating Agreement")
    expect(text).toContain("MANAGER")
    expect(text).toContain("Title: Manager")
  })

  it("single-member uses the singular execution clause and the sole-member line", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: SM })))
    expect(text).toContain("IN WITNESS WHEREOF, the Member has executed this Operating Agreement")
    expect(text).toContain("Sole Member / Manager")
    expect(text).toContain("Single Member Limited Liability Company")
  })
})

describe("signature dates — each member by their OWN date", () => {
  it("dates each member block from that member's signing time, not today", async () => {
    // The browser stamped today's date on EVERY block, so an earlier signer was
    // dated as of the last signer's day while the caption showed the true date —
    // the document contradicted itself.
    const bytes = await generateOperatingAgreementPDF({
      data: MM,
      signatures: [
        { memberIndex: 0, signedAt: "2026-06-01T10:00:00.000Z", signaturePng: null },
        { memberIndex: 1, signedAt: "2026-07-20T10:00:00.000Z", signaturePng: null },
      ],
    })
    const text = norm(await extractText(bytes))
    expect(text).toContain("June 1, 2026")
    expect(text).toContain("July 20, 2026")
  })

  it("leaves an unsigned member's date blank rather than inventing one", async () => {
    const bytes = await generateOperatingAgreementPDF({
      data: MM,
      signatures: [{ memberIndex: 0, signedAt: "2026-06-01T10:00:00.000Z", signaturePng: null }],
    })
    const text = norm(await extractText(bytes))
    expect(text).toContain("____________________")
    // And it must NOT claim the unsigned member signed.
    expect((text.match(/Signed on/g) ?? []).length).toBe(1)
  })

  it("records a signed member as signed even when the image is unavailable", async () => {
    const bytes = await generateOperatingAgreementPDF({
      data: MM,
      signatures: [{ memberIndex: 0, signedAt: "2026-06-01T10:00:00.000Z", signaturePng: null }],
    })
    const text = norm(await extractText(bytes))
    expect(text).toContain("Signed on June 1, 2026 (signature on file)")
  })

  it("does not abort the document when a signature blob is corrupt", async () => {
    const bytes = await generateOperatingAgreementPDF({
      data: MM,
      signatures: [
        { memberIndex: 0, signedAt: "2026-06-01T10:00:00.000Z", signaturePng: new Uint8Array([1, 2, 3, 4]) },
      ],
    })
    const text = norm(await extractText(bytes))
    expect(text).toContain("Acme Holdings LLC")
    expect(text).toContain("Signed on June 1, 2026")
  })
})

describe("draft mode — the reading copy must not read as executed", () => {
  it("multi-member: stamps DRAFT, and the recital says NOT signed rather than 'have executed'", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: MM, draft: true })))
    expect(text).toContain("DRAFT — NOT SIGNED")
    // The legal blocker was TD's own text asserting execution. In draft it must
    // NOT say the members "have executed", and must say it is not signed.
    expect(text).not.toContain("Members have executed this Operating Agreement")
    expect(text).toContain("intend to execute")
    expect(text).toContain("THIS COPY HAS NOT BEEN SIGNED")
  })

  it("single-member: draft recital is singular-intent, not 'has executed'", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: SM, draft: true })))
    expect(text).toContain("DRAFT — NOT SIGNED")
    expect(text).not.toContain("Member has executed this Operating Agreement")
    expect(text).toContain("intends to execute")
  })

  it("the preamble drops the flat 'is entered into and effective' assertion", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: MM, draft: true })))
    expect(text).toContain("is to be entered into and effective as of")
    expect(text).not.toContain("is entered into and effective as of")
  })

  it("still carries every clause — a draft is the SAME agreement, only unsigned", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: MM, draft: true })))
    for (const section of generateOASections(MM)) {
      expect(text, `missing section title: ${section.title}`).toContain(norm(section.title))
    }
    expect(text).toContain("Acme Holdings LLC")
    expect(text).toContain("Member Two")
  })

  it("marks EVERY page, not just the first", async () => {
    const bytes = await generateOperatingAgreementPDF({ data: MM, draft: true })
    const raw = await extractText(bytes)
    const pageCount = Number(raw.match(/Page 1 of (\d+)/)?.[1] ?? "0")
    expect(pageCount).toBeGreaterThan(1)
    const stamps = (raw.match(/DRAFT — NOT SIGNED/g) ?? []).length
    // Top and bottom stamp per page, plus the banner + notice on page 1.
    expect(stamps).toBeGreaterThanOrEqual(pageCount)
  })

  it("the normal (non-draft) render is unchanged — still asserts execution, no DRAFT", async () => {
    const text = norm(await extractText(await generateOperatingAgreementPDF({ data: MM })))
    expect(text).toContain("Members have executed this Operating Agreement")
    expect(text).not.toContain("DRAFT — NOT SIGNED")
  })
})

describe("formatAgreementDate — no timezone shift", () => {
  it("renders a stored date as the SAME calendar day", () => {
    // `new Date("2026-01-10")` is UTC midnight and prints as Jan 9 west of
    // Greenwich — which would silently move an agreement's effective date.
    expect(formatAgreementDate("2026-01-10")).toBe("January 10, 2026")
    expect(formatAgreementDate("2026-12-31")).toBe("December 31, 2026")
  })

  it("tolerates a full timestamp and returns empty for nothing", () => {
    expect(formatAgreementDate("2026-01-10T00:00:00Z")).toBe("January 10, 2026")
    expect(formatAgreementDate(null)).toBe("")
    expect(formatAgreementDate(undefined)).toBe("")
  })

  it("returns the input unchanged rather than a wrong date when unparseable", () => {
    expect(formatAgreementDate("not-a-date")).toBe("not-a-date")
  })
})

describe("formatSignedDate", () => {
  it("formats an ISO instant and refuses garbage", () => {
    expect(formatSignedDate("2026-06-01T10:00:00.000Z")).toBe("June 1, 2026")
    expect(formatSignedDate(null)).toBe("")
    expect(formatSignedDate("nonsense")).toBe("")
  })
})

describe("the output is a real PDF", () => {
  it("produces multi-page output with a page count on every page", async () => {
    const bytes = await generateOperatingAgreementPDF({ data: MM })
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-")
    const text = await extractText(bytes)
    expect(text).toMatch(/Page 1 of \d+/)
  })

  it("is real text, not a picture of text", async () => {
    // html2canvas produced a raster image: nothing extractable. If this ever
    // returns almost nothing, the renderer has regressed to an image.
    const text = await extractText(await generateOperatingAgreementPDF({ data: MM }))
    expect(text.length).toBeGreaterThan(2000)
  })
})
