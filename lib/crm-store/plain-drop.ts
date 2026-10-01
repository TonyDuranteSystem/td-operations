/**
 * "A normal storage" for the firm's own areas — Business and a staff member's My files (Antonio 2026-10-01: "I don't want My files and
 * Business to be strict like the client one … I want a normal storage"). PURE helpers for the drop / upload of files and whole
 * folders there: no document type, no "name shown", no "show to client", no per-drop file limit. Client companies and people keep
 * their strict upload (their files need a type, a year, a filing answer …).
 */

export const INTERNAL_OWNER_KINDS = new Set(["business", "private"])
export const isInternalOwnerKind = (kind: string | null | undefined): boolean => !!kind && INTERNAL_OWNER_KINDS.has(kind)

/** Google Drive for desktop shows a Google Doc / Sheet / Slide as a tiny pointer file (.gdoc …) — the pointer is not the document. */
const GOOGLE_POINTER = /\.(gdoc|gsheet|gslides|gform|gdraw|gmap|gsite|gjam|gscript|glink|gtable)$/i
/** Junk the operating system adds to folders. */
const SYSTEM_JUNK = /^(\.ds_store|thumbs\.db|desktop\.ini|icon\r?)$/i

export interface PlainItem { file: File; path: string[] }
export interface PlainSkipped { name: string; why: string }

/** What a plain drop will upload, and what it leaves out (said plainly, never silently). */
export function filterPlainDrop(found: PlainItem[]): { items: PlainItem[]; skipped: PlainSkipped[] } {
  const items: PlainItem[] = []
  const skipped: PlainSkipped[] = []
  for (const it of found) {
    const name = it.file.name
    if (GOOGLE_POINTER.test(name)) skipped.push({ name: [...it.path, name].join(" › "), why: "A Google Docs shortcut — it only points to the document on Google Drive, it is not the document itself." })
    else if (SYSTEM_JUNK.test(name) || name.startsWith("._")) { /* system junk: dropped without a word */ }
    else items.push(it)
  }
  return { items, skipped }
}

/** The distinct folders a drop will make (every level), for the summary line. */
export function folderCount(items: PlainItem[]): number {
  const seen = new Set<string>()
  for (const it of items) for (let i = 1; i <= it.path.length; i++) seen.add(it.path.slice(0, i).join("/"))
  return seen.size
}

/** A folder picked with the browser's "choose a folder" box: webkitRelativePath = "Top/sub/file.pdf" → the path without the file name. */
export function itemsFromFileList(files: Array<{ file: File; relative?: string | null }>): PlainItem[] {
  return files.map(({ file, relative }) => {
    const parts = (relative ?? "").split("/").filter(Boolean)
    return { file, path: parts.length > 1 ? parts.slice(0, -1) : [] }
  })
}

/** How many files are uploaded at the same time. */
export const PLAIN_CONCURRENCY = 3

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
