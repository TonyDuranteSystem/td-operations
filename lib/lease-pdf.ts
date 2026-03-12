/**
 * Office Lease Agreement PDF Generator — Tony Durante LLC
 *
 * Uses pdf-lib (pure JS, no native deps) for Vercel serverless compatibility.
 * Generates a professional Office Lease Agreement that meets banking requirements.
 *
 * Key changes from original:
 * - Landlord: Tony Durante LLC (not Myllcexpert)
 * - Title: "OFFICE LEASE AGREEMENT" (standard commercial)
 * - REMOVED "creates NO tenancy interest" (bank killer)
 * - REMOVED "Ownership" clause (SaaS language)
 * - REMOVED "Auto-Pay" references
 * - ADDED: EIN, State of Formation, suite, sq ft, permitted use, utilities, insurance
 * - Deposit: refundable (Florida law), $150 default
 * - Termination: 30 days both parties (not unilateral)
 */

import { PDFDocument, rgb, StandardFonts, PDFFont } from 'pdf-lib'

// ─── Colors ──────────────────────────────────────────────
const C = {
  black: rgb(0.1, 0.1, 0.1),
  dark: rgb(0.2, 0.2, 0.2),
  medium: rgb(0.35, 0.35, 0.35),
  light: rgb(0.55, 0.55, 0.55),
  rule: rgb(0.75, 0.75, 0.75),
}

// ─── Types ──────────────────────────────────────────────
export interface LeaseData {
  // Landlord
  landlordName?: string            // Default: Tony Durante LLC
  landlordAddress?: string         // Default: 10225 Ulmerton Rd, Suite 3D, Largo, FL 33771
  landlordSigner?: string          // Default: Antonio Durante
  landlordTitle?: string           // Default: Managing Member

  // Tenant
  tenantCompany: string            // Company/LLC name
  tenantEin?: string               // EIN (e.g. "30-1482516")
  tenantState?: string             // State of formation (e.g. "New Mexico")
  tenantContactName: string        // Owner/signer name
  tenantTitle?: string             // Default: Owner/Member

  // Premises
  premisesAddress?: string         // Default: 10225 Ulmerton Rd, Largo, FL 33771
  suiteNumber: string              // e.g. "3D-107" — REQUIRED
  squareFeet?: number              // Default: 120

  // Term
  effectiveDate: string            // YYYY-MM-DD
  termStartDate: string            // YYYY-MM-DD
  termEndDate: string              // YYYY-MM-DD (e.g. December 31, 2026)
  termMonths?: number              // Default 12

  // Financials
  monthlyRent?: number             // Default 100
  yearlyRent?: number              // Default 1200
  securityDeposit?: number         // Default 150
  lateFee?: number                 // Default 25
  lateFeePerDay?: number           // Default 5
}

// ─── Helpers ────────────────────────────────────────────
function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function fmtCurrency(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const test = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(test, size) > maxWidth) {
      if (current) lines.push(current)
      current = word
    } else {
      current = test
    }
  }
  if (current) lines.push(current)
  return lines
}

// ─── Page Manager ───────────────────────────────────────
class PageWriter {
  doc: PDFDocument
  page: ReturnType<PDFDocument['addPage']>
  y: number
  pageNum = 1
  totalPages = 6
  margin = 60
  font!: PDFFont
  fontBold!: PDFFont
  fontItalic!: PDFFont
  contentWidth: number
  pageHeight = 792
  pageWidth = 612
  bottomMargin = 65

  constructor(doc: PDFDocument) {
    this.doc = doc
    this.page = doc.addPage([this.pageWidth, this.pageHeight])
    this.y = this.pageHeight - this.margin
    this.contentWidth = this.pageWidth - this.margin * 2
  }

  async init() {
    this.font = await this.doc.embedFont(StandardFonts.TimesRoman)
    this.fontBold = await this.doc.embedFont(StandardFonts.TimesRomanBold)
    this.fontItalic = await this.doc.embedFont(StandardFonts.TimesRomanItalic)
  }

  checkSpace(needed: number) {
    if (this.y - needed < this.bottomMargin) {
      this.newPage()
    }
  }

  newPage() {
    this.drawPageFooter()
    this.page = this.doc.addPage([this.pageWidth, this.pageHeight])
    this.pageNum++
    this.y = this.pageHeight - this.margin
  }

  drawPageFooter() {
    const text = `Page ${this.pageNum} of ${this.totalPages}`
    const w = this.font.widthOfTextAtSize(text, 9)
    this.page.drawText(text, {
      x: (this.pageWidth - w) / 2,
      y: 35,
      size: 9,
      font: this.font,
      color: C.light,
    })
  }

  title(text: string, size = 16) {
    const w = this.fontBold.widthOfTextAtSize(text, size)
    this.page.drawText(text, {
      x: (this.pageWidth - w) / 2,
      y: this.y,
      size,
      font: this.fontBold,
      color: C.black,
    })
    this.y -= size + 8
  }

  para(text: string, {
    size = 10.5,
    indent = 0,
    font,
    color = C.dark,
    lineHeight = 15,
    spaceAfter = 10,
  }: {
    size?: number
    indent?: number
    font?: PDFFont
    color?: ReturnType<typeof rgb>
    lineHeight?: number
    spaceAfter?: number
  } = {}) {
    const f = font || this.font
    const maxW = this.contentWidth - indent
    const lines = wrapText(text, f, size, maxW)

    for (const line of lines) {
      this.checkSpace(lineHeight)
      this.page.drawText(line, {
        x: this.margin + indent,
        y: this.y,
        size,
        font: f,
        color,
      })
      this.y -= lineHeight
    }
    this.y -= spaceAfter
  }

  labelPara(label: string, text: string, indent = 0) {
    const size = 10.5
    const lh = 15
    const labelW = this.fontBold.widthOfTextAtSize(label, size)
    const maxW = this.contentWidth - indent

    const firstLineRemaining = maxW - labelW
    const textLines = wrapText(text, this.font, size, firstLineRemaining)
    const firstLine = textLines.shift() || ''

    this.checkSpace(lh)
    this.page.drawText(label, {
      x: this.margin + indent,
      y: this.y,
      size,
      font: this.fontBold,
      color: C.dark,
    })
    this.page.drawText(firstLine, {
      x: this.margin + indent + labelW,
      y: this.y,
      size,
      font: this.font,
      color: C.dark,
    })
    this.y -= lh

    if (textLines.length > 0) {
      const remaining = textLines.join(' ')
      const rewrapped = wrapText(remaining, this.font, size, maxW)
      for (const line of rewrapped) {
        this.checkSpace(lh)
        this.page.drawText(line, {
          x: this.margin + indent,
          y: this.y,
          size,
          font: this.font,
          color: C.dark,
        })
        this.y -= lh
      }
    }
    this.y -= 8
  }

  rule() {
    this.page.drawRectangle({
      x: this.margin,
      y: this.y,
      width: this.contentWidth,
      height: 0.5,
      color: C.rule,
    })
    this.y -= 12
  }

  space(px = 10) {
    this.y -= px
  }
}

// ─── Main Generator ─────────────────────────────────────
export async function generateLeasePDF(data: LeaseData): Promise<Uint8Array> {
  const landlordName = data.landlordName ?? 'Tony Durante LLC'
  const landlordAddress = data.landlordAddress ?? '10225 Ulmerton Rd, Suite 3D, Largo, FL 33771'
  const landlordSigner = data.landlordSigner ?? 'Antonio Durante'
  const landlordTitle = data.landlordTitle ?? 'Managing Member'

  const tenantTitle = data.tenantTitle ?? 'Owner/Member'
  const tenantEinDisplay = data.tenantEin ? ` (EIN: ${data.tenantEin})` : ''
  const tenantStateDisplay = data.tenantState ? `a ${data.tenantState}` : 'a'

  const premisesAddress = data.premisesAddress ?? '10225 Ulmerton Rd, Largo, FL 33771'
  const suiteNumber = data.suiteNumber
  const sqft = data.squareFeet ?? 120
  const fullAddress = `${premisesAddress.replace(/,?\s*(Largo|FL|33771).*/i, '')}, Suite ${suiteNumber}, Largo, FL 33771`

  const termMonths = data.termMonths ?? 12
  const monthlyRent = data.monthlyRent ?? 100
  const yearlyRent = data.yearlyRent ?? 1200
  const deposit = data.securityDeposit ?? 150
  const lateFee = data.lateFee ?? 25
  const lateFeePerDay = data.lateFeePerDay ?? 5

  const doc = await PDFDocument.create()
  const pw = new PageWriter(doc)
  await pw.init()

  // ═══════════════════════════════════════════════════════
  // PAGE 1 — Title + Parties + Premises + Term
  // ═══════════════════════════════════════════════════════

  pw.title('OFFICE LEASE AGREEMENT')
  pw.space(6)
  pw.rule()
  pw.space(4)

  // Preamble
  pw.para(
    `This Office Lease Agreement ("Agreement") is entered into and made effective as of ${fmtDate(data.effectiveDate)} ("Effective Date"), by and between:`,
    { font: pw.fontItalic, size: 10.5 }
  )
  pw.space(4)

  // Landlord block
  pw.para('LANDLORD:', { font: pw.fontBold, size: 11, spaceAfter: 3 })
  pw.para(`${landlordName}, a Florida Limited Liability Company`, { indent: 20, spaceAfter: 2 })
  pw.para(landlordAddress, { indent: 20, spaceAfter: 2 })
  pw.para(`("Landlord")`, { indent: 20, font: pw.fontItalic })
  pw.space(6)

  // Tenant block
  pw.para('TENANT:', { font: pw.fontBold, size: 11, spaceAfter: 3 })
  pw.para(`${data.tenantCompany}, ${tenantStateDisplay} Limited Liability Company${tenantEinDisplay}`, { indent: 20, spaceAfter: 2 })
  pw.para(`Represented by: ${data.tenantContactName}, ${tenantTitle}`, { indent: 20, spaceAfter: 2 })
  pw.para(`("Tenant")`, { indent: 20, font: pw.fontItalic })
  pw.space(6)

  pw.para(
    'The Landlord and Tenant are collectively referred to as the "Parties." The Parties hereby agree as follows:',
    { spaceAfter: 6 }
  )

  pw.rule()

  // ─── ARTICLE 1: PREMISES ───
  pw.para('Article 1 — Premises', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.para(
    `Landlord hereby leases to Tenant, and Tenant hereby leases from Landlord, the following described premises:`
  )

  pw.para(`Address: ${fullAddress}`, { font: pw.fontBold, indent: 20, spaceAfter: 3 })
  pw.para(
    `Description: Approximately ${sqft} square feet of furnished office space, including desk, chair, and access to shared common areas ("Premises").`,
    { indent: 20 }
  )

  // ─── ARTICLE 2: TERM ───
  pw.para('Article 2 — Term', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '2.1 ',
    `The initial term of this Agreement shall commence on ${fmtDate(data.termStartDate)} and shall expire on ${fmtDate(data.termEndDate)} ("Initial Term").`
  )

  pw.labelPara(
    '2.2 ',
    `Upon expiration of the Initial Term, this Agreement shall automatically renew for successive twelve (12) month periods ("Renewal Term"), unless either Party provides written notice of non-renewal at least thirty (30) days prior to the expiration of the then-current term.`
  )

  pw.labelPara(
    '2.3 ',
    'The Initial Term and any Renewal Term are collectively referred to as the "Term."'
  )

  // ─── ARTICLE 3: RENT ───
  pw.para('Article 3 — Rent', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '3.1 ',
    `Tenant shall pay Landlord a monthly rent of ${fmtCurrency(monthlyRent)} ("Monthly Rent"), totaling ${fmtCurrency(yearlyRent)} per annum.`
  )

  pw.labelPara(
    '3.2 ',
    'Monthly Rent shall be due and payable on the first (1st) day of each calendar month during the Term.'
  )

  pw.labelPara(
    '3.3 ',
    'If the Term commences on a date other than the first day of a calendar month, the Monthly Rent for the first partial month shall be prorated on a per diem basis.'
  )

  pw.labelPara(
    '3.4 ',
    'Rent shall be paid by electronic funds transfer or such other method as agreed upon by the Parties.'
  )

  // ─── ARTICLE 4: SECURITY DEPOSIT ───
  pw.para('Article 4 — Security Deposit', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '4.1 ',
    `Upon execution of this Agreement, Tenant shall pay Landlord a security deposit of ${fmtCurrency(deposit)} ("Security Deposit").`
  )

  pw.labelPara(
    '4.2 ',
    'The Security Deposit shall be held by Landlord as security for the faithful performance by Tenant of all terms and conditions of this Agreement.'
  )

  pw.labelPara(
    '4.3 ',
    'Landlord may apply the Security Deposit toward any unpaid rent, damages, or other amounts owed by Tenant. In such event, Tenant shall replenish the Security Deposit to its full amount within ten (10) business days of written notice from Landlord.'
  )

  pw.labelPara(
    '4.4 ',
    'The Security Deposit, less any lawful deductions, shall be returned to Tenant within thirty (30) days following the termination of this Agreement and Tenant\'s complete vacation of the Premises.'
  )

  // ─── ARTICLE 5: PERMITTED USE ───
  pw.para('Article 5 — Permitted Use', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '5.1 ',
    "The Premises shall be used and occupied by Tenant solely for general office and administrative purposes in connection with Tenant's lawful business operations."
  )

  pw.labelPara(
    '5.2 ',
    'Tenant shall not use the Premises for any unlawful purpose or in any manner that would constitute a nuisance, disturb other tenants, or increase the insurance premiums for the building.'
  )

  // ─── ARTICLE 6: UTILITIES AND SERVICES ───
  pw.para('Article 6 — Utilities and Services', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '6.1 ',
    'Landlord shall provide the following utilities and services at no additional cost to Tenant: electricity, heating, ventilation and air conditioning (HVAC), internet connectivity, water and sewage, and common area maintenance and janitorial service.'
  )

  pw.labelPara(
    '6.2 ',
    'Building common areas, including restrooms, hallways, and reception areas, shall be accessible to Tenant during normal business hours, Monday through Friday, 8:30 AM to 5:00 PM, excluding federal holidays.'
  )

  // ─── ARTICLE 7: MAINTENANCE AND REPAIRS ───
  pw.para('Article 7 — Maintenance and Repairs', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '7.1 ',
    'Landlord shall maintain the Premises and all building systems (structural, mechanical, electrical, plumbing) in good working order and condition.'
  )

  pw.labelPara(
    '7.2 ',
    'Tenant shall maintain the interior of the Premises in a clean and orderly condition and shall promptly notify Landlord of any needed repairs.'
  )

  pw.labelPara(
    '7.3 ',
    'Tenant shall be responsible for any damage to the Premises caused by the negligence or willful acts of Tenant, its employees, agents, or invitees.'
  )

  // ─── ARTICLE 8: INSURANCE ───
  pw.para('Article 8 — Insurance', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '8.1 ',
    'Tenant shall, at its sole cost, maintain commercial general liability insurance with coverage limits of not less than $1,000,000 per occurrence, naming Landlord as an additional insured. Tenant shall provide Landlord with a certificate of insurance upon request.'
  )

  pw.labelPara(
    '8.2 ',
    'Landlord shall maintain property insurance covering the building and its common areas.'
  )

  // ─── ARTICLE 9: COMPLIANCE WITH LAW ───
  pw.para('Article 9 — Compliance with Law', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.para(
    'Tenant shall comply with all applicable federal, state, and local laws, ordinances, codes, rules, and regulations in the use and occupancy of the Premises. Failure to comply may result in termination of this Agreement upon written notice from Landlord.'
  )

  // ─── ARTICLE 10: INDEMNIFICATION ───
  pw.para('Article 10 — Indemnification', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.para(
    "Tenant agrees to indemnify, defend, and hold harmless Landlord from and against any and all claims, damages, losses, costs, and expenses (including reasonable attorney's fees) arising from Tenant's use and occupancy of the Premises or from any activity, work, or act performed by Tenant, its employees, agents, contractors, or invitees in or about the Premises."
  )

  // ─── ARTICLE 11: CONFIDENTIALITY ───
  pw.para('Article 11 — Confidentiality', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.para(
    'Tenant recognizes that it may, in the course of using the Premises, come into possession of confidential and proprietary business information ("Confidential Information") about Landlord. Tenant agrees that during the Term and for a period of two (2) years thereafter: (a) Tenant shall exercise reasonable care to avoid disclosure or unauthorized use of Confidential Information; (b) Tenant will use Confidential Information solely for the purposes of this Agreement; and (c) Tenant will not disclose Confidential Information to any third party without the express prior written consent of the Landlord.'
  )

  // ─── ARTICLE 12: LATE PAYMENTS ───
  pw.para('Article 12 — Late Payments', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '12.1 ',
    `Any Monthly Rent not received by Landlord within five (5) days after its due date shall incur a late fee of ${fmtCurrency(lateFee)}.`
  )

  pw.labelPara(
    '12.2 ',
    `An additional fee of ${fmtCurrency(lateFeePerDay)} per day shall accrue for each day the payment remains outstanding beyond the tenth (10th) day after the due date.`
  )

  pw.labelPara(
    '12.3 ',
    'Landlord reserves the right to pursue all available legal remedies for collection of unpaid amounts.'
  )

  // ─── ARTICLE 13: DEFAULT AND REMEDIES ───
  pw.para('Article 13 — Default and Remedies', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '13.1 ',
    'The occurrence of any of the following shall constitute a default by Tenant:'
  )

  const defaults = [
    'Failure to pay Rent or any other sum due hereunder within fifteen (15) days after written notice of non-payment.',
    'Failure to perform or comply with any other term or condition of this Agreement within thirty (30) days after written notice specifying the nature of the default.',
    'The filing of a petition in bankruptcy by or against Tenant, or the appointment of a receiver for Tenant\'s assets.',
    'Abandonment of the Premises.',
    'Conducting any illegal activity on the Premises.',
    'Any act or omission that causes material damage to the Premises or building.',
    'Tenant becomes a nuisance negatively affecting other tenants\' ability to conduct business.',
  ]

  for (let i = 0; i < defaults.length; i++) {
    pw.para(`(${String.fromCharCode(97 + i)}) ${defaults[i]}`, { indent: 20, spaceAfter: 4 })
  }

  pw.labelPara(
    '13.2 ',
    'Upon the occurrence of a default, Landlord may, at its option: (a) terminate this Agreement upon written notice to Tenant; (b) re-enter and take possession of the Premises; and/or (c) pursue any and all remedies available at law or in equity.'
  )

  // ─── ARTICLE 14: TERMINATION ───
  pw.para('Article 14 — Termination', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.labelPara(
    '14.1 ',
    'Either Party may terminate this Agreement by providing the other Party with at least thirty (30) days prior written notice.'
  )

  pw.labelPara(
    '14.2 ',
    'Upon termination, Tenant shall vacate the Premises, remove all personal property, and return the Premises in the same condition as received, ordinary wear and tear excepted.'
  )

  // ─── ARTICLE 15: NOTICE ───
  pw.para('Article 15 — Notice', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.para(
    'All notices required or permitted under this Agreement shall be in writing and shall be deemed delivered when sent by email, certified mail, or hand-delivered to the addresses set forth above or to such other address as either Party may designate in writing.'
  )

  // ─── ARTICLE 16: ATTORNEY'S FEES ───
  pw.para("Article 16 — Attorney's Fees", { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.para(
    "In the event of any legal action arising out of or relating to this Agreement, the prevailing party shall be entitled to recover its reasonable attorney's fees and costs from the non-prevailing party."
  )

  // ─── ARTICLE 17: GOVERNING LAW ───
  pw.para('Article 17 — Governing Law and Jurisdiction', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.para(
    'This Agreement shall be governed by and construed in accordance with the laws of the State of Florida. Any legal action or proceeding arising under this Agreement shall be brought exclusively in the courts of Pinellas County, Florida.'
  )

  // ─── ARTICLE 18: ENTIRE AGREEMENT ───
  pw.para('Article 18 — Entire Agreement', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.para(
    'This Agreement constitutes the entire agreement between the Parties and supersedes all prior negotiations, representations, warranties, commitments, and agreements. This Agreement may not be modified except by a written instrument signed by both Parties.'
  )

  // ─── ARTICLE 19: SEVERABILITY ───
  pw.para('Article 19 — Severability', { font: pw.fontBold, size: 12, spaceAfter: 6 })

  pw.para(
    'If any provision of this Agreement is held to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.'
  )

  // ═══════════════════════════════════════════════════════
  // SIGNATURE PAGE
  // ═══════════════════════════════════════════════════════
  pw.checkSpace(280)
  pw.rule()
  pw.space(10)

  pw.para(
    'IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date written above.',
    { font: pw.fontBold, size: 11, spaceAfter: 30 }
  )

  // Two-column signatures
  const leftX = pw.margin
  const rightX = pw.pageWidth / 2 + 20
  const sigW = 200

  // ─── LANDLORD column ───
  pw.page.drawText('LANDLORD', {
    x: leftX,
    y: pw.y,
    size: 10,
    font: pw.fontBold,
    color: C.dark,
  })
  pw.page.drawText('TENANT', {
    x: rightX,
    y: pw.y,
    size: 10,
    font: pw.fontBold,
    color: C.dark,
  })
  pw.y -= 16

  pw.page.drawText(landlordName, {
    x: leftX,
    y: pw.y,
    size: 11,
    font: pw.fontBold,
    color: C.dark,
  })
  pw.page.drawText(data.tenantCompany, {
    x: rightX,
    y: pw.y,
    size: 11,
    font: pw.fontBold,
    color: C.dark,
  })
  pw.y -= 30

  // Signature lines
  const sigY = pw.y
  pw.page.drawText('By:', {
    x: leftX,
    y: sigY,
    size: 10,
    font: pw.font,
    color: C.medium,
  })
  pw.page.drawRectangle({ x: leftX + 20, y: sigY - 2, width: sigW - 20, height: 0.5, color: C.rule })

  pw.page.drawText('By:', {
    x: rightX,
    y: sigY,
    size: 10,
    font: pw.font,
    color: C.medium,
  })
  pw.page.drawRectangle({ x: rightX + 20, y: sigY - 2, width: sigW - 20, height: 0.5, color: C.rule })

  pw.y -= 28

  // Print Name
  const nameY = pw.y
  pw.page.drawText('Print Name:', {
    x: leftX,
    y: nameY,
    size: 9,
    font: pw.font,
    color: C.light,
  })
  pw.page.drawText(landlordSigner, {
    x: leftX + 62,
    y: nameY,
    size: 10,
    font: pw.fontBold,
    color: C.dark,
  })

  pw.page.drawText('Print Name:', {
    x: rightX,
    y: nameY,
    size: 9,
    font: pw.font,
    color: C.light,
  })
  pw.page.drawText(data.tenantContactName, {
    x: rightX + 62,
    y: nameY,
    size: 10,
    font: pw.fontBold,
    color: C.dark,
  })
  pw.y -= 20

  // Title
  const titleY = pw.y
  pw.page.drawText('Title:', {
    x: leftX,
    y: titleY,
    size: 9,
    font: pw.font,
    color: C.light,
  })
  pw.page.drawText(landlordTitle, {
    x: leftX + 30,
    y: titleY,
    size: 10,
    font: pw.font,
    color: C.dark,
  })

  pw.page.drawText('Title:', {
    x: rightX,
    y: titleY,
    size: 9,
    font: pw.font,
    color: C.light,
  })
  pw.page.drawText(tenantTitle, {
    x: rightX + 30,
    y: titleY,
    size: 10,
    font: pw.font,
    color: C.dark,
  })
  pw.y -= 20

  // Date lines
  const dateY = pw.y
  pw.page.drawText('Date:', {
    x: leftX,
    y: dateY,
    size: 9,
    font: pw.font,
    color: C.light,
  })
  pw.page.drawRectangle({ x: leftX + 30, y: dateY - 2, width: sigW - 30, height: 0.5, color: C.rule })

  pw.page.drawText('Date:', {
    x: rightX,
    y: dateY,
    size: 9,
    font: pw.font,
    color: C.light,
  })
  pw.page.drawRectangle({ x: rightX + 30, y: dateY - 2, width: sigW - 30, height: 0.5, color: C.rule })

  // Final page footer
  pw.drawPageFooter()

  return doc.save()
}
