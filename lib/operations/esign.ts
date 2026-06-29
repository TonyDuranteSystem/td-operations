/**
 * E-Sign envelope operations — the callable core behind the staff/portal API
 * routes and the signer flow. Mirrors lib/operations/signature.ts patterns
 * (storage-served PDFs, slug-safe identifiers) but for the multi-tenant esign_*
 * engine: envelopes + per-signer rows + placed fields + an audit trail.
 *
 * Storage layout (existing buckets):
 *   source PDF   → signature-requests / esign/{token}/{fileName}
 *   signer marks → signed-documents   / esign/{token}/sig-{signerId}.png
 *   signed PDF   → signed-documents   / esign/{token}/signed-{ts}.pdf
 */

import { randomBytes, createHash } from "crypto"
import { PDFDocument } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"
import { isValidNormalizedRect } from "@/lib/esign/coordinates"
import { flattenEsignPdf, type FlattenField, type EsignFieldType } from "@/lib/esign/flatten"
import { appendCertificatePage, type CertificateSigner } from "@/lib/esign/certificate"

const SOURCE_BUCKET = "signature-requests"
const SIGNED_BUCKET = "signed-documents"
const DEFAULT_CONSENT_TEXT =
  "I agree to sign electronically (ESIGN/UETA) and that my electronic signature is legally binding."

// The esign_* tables aren't in the generated DB types until the migration is
// promoted + types regenerated; access them through an untyped client, matching
// other deferred-migration call sites (e.g. app/api/signature-request-signed).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** URL-safe high-entropy id. */
function randToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url")
}

export interface EsignFieldInput {
  field_type: EsignFieldType
  page_index: number
  pos_x: number
  pos_y: number
  width: number
  height: number
  required?: boolean
  placeholder?: string | null
  font_size?: number | null
  /** Which signer (by signer_index) fills this field. */
  signer_index: number
}

export interface EsignSignerInput {
  name: string
  email?: string | null
  contact_id?: string | null
  role_label?: string | null
  signing_order?: number | null
}

export interface CreateEsignEnvelopeParams {
  document_name: string
  description?: string | null
  pdfBuffer: Buffer
  fileName: string
  pageCount: number
  fields: EsignFieldInput[]
  signers: EsignSignerInput[]
  owner_account_id?: string | null
  contact_id?: string | null
  origin?: "staff" | "client"
  routing_order?: "sequential" | "parallel"
  created_by?: string
  created_by_contact_id?: string | null
  service_delivery_id?: string | null
  /** Base URL for the signing links. Defaults to APP_BASE_URL (production). The
   *  API route passes the request origin on preview/sandbox so QA links stay on
   *  the same deployment instead of pointing at production. */
  baseUrl?: string | null
  /** Envelope expiry window in days (default 14). */
  expires_in_days?: number
}

export interface CreateEsignEnvelopeResult {
  id: string
  token: string
  access_code: string
  signers: Array<{ id: string; signer_index: number; name: string; email: string | null; token: string; access_code: string; signUrl: string; previewUrl: string }>
}

/**
 * Create a draft envelope from in-memory PDF bytes: store the source, insert the
 * envelope + signer rows + field rows, write a `created` audit event, return the
 * per-signer signing URLs. Status stays `draft` until `send`.
 */
export async function createEsignEnvelope(
  params: CreateEsignEnvelopeParams,
): Promise<CreateEsignEnvelopeResult> {
  const {
    document_name,
    description = null,
    pdfBuffer,
    fileName,
    pageCount,
    fields,
    signers,
    owner_account_id = null,
    contact_id = null,
    origin = "staff",
    routing_order = "sequential",
    created_by = "system",
    created_by_contact_id = null,
    service_delivery_id = null,
    baseUrl = null,
    expires_in_days = 14,
  } = params
  const linkBase = baseUrl || APP_BASE_URL

  if (!signers.length) throw new Error("At least one signer is required.")
  if (!fields.length) throw new Error("At least one field is required.")
  for (const f of fields) {
    if (!isValidNormalizedRect(f)) throw new Error(`Field has invalid coordinates (type ${f.field_type}, page ${f.page_index}).`)
    if (f.signer_index < 0 || f.signer_index >= signers.length) {
      throw new Error(`Field references signer ${f.signer_index} but there are ${signers.length} signers.`)
    }
  }
  // Every signer must have at least one field (can't send a no-op to someone).
  for (let i = 0; i < signers.length; i++) {
    if (!fields.some(f => f.signer_index === i)) {
      throw new Error(`Signer "${signers[i].name}" has no fields assigned.`)
    }
  }

  const token = randToken(18)
  const storagePath = `esign/${token}/${fileName}`
  const { error: uploadError } = await supabaseAdmin.storage
    .from(SOURCE_BUCKET)
    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true })
  if (uploadError) throw new Error(`Could not store the document: ${uploadError.message}`)

  const { data: env, error: envErr } = await db
    .from("esign_envelopes")
    .insert({
      token,
      access_code: randToken(16),
      owner_account_id,
      origin,
      created_by,
      created_by_contact_id,
      contact_id,
      service_delivery_id,
      document_name,
      description,
      pdf_storage_path: storagePath,
      page_count: pageCount,
      routing_order,
      status: "draft",
      total_signers: signers.length,
      expires_at: new Date(Date.now() + (expires_in_days ?? 14) * 86400000).toISOString(),
    } as never)
    .select("id, token, access_code")
    .single()
  if (envErr || !env) throw new Error(`Could not create the envelope: ${envErr?.message || "unknown"}`)

  // Signers — explicit per-signer token + access_code (stronger than DB default).
  const signerRows = signers.map((s, i) => ({
    envelope_id: env.id,
    signer_index: i,
    signing_order: s.signing_order ?? i + 1,
    name: s.name,
    email: s.email ?? null,
    contact_id: s.contact_id ?? null,
    role_label: s.role_label ?? null,
    access_code: randToken(16),
    token: randToken(24),
  }))
  const { data: insertedSigners, error: signersErr } = await db
    .from("esign_signers")
    .insert(signerRows as never)
    .select("id, signer_index, name, email, token, access_code")
  if (signersErr || !insertedSigners) throw new Error(`Could not create signers: ${signersErr?.message || "unknown"}`)

  const byIndex = new Map<number, string>()
  for (const s of insertedSigners as Array<{ id: string; signer_index: number }>) byIndex.set(s.signer_index, s.id)

  const fieldRows = fields.map(f => ({
    envelope_id: env.id,
    signer_id: byIndex.get(f.signer_index) ?? null,
    field_type: f.field_type,
    page_index: f.page_index,
    pos_x: f.pos_x,
    pos_y: f.pos_y,
    width: f.width,
    height: f.height,
    required: f.required ?? true,
    placeholder: f.placeholder ?? null,
    font_size: f.font_size ?? null,
  }))
  const { error: fieldsErr } = await db.from("esign_fields").insert(fieldRows as never)
  if (fieldsErr) throw new Error(`Could not create fields: ${fieldsErr.message}`)

  await db.from("esign_events").insert({
    envelope_id: env.id,
    event_type: "created",
    metadata: { document_name, signer_count: signers.length, field_count: fields.length },
  } as never)

  logAction({
    action_type: "create",
    table_name: "esign_envelopes",
    record_id: env.id,
    account_id: owner_account_id ?? undefined,
    summary: `E-Sign envelope created: ${document_name} (${signers.length} signer(s))`,
  })

  const signerList = (insertedSigners as Array<{ id: string; signer_index: number; name: string; email: string | null; token: string; access_code: string }>)
    .sort((a, b) => a.signer_index - b.signer_index)
    .map(s => ({
      id: s.id,
      signer_index: s.signer_index,
      name: s.name,
      email: s.email,
      token: s.token,
      access_code: s.access_code,
      signUrl: `${linkBase}/sign/${s.token}/${s.access_code}`,
      previewUrl: `${linkBase}/sign/${s.token}/${s.access_code}?preview=td`,
    }))

  return { id: env.id, token: env.token, access_code: env.access_code, signers: signerList }
}

/** Download the source PDF bytes for an envelope. */
async function downloadSourcePdf(pdf_storage_path: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage.from(SOURCE_BUCKET).download(pdf_storage_path)
  if (error || !data) throw new Error(`Could not read the source PDF: ${error?.message || "not found"}`)
  return Buffer.from(await data.arrayBuffer())
}

async function downloadMark(path: string | null): Promise<Uint8Array | null> {
  if (!path) return null
  const { data } = await supabaseAdmin.storage.from(SIGNED_BUCKET).download(path)
  if (!data) return null
  return new Uint8Array(await data.arrayBuffer())
}

/**
 * Flatten every field value into the signed PDF and store it. Called once, at
 * completion (last required signer). Idempotent-friendly: caller guards on
 * envelope status. Returns the signed PDF storage path.
 */
export async function flattenEnvelopeToSignedPdf(envelopeId: string): Promise<{ signedPath: string }> {
  const { data: env, error: envErr } = await db
    .from("esign_envelopes")
    .select("id, token, document_name, pdf_storage_path")
    .eq("id", envelopeId)
    .single()
  if (envErr || !env || !env.pdf_storage_path) throw new Error("Envelope or source PDF not found.")

  const { data: fields } = await db
    .from("esign_fields")
    .select("field_type, page_index, pos_x, pos_y, width, height, value, font_size, signer_id")
    .eq("envelope_id", envelopeId)
  const { data: signers } = await db
    .from("esign_signers")
    .select("id, name, email, signed_by_name, signed_at, last_ip, last_user_agent, consent_acknowledged, consent_text, signature_image_path, initials_image_path")
    .eq("envelope_id", envelopeId)

  const sigById = new Map<string, { signature_image_path: string | null; initials_image_path: string | null }>()
  for (const s of (signers ?? []) as Array<{ id: string; signature_image_path: string | null; initials_image_path: string | null }>) {
    sigById.set(s.id, s)
  }

  // Resolve each signature/initials field's image bytes once per signer.
  const markCache = new Map<string, Uint8Array | null>()
  const flattenFields: FlattenField[] = []
  for (const f of (fields ?? []) as Array<{ field_type: EsignFieldType; page_index: number; pos_x: number; pos_y: number; width: number; height: number; value: string | null; font_size: number | null; signer_id: string | null }>) {
    let imageBytes: Uint8Array | null = null
    if ((f.field_type === "signature" || f.field_type === "initials") && f.signer_id) {
      const s = sigById.get(f.signer_id)
      const path = f.field_type === "signature" ? s?.signature_image_path ?? null : s?.initials_image_path ?? null
      const key = `${f.field_type}:${f.signer_id}`
      if (!markCache.has(key)) markCache.set(key, await downloadMark(path))
      imageBytes = markCache.get(key) ?? null
    }
    flattenFields.push({
      field_type: f.field_type,
      page_index: f.page_index,
      pos_x: f.pos_x,
      pos_y: f.pos_y,
      width: f.width,
      height: f.height,
      value: f.value,
      font_size: f.font_size,
      imageBytes,
    })
  }

  const source = await downloadSourcePdf(env.pdf_storage_path)
  const flattenedBytes = await flattenEsignPdf(new Uint8Array(source), flattenFields)

  // Append the Certificate of Completion (legal artifact) using the audit data.
  const { data: signedEvents } = await db
    .from("esign_events")
    .select("signer_id, metadata")
    .eq("envelope_id", envelopeId)
    .eq("event_type", "signed")
  const hashBySigner = new Map<string, string>()
  for (const e of (signedEvents ?? []) as Array<{ signer_id: string | null; metadata: { signature_hash?: string } | null }>) {
    if (e.signer_id && e.metadata?.signature_hash) hashBySigner.set(e.signer_id, e.metadata.signature_hash)
  }
  type SignerRow = {
    id: string; name: string; email: string | null; signed_by_name: string | null; signed_at: string | null
    last_ip: string | null; last_user_agent: string | null; consent_acknowledged: boolean; consent_text: string | null
  }
  const signerRows = (signers ?? []) as SignerRow[]
  const certSigners: CertificateSigner[] = signerRows.map(s => ({
    name: s.name,
    email: s.email,
    signedByName: s.signed_by_name,
    signedAt: s.signed_at,
    ip: s.last_ip,
    userAgent: s.last_user_agent,
    consent: !!s.consent_acknowledged,
    signatureHash: hashBySigner.get(s.id) ?? null,
  }))
  const documentSha256 = createHash("sha256").update(Buffer.from(source)).digest("hex")
  const consentText = signerRows.map(s => s.consent_text).find(Boolean) || DEFAULT_CONSENT_TEXT

  const pdf = await PDFDocument.load(flattenedBytes)
  await appendCertificatePage(pdf, {
    envelopeId,
    documentName: env.document_name,
    documentSha256,
    completedAt: new Date().toISOString(),
    consentText,
    signers: certSigners,
  })
  const signedBytes = await pdf.save()

  const signedPath = `esign/${env.token}/signed-${Date.now()}.pdf`
  const { error: upErr } = await supabaseAdmin.storage
    .from(SIGNED_BUCKET)
    .upload(signedPath, Buffer.from(signedBytes), { contentType: "application/pdf", upsert: true })
  if (upErr) throw new Error(`Could not store the signed PDF: ${upErr.message}`)

  return { signedPath }
}

/**
 * Post-completion side-effects (best-effort — never throws, so it can't break the
 * signer's submit). For an account-linked envelope, files the signed PDF (with
 * certificate) into the client's documents, portal-visible, served from storage
 * (uniform sandbox/prod). Always sends a support notification (no-op in sandbox).
 * Idempotent: skips the documents row if it already exists.
 */
export async function finalizeEsignCompletion(envelopeId: string): Promise<void> {
  try {
    const { data: env } = await db
      .from("esign_envelopes")
      .select("id, token, document_name, owner_account_id, contact_id, signed_pdf_path, signed_pdf_drive_id")
      .eq("id", envelopeId)
      .maybeSingle()
    if (!env) return

    // 1. File the signed PDF into the client's records — their Google Drive folder
    // AND the documents table (portal-visible). Account-linked only. Mirrors the
    // legacy signature-request-signed flow. A Drive failure (no drive_folder_id,
    // API hiccup, or Drive-less env) falls back to a storage-served documents row,
    // so the signed PDF ALWAYS reaches the client's portal either way.
    if (env.signed_pdf_path && env.owner_account_id) {
      const fileName = `${env.document_name} - Signed.pdf`
      let filedToDrive = false

      // 1a. Upload to the client's Google Drive "5. Correspondence" folder.
      // Idempotent: if signed_pdf_drive_id is already set, the upload already
      // happened (a re-run via the reconciliation cron) — don't upload again.
      // Skipped in sandbox (Drive is mocked there): the storage fallback (1b)
      // gives a real, portal-visible documents row instead.
      if (env.signed_pdf_drive_id) filedToDrive = true
      const inSandbox = process.env.SANDBOX_MODE === "1"
      try {
        const { data: account } = (filedToDrive || inSandbox) ? { data: null } : await db.from("accounts").select("drive_folder_id").eq("id", env.owner_account_id).maybeSingle()
        if (account?.drive_folder_id) {
          const { data: pdfData } = await supabaseAdmin.storage.from(SIGNED_BUCKET).download(env.signed_pdf_path)
          if (pdfData) {
            const buffer = Buffer.from(await pdfData.arrayBuffer())
            const { uploadBinaryToDrive, listFolder } = await import("@/lib/google-drive")
            let targetFolderId: string = account.drive_folder_id
            try {
              const contents = await listFolder(account.drive_folder_id)
              const corr = (contents as Array<{ name: string; id: string }>).find(f => f.name.startsWith("5"))
              if (corr) targetFolderId = corr.id
            } catch {
              /* fall back to the account root folder */
            }
            const driveResult = await uploadBinaryToDrive(fileName, buffer, "application/pdf", targetFolderId)
            const driveFileId = (driveResult as { id?: string })?.id
            if (driveFileId) {
              const { autoSaveDocument } = await import("@/lib/portal/auto-save-document")
              await autoSaveDocument({ accountId: env.owner_account_id, fileName, documentType: env.document_name, category: 5, driveFileId })
              await db.from("esign_envelopes").update({ signed_pdf_drive_id: driveFileId }).eq("id", env.id)
              const { updateDocument } = await import("@/lib/operations/document")
              await updateDocument({
                drive_file_id: driveFileId,
                account_id: env.owner_account_id,
                // autoSaveDocument sets drive_file_id but not drive_link, leaving
                // the doc non-clickable in the account Documents tab — populate a
                // Drive view URL built from the file id so it opens everywhere.
                patch: { portal_visible: true, drive_link: `https://drive.google.com/file/d/${driveFileId}/view` },
                actor: "system:esign",
                summary: `Signed e-sign document filed to Drive + portal: ${env.document_name}`,
              })
              filedToDrive = true
            }
          }
        }
      } catch {
        /* fall through to the storage-served fallback */
      }

      // 1b. Fallback: storage-served documents row (no Drive folder / Drive down).
      if (!filedToDrive) {
        try {
          const driveRef = `storage:${SIGNED_BUCKET}/${env.signed_pdf_path}`
          const { data: existing } = await db
            .from("documents")
            .select("id")
            .eq("account_id", env.owner_account_id)
            .eq("drive_file_id", driveRef)
            .maybeSingle()
          if (!existing) {
            const { data: signed } = await supabaseAdmin.storage
              .from(SIGNED_BUCKET)
              .createSignedUrl(env.signed_pdf_path, 60 * 60 * 24 * 365) // 1 year
            await db.from("documents").insert({
              account_id: env.owner_account_id,
              contact_id: env.contact_id,
              file_name: fileName,
              document_type_name: env.document_name,
              category: 5, // Correspondence
              drive_file_id: driveRef,
              drive_link: signed?.signedUrl ?? null,
              status: "classified",
              confidence: "high", // prod has a CHECK(high|medium|low)
              portal_visible: true,
              notify_client: false,
            })
          }
        } catch {
          /* best-effort filing */
        }
      }
    }

    // 2. Notify support (inline; sandbox blocks the actual send).
    try {
      let company = ""
      if (env.owner_account_id) {
        const { data: account } = await db.from("accounts").select("company_name").eq("id", env.owner_account_id).maybeSingle()
        company = account?.company_name || ""
      }
      const { gmailPost } = await import("@/lib/gmail")
      const subject = `E-Sign completed: ${env.document_name}${company ? ` — ${company}` : ""}`
      const encoded = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
      const raw = [
        `From: support@tonydurante.us`,
        `To: support@tonydurante.us`,
        `Subject: ${encoded}`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        `The e-sign envelope "${env.document_name}" is fully signed.`,
        company ? `Client: ${company}` : ``,
        `The signed PDF (with Certificate of Completion) is filed${env.owner_account_id ? " in the client's documents" : ""}.`,
      ].join("\r\n")
      await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })
    } catch {
      /* best-effort notification */
    }

    logAction({
      action_type: "update",
      table_name: "esign_envelopes",
      record_id: envelopeId,
      account_id: env.owner_account_id ?? undefined,
      summary: `E-Sign envelope completed: ${env.document_name}`,
    })
  } catch {
    /* never break completion */
  }
}

// ───────────────────────────── Templates ─────────────────────────────
// Reusable doc + field layout. Fields carry signer_role_index (0-based) instead
// of a concrete signer; instantiation binds roles → real signers in the editor.

const TEMPLATE_PREFIX = "templates"

export interface TemplateFieldInput {
  field_type: EsignFieldType
  page_index: number
  pos_x: number
  pos_y: number
  width: number
  height: number
  default_required?: boolean
  placeholder?: string | null
  font_size?: number | null
  signer_role_index: number
}

export interface CreateEsignTemplateParams {
  name: string
  description?: string | null
  pdfBuffer: Buffer
  fileName: string
  pageCount: number
  fields: TemplateFieldInput[]
  roleCount: number
  owner_account_id?: string | null
  created_by?: string
}

export async function createEsignTemplate(params: CreateEsignTemplateParams): Promise<{ id: string }> {
  const { name, description = null, pdfBuffer, fileName, pageCount, fields, roleCount, owner_account_id = null, created_by = "system" } = params
  if (!name.trim()) throw new Error("Template name is required.")
  if (!fields.length) throw new Error("A template needs at least one field.")
  if (roleCount < 1) throw new Error("A template needs at least one signer role.")
  for (const f of fields) {
    if (!isValidNormalizedRect(f)) throw new Error(`Template field has invalid coordinates (${f.field_type}, page ${f.page_index}).`)
    if (f.signer_role_index < 0 || f.signer_role_index >= roleCount) {
      throw new Error(`Field references role ${f.signer_role_index} but the template has ${roleCount} role(s).`)
    }
  }
  for (let r = 0; r < roleCount; r++) {
    if (!fields.some(f => f.signer_role_index === r)) throw new Error(`Signer role ${r + 1} has no fields.`)
  }

  const token = randToken(14)
  const storagePath = `${TEMPLATE_PREFIX}/${token}/${fileName}`
  const { error: upErr } = await supabaseAdmin.storage
    .from(SOURCE_BUCKET)
    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true })
  if (upErr) throw new Error(`Could not store the template: ${upErr.message}`)

  const { data: tpl, error: tplErr } = await db
    .from("esign_templates")
    .insert({ owner_account_id, name: name.trim(), description, pdf_storage_path: storagePath, page_count: pageCount, status: "active", created_by })
    .select("id")
    .single()
  if (tplErr || !tpl) throw new Error(`Could not create the template: ${tplErr?.message || "unknown"}`)

  const fieldRows = fields.map(f => ({
    template_id: tpl.id,
    signer_role_index: f.signer_role_index,
    field_type: f.field_type,
    page_index: f.page_index,
    pos_x: f.pos_x,
    pos_y: f.pos_y,
    width: f.width,
    height: f.height,
    default_required: f.default_required ?? true,
    placeholder: f.placeholder ?? null,
    font_size: f.font_size ?? null,
  }))
  const { error: fErr } = await db.from("esign_template_fields").insert(fieldRows)
  if (fErr) throw new Error(`Could not save template fields: ${fErr.message}`)

  logAction({ action_type: "create", table_name: "esign_templates", record_id: tpl.id, account_id: owner_account_id ?? undefined, summary: `E-Sign template created: ${name}` })
  return { id: tpl.id }
}

export async function listEsignTemplates(): Promise<Array<{ id: string; name: string; page_count: number | null; created_at: string }>> {
  const { data } = await db
    .from("esign_templates")
    .select("id, name, page_count, created_at")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(100)
  return data ?? []
}

/** Template detail for instantiation: a 1-year signed URL for the PDF + the fields + role count. */
export async function getEsignTemplate(id: string): Promise<{
  id: string
  name: string
  description: string | null
  page_count: number | null
  pdfUrl: string | null
  roleCount: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: any[]
} | null> {
  const { data: tpl } = await db
    .from("esign_templates")
    .select("id, name, description, page_count, pdf_storage_path")
    .eq("id", id)
    .maybeSingle()
  if (!tpl) return null
  const { data: fields } = await db
    .from("esign_template_fields")
    .select("field_type, page_index, pos_x, pos_y, width, height, default_required, placeholder, font_size, signer_role_index")
    .eq("template_id", id)
  const { data: signed } = await supabaseAdmin.storage.from(SOURCE_BUCKET).createSignedUrl(tpl.pdf_storage_path, 60 * 60) // 1h is enough to load into the editor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fieldRows: any[] = fields ?? []
  const roleCount = fieldRows.reduce((m, f) => Math.max(m, (f.signer_role_index ?? 0) + 1), 1)
  return { id: tpl.id, name: tpl.name, description: tpl.description, page_count: tpl.page_count, pdfUrl: signed?.signedUrl ?? null, roleCount, fields: fieldRows }
}
