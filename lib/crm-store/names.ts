/**
 * CRM Store — the naming rules, ONE copy shared by the server (lib/crm-store/structure.ts, file-actions.ts)
 * and the storage screens (components/storage/*). Pure, no database, safe in the browser.
 */

// eslint-disable-next-line no-control-regex -- control characters are what the store refuses
const BAD_FOLDER_CHARS = /[\\/\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex -- control characters are what the store refuses
const BAD_FILE_CHARS = /[\\/\u0000-\u001f\u007f]/g

/** The store's folder-name rules, checked BEFORE saving so staff get a plain message (throws). */
export function cleanFolderName(input: string): string {
  if (BAD_FOLDER_CHARS.test(input)) throw new Error("A folder name can't contain / or \\.")
  const n = input.replace(/\s+/g, " ").trim()
  if (!n) throw new Error("Enter a folder name.")
  if (n.length > 255) throw new Error("That name is too long (255 characters at most).")
  return n
}

/** The same rules as a message for the screen (null = fine), plus "not the same name as a folder next to it". */
export function folderNameProblem(value: string, siblings: string[]): string | null {
  let n: string
  try { n = cleanFolderName(value) } catch (e) { return e instanceof Error ? e.message : "Enter a folder name." }
  if (siblings.some((s) => s.trim().toLowerCase() === n.toLowerCase())) return `"${n}" already exists here.`
  return null
}

/** The year to suggest for "New tax year" — the most recent year without a folder, starting last year. */
export function suggestTaxYear(existing: string[], now = new Date()): string {
  const have = new Set(existing.filter((n) => /^\d{4}$/.test(n)))
  for (let y = now.getFullYear() - 1; y >= now.getFullYear() - 10; y--) if (!have.has(String(y))) return String(y)
  return String(now.getFullYear())
}

export function extensionOf(name: string): string {
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(name)
  return m ? m[0] : ""
}

/** A new file name typed by staff: / \ and control characters → "-", the original extension kept (throws). */
export function cleanNewFileName(input: string, currentName: string): string {
  let n = input.replace(BAD_FILE_CHARS, "-").replace(/\s+/g, " ").trim()
  const ext = extensionOf(currentName)
  if (ext && !n.toLowerCase().endsWith(ext.toLowerCase())) n = `${n}${ext}`
  if (!n || n === ext) throw new Error("Enter a file name.")
  if (n.length > 255) throw new Error("That name is too long.")
  return n
}

/** The name an upload will be saved under: the "Name shown" box (cleaned, extension kept) or the file's own name. */
export function finalUploadName(fileName: string, shown: string): string {
  if (!shown.trim()) return fileName
  try { return cleanNewFileName(shown, fileName) } catch { return fileName }
}

/** "Keep both" suggestion — "Invoice.pdf" → "Invoice (2).pdf", skipping names already taken. */
export function keepBothName(name: string, taken: string[]): string {
  const ext = extensionOf(name)
  const base = ext ? name.slice(0, -ext.length) : name
  const lower = new Set(taken.map((t) => t.toLowerCase()))
  for (let i = 2; i < 1000; i++) {
    const n = `${base} (${i})${ext}`
    if (!lower.has(n.toLowerCase())) return n
  }
  return `${base} (copy)${ext}`
}
