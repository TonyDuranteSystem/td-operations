/**
 * Signature-request operations — the callable core behind both the
 * `signature_request_create` MCP tool and the Tax Return flow's
 * "Send for Signature" action.
 *
 * The MCP tool sources the PDF from Google Drive; the flow sources it from a
 * documents row that may live in Drive (production) or Supabase Storage
 * (sandbox). To keep one serving path, this helper takes the PDF as a Buffer,
 * stores it in the `signature-requests` bucket, and leaves `drive_file_id` NULL
 * so `/api/signature-request/[token]/pdf` always serves from storage.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { logAction } from "@/lib/mcp/action-log"

/** A slug-safe token unique per document send. Pure — unit-tested. */
export function buildSignatureToken(
  companyName: string,
  documentName: string,
  ts: number,
): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  const company = slug(companyName) || "company"
  const doc = slug(documentName).slice(0, 30) || "document"
  return `sig-${company}-${doc}-${ts.toString(36)}`
}

export interface SignatureCoords {
  x: number
  y: number
  page: number
}

export interface CreateSignatureRequestParams {
  account_id: string
  /** Resolved primary contact if omitted. */
  contact_id?: string
  document_name: string
  description?: string | null
  /** The PDF bytes to be signed. */
  pdfBuffer: Buffer
  fileName: string
  /** Link to a flow (Tax Return SD) so its stage can track + auto-advance. */
  service_delivery_id?: string
  signature_coords?: SignatureCoords
  created_by?: string
}

export interface CreateSignatureRequestResult {
  id: string
  token: string
  access_code: string
  contact_id: string
  contact_email: string
  company_name: string
  clientUrl: string
  previewUrl: string
}

/**
 * Create a signature request from in-memory PDF bytes. Resolves the primary
 * contact when none is given, stores the PDF in the `signature-requests`
 * bucket, inserts the `signature_requests` row, and returns the signing URLs.
 */
export async function createSignatureRequest(
  params: CreateSignatureRequestParams,
): Promise<CreateSignatureRequestResult> {
  const {
    account_id,
    document_name,
    description = null,
    pdfBuffer,
    fileName,
    service_delivery_id,
    signature_coords,
    created_by = "system",
  } = params

  // Resolve contact.
  let contactId = params.contact_id
  if (!contactId) {
    const { data: links } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", account_id)
      .limit(1)
    if (!links?.length) throw new Error("No contacts linked to this account")
    contactId = links[0].contact_id
  }

  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("full_name, email")
    .eq("id", contactId)
    .single()
  if (!contact?.email) throw new Error("Contact has no email address")

  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("company_name")
    .eq("id", account_id)
    .single()
  if (!account) throw new Error("Account not found")

  const token = buildSignatureToken(account.company_name || "company", document_name, Date.now())

  // Store the PDF in the signing bucket (served via the pdf route).
  const storagePath = `${token}/${fileName}`
  const { error: uploadError } = await supabaseAdmin.storage
    .from("signature-requests")
    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true })
  if (uploadError) {
    throw new Error(`Could not store the document for signing: ${uploadError.message}`)
  }

  const coords = signature_coords || { x: 150, y: 80, page: 0 }
  const insert: Record<string, unknown> = {
    token,
    account_id,
    contact_id: contactId,
    document_name,
    description,
    pdf_storage_path: storagePath,
    drive_file_id: null, // served from storage, uniform sandbox/prod
    signature_coords: coords,
    status: "awaiting_signature",
    created_by,
  }
  if (service_delivery_id) insert.service_delivery_id = service_delivery_id

  const { data: sigReq, error: insertError } = await supabaseAdmin
    .from("signature_requests")
    .insert(insert as never)
    .select("id, token, access_code")
    .single()
  if (insertError || !sigReq) {
    throw new Error(`Could not create the signature request: ${insertError?.message || "unknown"}`)
  }

  logAction({
    action_type: "create",
    table_name: "signature_requests",
    record_id: sigReq.id,
    account_id,
    summary: `Signature request created: ${document_name} for ${contact.full_name}`,
  })

  return {
    id: sigReq.id,
    token: sigReq.token,
    access_code: sigReq.access_code,
    contact_id: contactId,
    contact_email: contact.email,
    company_name: account.company_name || "",
    clientUrl: `${APP_BASE_URL}/sign-document/${sigReq.token}/${sigReq.access_code}`,
    previewUrl: `${APP_BASE_URL}/sign-document/${sigReq.token}/${sigReq.access_code}?preview=td`,
  }
}

/**
 * Fetch the PDF bytes for a flow document row. Handles both the production
 * shape (real Drive file id) and the sandbox shape (synthetic `storage:<path>`
 * id whose bytes live in the `onboarding-uploads` bucket).
 */
export async function fetchFlowDocumentPdf(driveFileId: string): Promise<Buffer> {
  if (driveFileId.startsWith("storage:")) {
    const path = driveFileId.slice("storage:".length)
    const { data, error } = await supabaseAdmin.storage
      .from("onboarding-uploads")
      .download(path)
    if (error || !data) {
      throw new Error(`Could not read the uploaded document: ${error?.message || "not found"}`)
    }
    return Buffer.from(await data.arrayBuffer())
  }
  const { downloadFileBinary } = await import("@/lib/google-drive")
  const { buffer } = await downloadFileBinary(driveFileId)
  return buffer
}
