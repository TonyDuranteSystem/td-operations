/**
 * Passport OCR → contact writeback.
 *
 * Shared between onboarding-setup and formation-setup so every handler
 * that uploads a passport also extracts and stores passport_number /
 * passport_expiry_date / date_of_birth on the contact record.
 *
 * Before 2026-04-18 (dev_task 3274fdf6) only formation-setup did this —
 * onboarding-setup uploaded the passport to Drive, ran OCR in the
 * cross-check pass, and discarded the parsed data. Result: 96 contacts
 * with passport_on_file=true but no extracted passport fields.
 *
 * Exposed as one helper so callers only push a single step row and we
 * keep the OCR + parse + write logic in one place.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { ocrDriveFile, ocrRawContent } from "@/lib/docai"
import { parsePassportFromOcr } from "@/lib/passport-processing"

const OCR_SUPPORTED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/gif",
  "image/bmp",
  "image/webp",
  "image/heic", // iPhone photos — converted to JPEG inside the OCR reader (lib/docai.ts)
  "image/heif",
])

const norm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]+/g, " ").trim()

/** Does the name read from a passport belong to this person? Order-free, accent-free; two shared name parts (or the only part there is). */
export function passportNameMatchesPerson(passportName: string | null | undefined, personName: string | null | undefined): boolean {
  const a = new Set(norm(passportName ?? "").split(" ").filter((t) => t.length >= 2))
  const b = new Set(norm(personName ?? "").split(" ").filter((t) => t.length >= 2))
  if (a.size === 0 || b.size === 0) return false
  let shared = 0
  a.forEach((t) => { if (b.has(t)) shared++ })
  return shared >= Math.min(2, a.size, b.size)
}

export interface PassportWritebackResult {
  status: "ok" | "skipped" | "error"
  detail: string
  /** Field names that landed on the contact (empty if skipped/error). */
  extracted_fields: string[]
  /** True when the mime type is unsupported and we created a manual task
   *  instead. Callers that also want to log a `doc_copy` step should use
   *  this to avoid double-logging. */
  manual_task_created?: boolean
}

export interface PassportWritebackParams {
  contact_id: string
  /** Where the passport is: a Drive file id, OR its bytes in `content` (CRM Store pilot — no Drive copy). */
  drive_file_id?: string | null
  content?: ArrayBuffer | null
  file_name?: string | null
  mime_type: string
  /** If the wizard already captured DOB explicitly, skip overwriting it
   *  from MRZ (wizard is more authoritative — the client typed it). */
  skip_dob?: boolean
  /** For the manual-task description when mime isn't OCR-supported. */
  contact_name?: string
  account_id?: string | null
}

export async function extractAndStorePassportData(
  params: PassportWritebackParams,
): Promise<PassportWritebackResult> {
  const { contact_id, drive_file_id, content, file_name, mime_type, skip_dob, contact_name, account_id } = params

  // Unsupported format (HEIC, etc.) — create a task for manual entry.
  if (!OCR_SUPPORTED_MIMES.has(mime_type)) {
    try {
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      await supabaseAdmin.from("tasks").insert({
        task_title: `Manual passport data entry: ${contact_name || contact_id}`,
        description: `Passport uploaded as ${mime_type} (not supported by OCR). Manually enter passport_number and passport_expiry_date on the contact record.`,
        assigned_to: "Luca",
        category: "Document",
        priority: "Normal",
        status: "To Do",
        ...(account_id ? { account_id } : {}),
        contact_id,
      })
    } catch {
      // Non-blocking
    }
    return {
      status: "skipped",
      detail: `Unsupported format for OCR: ${mime_type}. Manual data entry task created.`,
      extracted_fields: [],
      manual_task_created: true,
    }
  }

  try {
    const ocrResult = content
      ? await ocrRawContent(content, mime_type, file_name || "passport")
      : drive_file_id
        ? await ocrDriveFile(drive_file_id)
        : null
    if (!ocrResult) return { status: "skipped", detail: "No passport file to read", extracted_fields: [] }
    if (!ocrResult.fullText) {
      return { status: "ok", detail: "OCR ran but returned no text", extracted_fields: [] }
    }

    const passportData = parsePassportFromOcr(ocrResult.fullText)

    // WHO is this passport? When the name on it is read and the person's name is known, they must match — a passport of another
    // person must never overwrite this person's number / expiry / birth date. A name that cannot be read leaves what is already on
    // the record alone (it only fills fields that are still empty).
    const verified = !!(contact_name && passportData.fullName)
    if (verified && !passportNameMatchesPerson(passportData.fullName, contact_name)) {
      return {
        status: "skipped",
        detail: `The name on the passport (${passportData.fullName}) does not match ${contact_name} — nothing was written to the record`,
        extracted_fields: [],
      }
    }
    let current: { passport_number?: string | null; passport_expiry_date?: string | null; date_of_birth?: string | null } = {}
    if (!verified) {
      const { data: cur } = await supabaseAdmin.from("contacts").select("passport_number, passport_expiry_date, date_of_birth").eq("id", contact_id).maybeSingle()
      current = (cur ?? {}) as typeof current
    }
    const updates: Record<string, unknown> = {}
    if (passportData.passportNumber && (verified || !current.passport_number)) updates.passport_number = passportData.passportNumber
    if (passportData.expiryDate && (verified || !current.passport_expiry_date)) updates.passport_expiry_date = passportData.expiryDate
    if (passportData.dateOfBirth && !skip_dob && (verified || !current.date_of_birth)) updates.date_of_birth = passportData.dateOfBirth

    if (Object.keys(updates).length === 0) {
      return { status: "ok", detail: "OCR ran but no MRZ / visual patterns matched", extracted_fields: [] }
    }

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error: upErr } = await supabaseAdmin
      .from("contacts")
      .update({ ...updates, passport_on_file: true, updated_at: new Date().toISOString() })
      .eq("id", contact_id)

    if (upErr) {
      return { status: "error", detail: upErr.message, extracted_fields: [] }
    }

    return {
      status: "ok",
      detail: `Extracted + stored: ${Object.keys(updates).join(", ")}`,
      extracted_fields: Object.keys(updates),
    }
  } catch (e) {
    return {
      status: "error",
      detail: e instanceof Error ? e.message : String(e),
      extracted_fields: [],
    }
  }
}
