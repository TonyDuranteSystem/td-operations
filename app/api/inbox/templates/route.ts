import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("email_templates")
    .select("id, template_name, subject_template, body_template, language, category, service_type, placeholders")
    .eq("active", true)
    .order("category", { ascending: true, nullsFirst: false })
    .order("template_name", { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ templates: data || [] })
}
