/**
 * "My Google Drive" → My files / Business (Antonio 2026-10-01). Copies from the OWNER's own Drive into the firm's own storage areas —
 * never the other way, never into a client's storage. Pure helpers here; the server copy below is gated by its routes (owners only).
 */
export const MY_DRIVE_MAX_FILE_BYTES = 100 * 1024 * 1024

const FOLDER = "application/vnd.google-apps.folder"
export const isDriveFolder = (mime: string): boolean => mime === FOLDER

/** What a Google-native document becomes when copied (a real, editable file), or why it cannot be copied. */
export function planDriveEntry(mime: string, name: string): { kind: "folder" } | { kind: "binary"; name: string } | { kind: "export"; exportMime: string; name: string } | { kind: "skip"; why: string } {
  if (mime === FOLDER) return { kind: "folder" }
  if (!mime.startsWith("application/vnd.google-apps.")) return { kind: "binary", name }
  const withExt = (ext: string) => (name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`)
  if (mime.endsWith(".document")) return { kind: "export", exportMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: withExt("docx") }
  if (mime.endsWith(".spreadsheet")) return { kind: "export", exportMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: withExt("xlsx") }
  if (mime.endsWith(".presentation")) return { kind: "export", exportMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", name: withExt("pptx") }
  if (mime.endsWith(".drawing")) return { kind: "export", exportMime: "application/pdf", name: withExt("pdf") }
  if (mime.endsWith(".shortcut")) return { kind: "skip", why: "A shortcut to something else on Google Drive — it is not a file." }
  return { kind: "skip", why: "This Google item (form, site, map …) has no file form that can be copied." }
}
