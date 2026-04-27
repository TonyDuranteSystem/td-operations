import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

// GET /api/accounts/[id]/members — list all members
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { data, error } = await supabaseAdmin
      .from("members")
      .select("id, member_type, full_name, company_name, email, phone, ownership_pct, is_primary, is_signer, contact_id, ein, representative_name, representative_email, representative_phone, address_street, address_city, address_state, address_country, updated_at")
      .eq("account_id", params.id)
      .order("is_primary", { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data: data ?? [] })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

// POST /api/accounts/[id]/members — create a member
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json()
    const now = new Date().toISOString()

    const insert: Record<string, unknown> = {
      account_id: params.id,
      member_type: body.member_type ?? "individual",
      ownership_pct: body.ownership_pct ?? null,
      is_primary: body.is_primary ?? false,
      is_signer: body.is_signer ?? false,
      updated_at: now,
      created_at: now,
    }

    if (insert.member_type === "company") {
      if (!body.member_company_name) {
        return NextResponse.json({ error: "member_company_name is required for company members" }, { status: 400 })
      }
      insert.company_name = body.member_company_name
      insert.ein = body.ein ?? null
      insert.address_street = body.address_street ?? null
      insert.address_city = body.address_city ?? null
      insert.address_state = body.address_state ?? null
      insert.address_zip = body.address_zip ?? null
      insert.address_country = body.address_country ?? null
      insert.representative_name = body.representative_name ?? null
      insert.representative_email = body.representative_email ?? null
      insert.representative_phone = body.representative_phone ?? null
      insert.representative_address_street = body.representative_address_street ?? null
      insert.representative_address_city = body.representative_address_city ?? null
      insert.representative_address_state = body.representative_address_state ?? null
      insert.representative_address_zip = body.representative_address_zip ?? null
      insert.representative_address_country = body.representative_address_country ?? null
    } else {
      insert.full_name = body.full_name ?? null
      insert.email = body.email ?? null
      insert.phone = body.phone ?? null
      insert.contact_id = body.contact_id ?? null
      insert.address_street = body.address_street ?? null
      insert.address_city = body.address_city ?? null
      insert.address_state = body.address_state ?? null
      insert.address_zip = body.address_zip ?? null
      insert.address_country = body.address_country ?? null
    }

    const { data, error } = await supabaseAdmin
      .from("members")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic insert built from user input; required fields are validated above
      .insert(insert as any)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // MM5: individual members with a contact must also get account_contacts for portal access
    if (insert.member_type === "individual" && insert.contact_id) {
      const { error: acError } = await supabaseAdmin
        .from("account_contacts")
        .upsert(
          {
            account_id: params.id,
            contact_id: insert.contact_id as string,
            role: "Member",
            ownership_pct: (insert.ownership_pct as number | null) ?? null,
            is_primary: (insert.is_primary as boolean) ?? false,
          },
          { onConflict: "account_id,contact_id" }
        )
      if (acError) {
        console.error("[members POST] account_contacts upsert failed:", acError.message)
      }
    }

    return NextResponse.json({ data }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

// PATCH /api/accounts/[id]/members — update a member by member_id in body
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json()
    const { member_id, ...fields } = body

    if (!member_id) {
      return NextResponse.json({ error: "member_id is required" }, { status: 400 })
    }

    // Allowed updatable fields (whitelist to prevent arbitrary column injection)
    const ALLOWED = [
      "full_name", "company_name", "email", "phone", "ein",
      "ownership_pct", "is_primary", "is_signer", "contact_id",
      "address_street", "address_city", "address_state", "address_zip", "address_country",
      "representative_name", "representative_email", "representative_phone",
      "representative_address_street", "representative_address_city",
      "representative_address_state", "representative_address_zip", "representative_address_country",
    ]

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const key of ALLOWED) {
      if (key in fields) updates[key] = fields[key]
    }

    if (Object.keys(updates).length === 1) {
      return NextResponse.json({ error: "No updatable fields provided" }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from("members")
      .update(updates)
      .eq("id", member_id)
      .eq("account_id", params.id)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: "Member not found" }, { status: 404 })
    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

// DELETE /api/accounts/[id]/members — delete a member by member_id in body
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json()
    const { member_id } = body

    if (!member_id) {
      return NextResponse.json({ error: "member_id is required" }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from("members")
      .delete()
      .eq("id", member_id)
      .eq("account_id", params.id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
