/**
 * Bank of America intake — the form's fields, document slots, and the pure server-side
 * validation. Client-safe (no server imports): the public page and the submit route share it,
 * so what the page marks "Required" is exactly what the server enforces.
 */

export const BOFA_BUCKET = "bofa-intake-uploads"
export const BOFA_MAX_FILE_BYTES = 10 * 1024 * 1024
export const BOFA_ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"]

export interface BofaDocSlot {
  key: string
  label: string
  hint?: string
  required: boolean
}

export const BOFA_DOC_SLOTS: BofaDocSlot[] = [
  { key: "passport", label: "Passport photo page", required: true },
  { key: "proof_of_address", label: "Proof of home address", hint: "A utility bill or bank statement showing your name and address.", required: true },
  { key: "business_registration", label: "Business registration", hint: "Articles of Organization or Certificate of Formation.", required: true },
  { key: "ein_letter", label: "EIN confirmation letter", hint: "The IRS letter that shows the company's EIN.", required: true },
  { key: "itin_letter", label: "ITIN letter", hint: "The IRS notice that shows your ITIN.", required: true },
  { key: "lease", label: "Lease agreement", hint: "A signed lease for the company address. A virtual office will not be accepted.", required: true },
  { key: "other", label: "Anything else the bank asked for", required: false },
]

export const BOFA_MONTHLY_DEPOSITS = [
  "Under $5,000",
  "$5,000 to $25,000",
  "$25,000 to $100,000",
  "Over $100,000",
] as const

/** Text fields: key -> label + whether required. Address groups are split into five fields each. */
export const BOFA_TEXT_FIELDS: { key: string; label: string; required: boolean }[] = [
  { key: "full_name", label: "Full legal name", required: true },
  { key: "email", label: "Email", required: true },
  { key: "phone", label: "Phone", required: true },
  { key: "citizenship", label: "Citizenship", required: true },
  { key: "itin", label: "ITIN", required: true },
  { key: "home_street", label: "Home address: street", required: true },
  { key: "home_city", label: "Home address: city", required: true },
  { key: "home_region", label: "Home address: region / province", required: true },
  { key: "home_zip", label: "Home address: zip code", required: true },
  { key: "home_country", label: "Home address: country", required: true },
  { key: "company_name", label: "Company name", required: true },
  { key: "ein", label: "EIN", required: true },
  { key: "state_of_formation", label: "State of formation", required: true },
  { key: "company_street", label: "Company address: street", required: true },
  { key: "company_city", label: "Company address: city", required: true },
  { key: "company_region", label: "Company address: state / region", required: true },
  { key: "company_zip", label: "Company address: zip code", required: true },
  { key: "company_country", label: "Company address: country", required: true },
  { key: "website", label: "Website or social page", required: false },
  { key: "business_description", label: "Describe your business", required: true },
  { key: "customers", label: "Who are your customers?", required: true },
  { key: "revenue_model", label: "How does the company make money?", required: true },
  { key: "monthly_deposits", label: "Expected monthly deposits", required: true },
  { key: "first_deposit_source", label: "Source of the first deposit", required: true },
]

export const BOFA_MAX_TEXT = 4000

export interface BofaFileRef {
  key: string
  name: string
  path: string
}

export type BofaValidation =
  | { ok: true; data: Record<string, string>; files: BofaFileRef[] }
  | { ok: false; error: string }

export function isAllowedMime(mime: string): boolean {
  return BOFA_ALLOWED_MIME.includes(mime.toLowerCase())
}

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
}

/**
 * Some browsers (Windows Chrome, some Android) report an empty type for .heic/.heif photos.
 * When the browser gave no type, fall back to the file extension; a declared type always wins.
 */
export function effectiveMime(fileName: string, declared: string): string {
  if (declared) return declared
  const ext = fileName.toLowerCase().split(".").pop() ?? ""
  return EXT_MIME[ext] ?? ""
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "")
  return (cleaned || "file").slice(0, 80)
}

/** Storage keys reject spaces and odd characters, so the path is built only from safe parts. */
export function buildUploadPath(token: string, slotKey: string, uuid: string, fileName: string): string {
  return `${token}/${slotKey}/${uuid}-${safeFileName(fileName)}`
}

/** A path is acceptable for a link only if it sits under that link's own token and a known slot. */
export function pathBelongsToLink(path: string, token: string, slotKey: string): boolean {
  const prefix = `${token}/${slotKey}/`
  return path.startsWith(prefix) && !path.includes("..") && path.length > prefix.length
}

export function validateSubmission(
  rawData: unknown,
  rawFiles: unknown,
  token: string,
): BofaValidation {
  if (!rawData || typeof rawData !== "object") return { ok: false, error: "The form is empty." }
  const src = rawData as Record<string, unknown>
  const data: Record<string, string> = {}

  for (const f of BOFA_TEXT_FIELDS) {
    const v = typeof src[f.key] === "string" ? (src[f.key] as string).trim() : ""
    if (!v && f.required) return { ok: false, error: `${f.label} is required.` }
    if (v.length > BOFA_MAX_TEXT) return { ok: false, error: `${f.label} is too long.` }
    data[f.key] = v
  }

  const email = data.email
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address." }
  if (!(BOFA_MONTHLY_DEPOSITS as readonly string[]).includes(data.monthly_deposits)) {
    return { ok: false, error: "Choose an expected monthly deposits range." }
  }

  if (!Array.isArray(rawFiles)) return { ok: false, error: "Documents are missing." }
  if (rawFiles.length > BOFA_DOC_SLOTS.length) return { ok: false, error: "Too many documents." }
  const files: BofaFileRef[] = []
  for (const item of rawFiles) {
    if (!item || typeof item !== "object") return { ok: false, error: "A document entry is not valid." }
    const { key, name, path } = item as Record<string, unknown>
    if (typeof key !== "string" || typeof name !== "string" || typeof path !== "string") {
      return { ok: false, error: "A document entry is not valid." }
    }
    const slot = BOFA_DOC_SLOTS.find((s) => s.key === key)
    if (!slot) return { ok: false, error: "A document entry is not valid." }
    if (!pathBelongsToLink(path, token, key)) return { ok: false, error: "A document entry is not valid." }
    if (files.some((f) => f.key === key)) return { ok: false, error: "Upload one document per box." }
    files.push({ key, name: name.slice(0, 200), path })
  }
  for (const slot of BOFA_DOC_SLOTS) {
    if (slot.required && !files.some((f) => f.key === slot.key)) {
      return { ok: false, error: `${slot.label} is required.` }
    }
  }

  return { ok: true, data, files }
}
