/**
 * Client iPhone app — the screen's name in the top row (pure; dev job 056a70d0, Step 3).
 *
 * The app's server answer lists every entry the person can open with its words in their language and its link. A screen that draws its
 * name in the top row (instead of its own big heading) takes the name of the entry whose link is the longest match for the address.
 * Only the screens in `TITLE_IN_ROW` do this; every other screen keeps drawing its own heading and gets no name here, so a name is never shown twice.
 */
export interface AppMenuItem { key: string; path: string; label: string }

/** Screens whose own heading is hidden in the app and drawn in the top row instead. Grows as screens are dressed for the app. */
export const TITLE_IN_ROW: readonly string[] = ['/portal/chat']

/**
 * Same, but only for exactly this address, not for the pages under it: `/portal/invoices/new` and an invoice's own page still draw their
 * own heading. On `/portal/invoices` the address word `tab=billing` is the TD Billing screen, which takes the name of the TD Billing entry.
 */
export const TITLE_IN_ROW_EXACT: readonly string[] = ['/portal/invoices']
const BILLING_ENTRY_KEY = 'nav.tdBilling'

function pathOnly(href: string): string {
  const i = href.search(/[?#]/)
  return i === -1 ? href : href.slice(0, i)
}

/** The screens' own plain names in the person's language, used when the app's server answer is not there (offline, a blip, the switch off). */
export interface ScreenLabels { invoices?: string; billing?: string; chat?: string }

export function screenTitleFor(pathname: string, items: readonly AppMenuItem[], tab?: string | null, labels?: ScreenLabels): string | null {
  const here = pathOnly(pathname)
  if (here === '/portal/invoices') {
    if (tab === 'billing') return items.find(it => it.key === BILLING_ENTRY_KEY)?.label ?? labels?.billing ?? null
    // The menu entry says "Customers & Invoices" when the website's invoicing hub is on; the app's screen is named plainly "Invoices"
    // (the approved design), with "Customers and invoices · <company>" under it.
    return labels?.invoices ?? items.find(it => it.key === 'nav.invoices')?.label ?? null
  }
  const inRow = TITLE_IN_ROW.some(p => here === p || here.startsWith(`${p}/`))
  if (!inRow) return null
  let best: AppMenuItem | null = null
  for (const it of items) {
    const p = pathOnly(it.path)
    if (p === '/portal') continue
    if (here === p || here.startsWith(`${p}/`)) {
      if (!best || p.length > pathOnly(best.path).length) best = it
    }
  }
  if (best) return best.label
  return (here === '/portal/chat' || here.startsWith('/portal/chat/')) ? labels?.chat ?? null : null
}
