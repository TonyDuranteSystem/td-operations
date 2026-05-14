import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

/**
 * GET /api/forms/lookup/[token]/[access_code]
 *
 * Generic form-type detector. Looks up the token across all known form tables
 * and returns the form_type — used by the portal viewer to render the right
 * form component without the caller knowing which table it lives in.
 *
 * To register a new form type, add it to FORM_TABLES below. No other code
 * changes are needed for the lookup to find it.
 */
const FORM_TABLES: { table: string; form_type: string }[] = [
  { table: "contact_request_forms", form_type: "contact_request" },
  { table: "member_info_requests", form_type: "member_info" },
  // Add new form types here — generic lookup picks them up automatically.
]

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string; access_code: string } }
) {
  const { token, access_code } = params

  for (const { table, form_type } of FORM_TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic table name
    const { data } = await (supabaseAdmin as any)
      .from(table)
      .select("id, status")
      .eq("token", token)
      .eq("access_code", access_code)
      .maybeSingle()

    if (data) {
      return NextResponse.json({ form_type, status: data.status })
    }
  }

  return NextResponse.json({ error: "Form not found" }, { status: 404 })
}
