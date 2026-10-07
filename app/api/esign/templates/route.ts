/**
 * GET  /api/esign/templates — list active templates (staff).
 * POST /api/esign/templates — create a template from an uploaded PDF + field
 *   layout. Two request shapes (lib/esign/read-pdf-input.ts): JSON
 *   { staging_path, file_name, payload } (PDF uploaded straight to storage via
 *   POST /api/esign/upload-url — no 4.5 MB platform limit) or the original
 *   multipart pdf + payload. payload = { name, description?, roleCount,
 *   fields: [{ field_type, page_index, pos_x, pos_y, width, height,
 *              default_required?, placeholder?, font_size?, signer_role_index }],
 *   owner_account_id? }.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { validatePdfUpload, scanForMalware } from "@/lib/esign/upload-guard"
import { readPdfInput } from "@/lib/esign/read-pdf-input"
import { sanitizePdfFileName } from "@/lib/esign/staging"
import { createEsignTemplate, listEsignTemplates, type TemplateFieldInput } from "@/lib/operations/esign"

async function requireStaff() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return { ok: isDashboardUser(user), user }
}

export async function GET() {
  const { ok } = await requireStaff()
  if (!ok) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })
  const templates = await listEsignTemplates()
  return NextResponse.json({ templates })
}

export async function POST(req: NextRequest) {
  const { ok, user } = await requireStaff()
  if (!ok) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })

  const input = await readPdfInput(req, user!.id)
  if (input.kind === "refused") return NextResponse.json({ error: input.error }, { status: input.status })
  try {
    return await createTemplateFromInput(user, input)
  } finally {
    await input.discard()
  }
}

async function createTemplateFromInput(
  user: { email?: string | null } | null,
  input: { bytes: Uint8Array; fileName: string; payload: any }, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const payload = input.payload

  const name = typeof payload.name === "string" ? payload.name.trim() : ""
  if (!name) return NextResponse.json({ error: "A template name is required." }, { status: 400 })
  const fields: TemplateFieldInput[] = Array.isArray(payload.fields) ? payload.fields : []
  const roleCount = Number(payload.roleCount)
  if (!fields.length) return NextResponse.json({ error: "Place at least one field." }, { status: 400 })
  if (!Number.isInteger(roleCount) || roleCount < 1) return NextResponse.json({ error: "Invalid signer role count." }, { status: 400 })

  const bytes = input.bytes
  const valid = await validatePdfUpload(bytes)
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 })
  const scan = await scanForMalware(bytes)
  if (!scan.clean) return NextResponse.json({ error: "The file failed a security scan." }, { status: 400 })

  try {
    const result = await createEsignTemplate({
      name,
      description: typeof payload.description === "string" ? payload.description : null,
      pdfBuffer: Buffer.from(bytes),
      fileName: sanitizePdfFileName(input.fileName, "template"),
      pageCount: valid.pageCount ?? 1,
      fields,
      roleCount,
      owner_account_id: typeof payload.owner_account_id === "string" ? payload.owner_account_id : null,
      created_by: user?.email || "staff",
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create the template." }, { status: 400 })
  }
}
