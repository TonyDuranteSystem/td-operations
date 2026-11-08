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

function pathOnly(href: string): string {
  const i = href.search(/[?#]/)
  return i === -1 ? href : href.slice(0, i)
}

export function screenTitleFor(pathname: string, items: readonly AppMenuItem[]): string | null {
  const here = pathOnly(pathname)
  if (!TITLE_IN_ROW.some(p => here === p || here.startsWith(`${p}/`))) return null
  let best: AppMenuItem | null = null
  for (const it of items) {
    const p = pathOnly(it.path)
    if (p === '/portal') continue
    if (here === p || here.startsWith(`${p}/`)) {
      if (!best || p.length > pathOnly(best.path).length) best = it
    }
  }
  return best ? best.label : null
}
