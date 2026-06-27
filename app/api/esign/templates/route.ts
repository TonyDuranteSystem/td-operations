/**
 * GET  /api/esign/templates — list active templates (staff).
 * POST /api/esign/templates — create a template from an uploaded PDF + field
 *   layout. multipart: pdf + payload { name, description?, roleCount,
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

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 })
  }

  const file = form.get("pdf")
  if (!(file instanceof File)) return NextResponse.json({ error: "A PDF file is required." }, { status: 400 })

  const payloadRaw = form.get("payload")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any
  try {
    payload = JSON.parse(typeof payloadRaw === "string" ? payloadRaw : "{}")
  } catch {
    return NextResponse.json({ error: "Invalid payload JSON." }, { status: 400 })
  }

  const name = typeof payload.name === "string" ? payload.name.trim() : ""
  if (!name) return NextResponse.json({ error: "A template name is required." }, { status: 400 })
  const fields: TemplateFieldInput[] = Array.isArray(payload.fields) ? payload.fields : []
  const roleCount = Number(payload.roleCount)
  if (!fields.length) return NextResponse.json({ error: "Place at least one field." }, { status: 400 })
  if (!Number.isInteger(roleCount) || roleCount < 1) return NextResponse.json({ error: "Invalid signer role count." }, { status: 400 })

  const bytes = new Uint8Array(await file.arrayBuffer())
  const valid = await validatePdfUpload(bytes)
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 })
  const scan = await scanForMalware(bytes)
  if (!scan.clean) return NextResponse.json({ error: "The file failed a security scan." }, { status: 400 })

  try {
    const result = await createEsignTemplate({
      name,
      description: typeof payload.description === "string" ? payload.description : null,
      pdfBuffer: Buffer.from(bytes),
      fileName: (file.name || "template.pdf").replace(/[^a-zA-Z0-9._-]/g, "_"),
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
