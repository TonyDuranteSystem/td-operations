import { formatOwnerCurrency } from '@/lib/owner-finance'
import type { OwnerFinancialsExportInput } from '@/lib/owner-finance-export'

/**
 * Builds the two "clean, presentable" financial-statement PDFs — Profit & Loss and Balance
 * Sheet — as HTML, styled to print like the ones actually sent to the accountant on
 * 2026-09-01 (built then by hand via `.books-scratch/make-statements.mjs`, which rendered
 * this same kind of HTML with a full desktop browser).
 *
 * Split deliberately from the rendering step (renderHtmlToPdf, below): this half is a PURE
 * string-building function, unit-testable without a real browser. Only renderHtmlToPdf
 * needs Chromium, and only that needs a live serverless environment to prove out.
 */

const nice = (key: string) => key.split('/').pop()!.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

const CSS = `
  @page { size: Letter; margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: "Times New Roman", Times, serif; color: #000; background: #fff;
         font-size: 10.5pt; line-height: 1.45; margin: 0; }
  .head { text-align: center; margin-bottom: 22pt; }
  .co { font-size: 15pt; font-weight: bold; letter-spacing: .01em; }
  .ti { font-size: 12.5pt; margin-top: 3pt; }
  .su { font-size: 9.5pt; margin-top: 2pt; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2.4pt 0; vertical-align: baseline; }
  td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums;
         width: 26%; padding-left: 10pt; }
  tr.grp td { font-weight: bold; padding-top: 11pt; }
  tr.ind td:first-child { padding-left: 14pt; }
  tr.ind2 td:first-child { padding-left: 28pt; }
  tr.sub td { border-top: .5pt solid #000; font-weight: bold; }
  tr.tot td { border-top: .5pt solid #000; border-bottom: 2.5pt double #000; font-weight: bold; }
  tr.sp td { height: 6pt; padding: 0; }
  .notes { margin-top: 24pt; border-top: .5pt solid #000; padding-top: 8pt; font-size: 8.75pt; }
  .notes h4 { margin: 0 0 5pt; font-size: 9pt; }
  .notes ol { margin: 0; padding-left: 14pt; }
  .notes li { margin-bottom: 4pt; }
  .flag { border: .75pt solid #000; padding: 7pt 9pt; margin-top: 14pt; font-size: 9pt; }
  .foot { margin-top: 20pt; font-size: 8.25pt; color: #333; border-top: .5pt solid #999; padding-top: 6pt; }
`

const head = (title: string, sub: string) => `
<div class="head">
  <div class="co">TONY DURANTE LLC</div>
  <div class="ti">${title}</div>
  <div class="su">${sub}</div>
</div>`

const row = (label: string, amount: number | null, cls = '', currency = 'USD') =>
  `<tr class="${cls}"><td>${label}</td><td class="n">${amount === null ? '' : formatOwnerCurrency(amount, currency, { minimumFractionDigits: 2 })}</td></tr>`

const wrap = (title: string, sub: string, body: string, notesFooter: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
${head(title, sub)}
<table>${body}</table>
${notesFooter}
</body></html>`

export function buildProfitAndLossHtml(input: OwnerFinancialsExportInput): string {
  const { pnl, filing, year } = input

  const sections = pnl.blocks.map(block => {
    const suffix = block.currency === 'USD' ? '' : ` (${block.currency})`
    const revenue = block.invoice_income + block.other_income
    const catLines = Object.entries(block.by_subcategory).sort((a, b) => b[1] - a[1])
    const cogsLines = catLines.filter(([k]) => k.startsWith('cogs/'))
    const opLines = catLines.filter(([k]) => !k.startsWith('cogs/'))

    let html = `
      <tr class="grp"><td>REVENUE${suffix}</td><td class="n"></td></tr>
      ${row('Client services (invoice ledger)', block.invoice_income, 'ind', block.currency)}
      ${block.other_income !== 0 ? row('Other income', block.other_income, 'ind', block.currency) : ''}
      ${row('Total revenue', revenue, 'sub', block.currency)}
      <tr class="sp"><td colspan="2"></td></tr>`

    if (cogsLines.length > 0) {
      html += `
      <tr class="grp"><td>COST OF SERVICES${suffix}</td><td class="n"></td></tr>
      ${cogsLines.map(([k, v]) => row(nice(k), v, 'ind', block.currency)).join('')}
      ${row('Total cost of services', block.cogs, 'sub', block.currency)}
      ${row('GROSS PROFIT', revenue - block.cogs, 'sub', block.currency)}
      <tr class="sp"><td colspan="2"></td></tr>`
    }

    html += `
      <tr class="grp"><td>OPERATING EXPENSES${suffix}</td><td class="n"></td></tr>
      ${opLines.map(([k, v]) => row(nice(k), v, 'ind', block.currency)).join('')}
      ${row('Total operating expenses', block.expenses, 'sub', block.currency)}
      <tr class="sp"><td colspan="2"></td></tr>
      ${row(`NET PROFIT PER BOOKS${suffix}`, block.net_profit, 'tot', block.currency)}
      <tr class="sp"><td colspan="2"></td></tr>`
    return html
  }).join('')

  const adjustmentsHtml = `
    <tr class="grp"><td>ADJUSTMENTS FOR TAX PURPOSES</td><td class="n"></td></tr>
    ${filing.adjustments.map(a => row(a.label, a.amount, 'ind')).join('')}
    ${row('ORDINARY BUSINESS INCOME (USD)', filing.taxable_income, 'tot')}
  `

  const notes = `
<div class="notes">
  <h4>Notes</h4>
  <ol>
    <li>Prepared on the <b>cash basis</b>. Revenue is recognised when received; costs when paid.</li>
    <li>Each currency is shown in its own section and never combined with another — the ordinary
        business income line above applies the year's tax adjustments and, where the books hold a
        rate the company actually achieved converting a currency to dollars, converts it there.</li>
    ${filing.warnings.length > 0 ? filing.warnings.map(w => `<li><b>Needs attention:</b> ${w}</li>`).join('') : ''}
  </ol>
</div>
<div class="foot">Tony Durante LLC · Prepared ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>`

  return wrap(
    'Statement of Profit and Loss',
    `For the year ended 31 December ${year} &nbsp;·&nbsp; Cash basis`,
    sections + adjustmentsHtml,
    notes,
  )
}

export function buildBalanceSheetHtml(input: OwnerFinancialsExportInput): string {
  const { balanceSheet: bs, year } = input

  if (!bs.can_state) {
    const body = `<tr><td colspan="2">A complete balance sheet cannot be stated for ${year} — the account records available do not cover the full year.</td></tr>`
    const notes = bs.notes.length > 0
      ? `<div class="notes"><h4>Notes</h4><ol>${bs.notes.map(n => `<li>${n}</li>`).join('')}</ol></div>`
      : ''
    return wrap('Balance Sheet', `As at 31 December ${year} &nbsp;·&nbsp; Cash basis`, body, notes)
  }

  const totalCash = bs.cash.reduce((s, l) => s + l.amount, 0)
  const body = `
    <tr class="grp"><td>ASSETS</td><td class="n"></td></tr>
    <tr class="ind"><td><b>Cash and cash equivalents</b></td><td class="n"></td></tr>
    ${bs.cash.map(l => row(l.label, l.amount, 'ind2', bs.currency)).join('')}
    ${row('Total cash and cash equivalents', totalCash, 'sub', bs.currency)}
    <tr class="sp"><td colspan="2"></td></tr>
    ${bs.other_assets.length > 0 ? `
      <tr class="ind"><td><b>Other assets</b></td><td class="n"></td></tr>
      ${bs.other_assets.map(l => row(l.label, l.amount, 'ind2', bs.currency)).join('')}
    ` : ''}
    ${row('TOTAL ASSETS', bs.total_assets, 'sub', bs.currency)}
    <tr class="sp"><td colspan="2"></td></tr>
    <tr class="grp"><td>LIABILITIES</td><td class="n"></td></tr>
    ${bs.liabilities.map(l => row(l.label, l.amount, 'ind', bs.currency)).join('')}
    ${row('TOTAL LIABILITIES', bs.total_liabilities, 'sub', bs.currency)}
    <tr class="sp"><td colspan="2"></td></tr>
    ${row("MEMBERS' EQUITY (DEFICIT)", bs.equity, 'tot', bs.currency)}
    ${bs.foreign.length > 0 ? `
      <tr class="sp"><td colspan="2"></td></tr>
      <tr class="grp"><td>HELD IN OTHER CURRENCIES — not included above</td><td class="n"></td></tr>
      ${bs.foreign.map(f => row(f.label, f.amount, 'ind', f.currency)).join('')}
    ` : ''}
  `

  const notes = bs.notes.length > 0
    ? `<div class="notes"><h4>Notes</h4><ol>${bs.notes.map(n => `<li>${n}</li>`).join('')}
        <li>Every balance above is the closing figure from the account's own statement or provider
            report, not a derived or plugged number.</li>
        <li>Credit-card and loan balances are amounts owed and are shown as liabilities, never netted
            against cash.</li>
       </ol></div>
       <div class="foot">Tony Durante LLC · Prepared ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>`
    : ''

  return wrap('Balance Sheet', `As at 31 December ${year} &nbsp;·&nbsp; Cash basis &nbsp;·&nbsp; ${bs.currency}`, body, notes)
}

/**
 * Renders HTML to PDF bytes using a serverless-packaged Chromium build. NOT unit-testable —
 * the bundled binary only runs on the Linux serverless environment this deploys to, not a
 * developer's own machine (confirmed: fails with a spawn error on macOS). This function is
 * exercised only by actually calling the route once it's live.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const [{ default: chromium }, { default: puppeteer }] = await Promise.all([
    import('@sparticuz/chromium'),
    import('puppeteer-core'),
  ])

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    const pdf = await page.pdf({ format: 'Letter', printBackground: true })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}
