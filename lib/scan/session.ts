/**
 * Scan document: the rules of one scan — page limit, file name, reordering. Pure, so they are tested without a screen.
 */

/** Most pages in one scan (Antonio, 2026-11-10: my suggestion of 20). More makes the PDF slow to send. */
export const MAX_SCAN_PAGES = 20

export const canAddPage = (count: number): boolean => count < MAX_SCAN_PAGES

const pad = (n: number) => String(n).padStart(2, '0')

/** "Scan 2026-11-10 14.32" — today's date and the time (the colon is not allowed in file names on some systems). Local time. */
export function defaultScanName(d: Date): string {
  return `Scan ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
}

/** What the person typed, made safe to be a file name: no folders, no forbidden characters, no ".pdf" twice, at most 80 characters. Empty -> the fallback. */
export function cleanScanName(input: string, fallback: string): string {
  let name = (input ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/(^|\s)\.+(?=\s|$)/g, ' ') // a word made only of dots ("..") is how a folder climb looks
    .replace(/\s+/g, ' ')
    .trim()
  name = name.replace(/(\.pdf)+$/i, '').replace(/^\.+/, '').trim()
  if (name.length > 80) name = name.slice(0, 80).trim()
  return name || fallback
}

/** The file name with its ending. */
export const scanFileName = (name: string): string => `${name}.pdf`

/** A new list with the page at `from` moved to position `to`. Out-of-range moves change nothing. */
export function movePage<T>(list: ReadonlyArray<T>, from: number, to: number): T[] {
  const copy = list.slice()
  if (from < 0 || from >= copy.length || to < 0 || to >= copy.length || from === to) return copy
  const [item] = copy.splice(from, 1)
  copy.splice(to, 0, item)
  return copy
}

/** A new list without the page at `index`. */
export function removePage<T>(list: ReadonlyArray<T>, index: number): T[] {
  if (index < 0 || index >= list.length) return list.slice()
  return list.filter((_, i) => i !== index)
}
