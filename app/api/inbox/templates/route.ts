import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Database } from "@/lib/database.types"

export const dynamic = "force-dynamic"

interface TemplatePayload {
  id?: string
  template_name: string
  subject_template: string
  body_template: string
  language?: string | null
  category?: string | null
  service_type?: string | null
  placeholders?: string[] | null
  active?: boolean
  notes?: string | null
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export async function GET(req: NextRequest) {
  const includeInactive = req.nextUrl.searchParams.get("include_inactive") === "true"
  let query = supabaseAdmin
    .from("email_templates")
    .select("id, template_name, subject_template, body_template, language, category, service_type, placeholders, active, notes, updated_at")
    .order("category", { ascending: true, nullsFirst: false })
    .order("template_name", { ascending: true })
  if (!includeInactive) query = query.eq("active", true)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ templates: data || [] })
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as TemplatePayload
  if (!body.template_name || !body.subject_template || !body.body_template) {
    return NextResponse.json(
      { error: "template_name, subject_template, body_template are required" },
      { status: 400 }
    )
  }

  // service_type is an enum column with a fixed value set; the CRM editor
  // doesn't surface it, so we don't forward it from the generic payload.
  const insertRow: Database["public"]["Tables"]["email_templates"]["Insert"] = {
    template_name: body.template_name,
    subject_template: body.subject_template,
    body_template: body.body_template,
    language: body.language ?? null,
    category: body.category ?? null,
    placeholders: (body.placeholders ?? null) as Database["public"]["Tables"]["email_templates"]["Insert"]["placeholders"],
    active: body.active ?? true,
    notes: body.notes ?? null,
  }

  const { data, error } = await supabaseAdmin
    .from("email_templates")
    .insert(insertRow)
    .select("id, template_name, subject_template, body_template, language, category, service_type, placeholders, active, notes, updated_at")
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ template: data })
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as TemplatePayload
  if (!body.id || !isUuid(body.id)) {
    return NextResponse.json({ error: "id (uuid) is required" }, { status: 400 })
  }

  const patch: Database["public"]["Tables"]["email_templates"]["Update"] = {
    updated_at: new Date().toISOString(),
  }
  if (body.template_name !== undefined) patch.template_name = body.template_name
  if (body.subject_template !== undefined) patch.subject_template = body.subject_template
  if (body.body_template !== undefined) patch.body_template = body.body_template
  if (body.language !== undefined) patch.language = body.language
  if (body.category !== undefined) patch.category = body.category
  if (body.placeholders !== undefined) {
    patch.placeholders = body.placeholders as Database["public"]["Tables"]["email_templates"]["Update"]["placeholders"]
  }
  if (body.active !== undefined) patch.active = body.active
  if (body.notes !== undefined) patch.notes = body.notes

  const { data, error } = await supabaseAdmin
    .from("email_templates")
    .update(patch)
    .eq("id", body.id)
    .select("id, template_name, subject_template, body_template, language, category, service_type, placeholders, active, notes, updated_at")
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Template not found" }, { status: 404 })
  return NextResponse.json({ template: data })
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id")
  if (!id || !isUuid(id)) {
    return NextResponse.json({ error: "id (uuid) query param is required" }, { status: 400 })
  }
  const { error } = await supabaseAdmin.from("email_templates").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
