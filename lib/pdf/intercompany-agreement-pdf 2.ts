/**
 * Intercompany Transfer Agreement PDF Generator
 *
 * Generates a professional PDF for intercompany fund transfer agreements
 * between an operating LLC and a holding/treasury LLC.
 *
 * Used when a MMLLC has a member entity that acts as treasury/holding.
 * Example: Azarexa LLC (NM, operative) ↔ Advertising Apex LLC (FL, treasury)
 *
 * Returns a Uint8Array (PDF bytes) ready for Drive upload.
 */

import { PDFDocument, rgb, StandardFonts, PDFFont } from "pdf-lib"

export interface IntercompanyAgreementInput {
  // Operating Company (the one generating revenue)
  operatingCompanyName: string
  operatingCompanyState: string
  operatingCompanyEin?: string
  operatingCompanyAddress: string

  // Treasury/Holding Company (the member entity receiving funds)
  treasuryCompanyName: string
  treasuryCompanyState: string
  treasuryCompanyEin?: string
  treasuryCompanyAddress: string
  treasuryOwnershipPct: number

  // Manager
  managerName: string

  // Agreement details
  effectiveDate: string
  oaEffectiveDate?: string // When the OA was signed (reference)
}

const PAGE_WIDTH = 595.28 // A4
const PAGE_HEIGHT = 841.89
const MARGIN = 50
const LINE_HEIGHT = 14
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

export async function generateIntercompanyAgreementPDF(
  input: IntercompanyAgreementInput
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique)

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  function newPage() {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    y = PAGE_HEIGHT - MARGIN
  }

  function check(needed: number) {
    if (y - needed < MARGIN + 30) newPage()
  }

  function wrapText(
    text: string,
    maxW: number,
    size: number,
    f: PDFFont
  ): string[] {
    const lines: string[] = []
    const words = text.split(" ")
    let line = ""
    for (const w of words) {
      const test = line ? `${line} ${w}` : w
      if (f.widthOfTextAtSize(test, size) > maxW && line) {
        lines.push(line)
        line = w
      } else {
        line = test
      }
    }
    if (line) lines.push(line)
    return lines
  }

  function drawWrapped(
    text: string,
    x: number,
    size: number,
    f: PDFFont,
    color = rgb(0, 0, 0),
    indent = 0
  ) {
    const lines = wrapText(text, CONTENT_WIDTH - indent, size, f)
    for (const ln of lines) {
      check(LINE_HEIGHT)
      page.drawText(ln, { x: x + indent, y, size, font: f, color })
      y -= LINE_HEIGHT
    }
  }

  function drawSection(title: string, paragraphs: string[]) {
    check(40)

    // Section title
    page.drawText(title, {
      x: MARGIN,
      y,
      size: 11,
      font: bold,
    })
    y -= LINE_HEIGHT + 4

    for (const para of paragraphs) {
      check(LINE_HEIGHT * 2)
      drawWrapped(para, MARGIN, 9.5, font, rgb(0, 0, 0), 0)
      y -= 6
    }
    y -= 4
  }

  // Format date nicely
  const fmtDate = (d: string) => {
    try {
      return new Date(d).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    } catch {
      return d
    }
  }

  const effectiveDateFmt = fmtDate(input.effectiveDate)

  // ─── Header ───
  page.drawText("TONY DURANTE LLC", {
    x: MARGIN,
    y,
    size: 8,
    font: bold,
    color: rgb(0.5, 0.5, 0.5),
  })
  y -= 20

  page.drawText("INTERCOMPANY TRANSFER AGREEMENT", {
    x: MARGIN,
    y,
    size: 16,
    font: bold,
  })
  y -= 16

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  })
  y -= 20

  // ─── Preamble ───
  drawWrapped(
    `This Intercompany Transfer Agreement (this "Agreement") is entered into as of ${effectiveDateFmt}, by and between:`,
    MARGIN,
    10,
    font
  )
  y -= 10

  // Party 1
  drawWrapped(
    `${input.operatingCompanyName}, a ${input.operatingCompanyState} limited liability company${input.operatingCompanyEin ? ` (EIN: ${input.operatingCompanyEin})` : ""}, with its principal office at ${input.operatingCompanyAddress} (the "Operating Company");`,
    MARGIN,
    9.5,
    font,
    rgb(0, 0, 0),
    16
  )
  y -= 6

  page.drawText("and", {
    x: MARGIN,
    y,
    size: 9.5,
    font: italic,
    color: rgb(0.3, 0.3, 0.3),
  })
  y -= LINE_HEIGHT + 4

  // Party 2
  drawWrapped(
    `${input.treasuryCompanyName}, a ${input.treasuryCompanyState} limited liability company${input.treasuryCompanyEin ? ` (EIN: ${input.treasuryCompanyEin})` : ""}, with its principal office at ${input.treasuryCompanyAddress} (the "Treasury Company").`,
    MARGIN,
    9.5,
    font,
    rgb(0, 0, 0),
    16
  )
  y -= 10

  drawWrapped(
    `The Operating Company and the Treasury Company are collectively referred to as the "Parties."`,
    MARGIN,
    9.5,
    font
  )
  y -= 10

  // ─── Recitals ───
  drawSection("RECITALS", [
    `WHEREAS, the Treasury Company holds a ${input.treasuryOwnershipPct}% membership interest in the Operating Company pursuant to the Operating Agreement of the Operating Company${input.oaEffectiveDate ? ` dated ${fmtDate(input.oaEffectiveDate)}` : ""};`,
    `WHEREAS, the Treasury Company serves as the holding and treasury entity for the consolidated business operations, maintaining physical banking relationships and financial reserves;`,
    `WHEREAS, the Operating Company generates revenue from its business activities and the Parties desire to establish a formal framework for the transfer of funds from the Operating Company to the Treasury Company for treasury management, capital preservation, and business purposes;`,
    `WHEREAS, ${input.managerName}, as Manager of the Operating Company, is authorized under the Operating Agreement (Sections 4.6, 4.7, and 5.5) to enter into intercompany agreements with Member entities;`,
    `NOW, THEREFORE, in consideration of the mutual covenants and agreements set forth herein, the Parties agree as follows:`,
  ])

  // ─── Article 1 ───
  drawSection("1. PURPOSE AND SCOPE", [
    `1.1 Purpose. This Agreement establishes the terms and conditions under which the Operating Company shall transfer funds to the Treasury Company for treasury management, capital preservation, investment, and such other business purposes as the Manager may determine.`,
    `1.2 Scope. This Agreement covers all intercompany fund transfers between the Parties, including but not limited to: (a) distributions to the Treasury Company as a Member of the Operating Company; (b) non-pro-rata distributions authorized under Section 4.6 of the Operating Agreement; (c) intercompany transfers for treasury management purposes; and (d) any other transfers authorized by the Manager.`,
    `1.3 Exclusions. This Agreement does not govern capital contributions from the Treasury Company to the Operating Company, which shall be governed by the Operating Agreement.`,
  ])

  // ─── Article 2 ───
  drawSection("2. TRANSFER MECHANICS", [
    `2.1 Authorization. All transfers under this Agreement shall be authorized by ${input.managerName} as Manager of the Operating Company. No transfer shall require additional Member approval beyond the Manager's authorization, as provided in Section 5.5 of the Operating Agreement.`,
    `2.2 Method. Transfers shall be made by wire transfer or ACH payment from the Operating Company's bank account(s) to the Treasury Company's bank account(s). The Manager shall maintain a record of the bank account details for both Parties.`,
    `2.3 Frequency. Transfers may be made at such times and in such amounts as the Manager determines, provided that each transfer is documented in accordance with Section 3 of this Agreement.`,
    `2.4 Minimum Balance. The Manager shall ensure that the Operating Company maintains sufficient funds to meet its current obligations and reasonably anticipated expenses before authorizing any transfer.`,
  ])

  // ─── Article 3 ───
  drawSection("3. DOCUMENTATION AND RECORDS", [
    `3.1 Transfer Record. For each transfer made under this Agreement, the Manager shall prepare or cause to be prepared a written record containing: (a) the date of the transfer; (b) the amount transferred; (c) the purpose or classification of the transfer (distribution, treasury management, etc.); (d) the bank accounts involved; and (e) any other information required for proper accounting.`,
    `3.2 Classification. Each transfer shall be classified as one of the following: (a) Member Distribution — a distribution to the Treasury Company in its capacity as a Member, allocated per the Operating Agreement percentages or as a non-pro-rata distribution under Section 4.6; (b) Treasury Transfer — a transfer for treasury management, capital preservation, or investment purposes; (c) Expense Reimbursement — reimbursement for expenses incurred by the Treasury Company on behalf of the Operating Company.`,
    `3.3 Books and Records. All transfers shall be properly reflected in the books and records of both Parties. The Manager shall maintain a transfer ledger that is available for inspection at the Operating Company's principal office.`,
    `3.4 Tax Reporting. Transfers classified as Member Distributions shall be reported on the Operating Company's Form 1065 and the corresponding Schedule K-1 for the Treasury Company. Treasury Transfers shall be documented as intercompany transactions and properly accounted for in both Parties' financial records.`,
  ])

  // ─── Article 4 ───
  drawSection("4. TREASURY MANAGEMENT", [
    `4.1 Treasury Function. The Treasury Company shall serve as the central treasury for the consolidated business operations. Funds received from the Operating Company may be used by the Treasury Company for: (a) capital preservation and investment; (b) payment of consolidated expenses; (c) distributions to the Treasury Company's own members; (d) funding of new business ventures or investments; and (e) any other lawful business purpose.`,
    `4.2 Segregation. The Treasury Company shall maintain adequate records to distinguish between funds received from the Operating Company and funds from other sources.`,
    `4.3 No Commingling with Personal Funds. Funds held by the Treasury Company shall not be commingled with the personal funds of any individual member or manager of either Party.`,
  ])

  // ─── Article 5 ───
  drawSection("5. REPRESENTATIONS AND WARRANTIES", [
    `5.1 Authority. Each Party represents that it has full power and authority to enter into this Agreement and perform its obligations hereunder.`,
    `5.2 Operating Agreement. The Parties confirm that this Agreement is consistent with and authorized by the Operating Agreement of the Operating Company, specifically Sections 4.6, 4.7, and 5.5.`,
    `5.3 Arm's Length. The terms of this Agreement have been negotiated on commercially reasonable terms consistent with arm's length principles.`,
  ])

  // ─── Article 6 ───
  drawSection("6. TERM AND TERMINATION", [
    `6.1 Term. This Agreement shall be effective as of ${effectiveDateFmt} and shall continue in effect until terminated in accordance with this Section.`,
    `6.2 Termination. This Agreement may be terminated: (a) by mutual written consent of the Parties; (b) upon the dissolution of either Party; (c) upon the Treasury Company ceasing to be a Member of the Operating Company; or (d) by the Manager upon thirty (30) days' written notice.`,
    `6.3 Effect of Termination. Upon termination, no further transfers shall be made under this Agreement. Obligations arising from transfers made prior to termination shall survive.`,
  ])

  // ─── Article 7 ───
  drawSection("7. GENERAL PROVISIONS", [
    `7.1 Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the State of ${input.operatingCompanyState}.`,
    `7.2 Amendments. This Agreement may be amended only by a written instrument signed by the Manager of the Operating Company and an authorized representative of the Treasury Company.`,
    `7.3 Entire Agreement. This Agreement, together with the Operating Agreement of the Operating Company, constitutes the entire agreement between the Parties with respect to the subject matter hereof.`,
    `7.4 Severability. If any provision of this Agreement is held to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.`,
    `7.5 Counterparts. This Agreement may be executed in counterparts, each of which shall be deemed an original.`,
  ])

  // ─── Signature Block ───
  check(120)
  y -= 10
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  })
  y -= 20

  page.drawText("IN WITNESS WHEREOF, the Parties have executed this Agreement as of the date first written above.", {
    x: MARGIN,
    y,
    size: 9.5,
    font: italic,
  })
  y -= 30

  // Operating Company
  page.drawText("OPERATING COMPANY:", {
    x: MARGIN,
    y,
    size: 9,
    font: bold,
  })
  y -= LINE_HEIGHT
  page.drawText(input.operatingCompanyName, {
    x: MARGIN,
    y,
    size: 9,
    font,
  })
  y -= 30

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + 200, y },
    thickness: 0.5,
  })
  y -= LINE_HEIGHT
  page.drawText(`By: ${input.managerName}, Manager`, {
    x: MARGIN,
    y,
    size: 8,
    font,
    color: rgb(0.3, 0.3, 0.3),
  })
  y -= 10
  page.drawText("Date: _____________________", {
    x: MARGIN,
    y,
    size: 8,
    font,
    color: rgb(0.3, 0.3, 0.3),
  })

  // Treasury Company (right side or below)
  y -= 30
  page.drawText("TREASURY COMPANY:", {
    x: MARGIN,
    y,
    size: 9,
    font: bold,
  })
  y -= LINE_HEIGHT
  page.drawText(input.treasuryCompanyName, {
    x: MARGIN,
    y,
    size: 9,
    font,
  })
  y -= 30

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + 200, y },
    thickness: 0.5,
  })
  y -= LINE_HEIGHT
  page.drawText(`By: ${input.managerName}, Authorized Representative`, {
    x: MARGIN,
    y,
    size: 8,
    font,
    color: rgb(0.3, 0.3, 0.3),
  })
  y -= 10
  page.drawText("Date: _____________________", {
    x: MARGIN,
    y,
    size: 8,
    font,
    color: rgb(0.3, 0.3, 0.3),
  })

  // ─── Footer on all pages ───
  const pages = doc.getPages()
  for (let i = 0; i < pages.length; i++) {
    pages[i].drawText(
      `Tony Durante LLC  |  Confidential  |  Page ${i + 1} of ${pages.length}`,
      {
        x: MARGIN,
        y: 25,
        size: 7,
        font,
        color: rgb(0.55, 0.55, 0.55),
      }
    )
  }

  return doc.save()
}
