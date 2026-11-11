/**
 * The file name used INSIDE a temporary upload path (`flow-uploads/<id>/<time>_<name>` and its siblings in the `onboarding-uploads` bucket).
 *
 * Why this exists: the storage service refuses a key containing "%", "?", "#", accents, Japanese letters and other characters outside plain
 * ASCII ("Bad Request" / "The file could not be saved to storage"), so a state confirmation named `Ricevuta città 50%.pdf` could never be uploaded
 * by staff (production end-to-end test 2026-11-10, finding F8). Only the temporary KEY is cleaned — the file keeps its real name for the
 * CRM row and the stored copy (the real name travels separately as `file_name`).
 *
 * Accents are reduced to their base letter first so the temporary name stays readable ("città" → "citta"); anything else that is not a plain
 * letter, digit, dot, dash or underscore becomes "_". The extension always survives (the tail is kept when the name is cut), and a name that
 * is nothing but unusable characters becomes "file" + its extension.
 *
 * Pure — no I/O.
 */
export function stagingFileName(name: string, maxLength = 120): string {
  const raw = String(name ?? "")
  const dot = raw.lastIndexOf(".")
  const extRaw = dot > 0 && dot >= raw.length - 12 ? raw.slice(dot) : ""
  const baseRaw = extRaw ? raw.slice(0, dot) : raw

  const clean = (s: string): string =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "")

  const ext = clean(extRaw.slice(1)) // without the dot
  const base = clean(baseRaw) || "file"
  const suffix = ext ? `.${ext}` : ""
  const room = Math.max(1, maxLength - suffix.length)
  // keep the END of a long name: it is the part that tells files apart ("…_page_2")
  const trimmed = base.length > room ? base.slice(base.length - room) : base
  return `${trimmed}${suffix}`
}
