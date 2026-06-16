/**
 * GET /api/flows/[id]/signature
 *
 * Returns the latest signature request linked to this service delivery, used by
 * the flow Workspace "Sent for Signature" stage to show signing status
 * (waiting / signed) and a staff preview link.
 *
 * Read-only. [id] = service_delivery_id.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const serviceDeliveryId = params.id

    // service_delivery_id was added by migration but the generated DB types
    // aren't regenerated — query via an untyped surface (mirrors flow routes).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const { data, error } = await db
      .from("signature_requests")
      .select("token, access_code, document_name, status, signed_at, created_at")
      .eq("service_delivery_id", serviceDeliveryId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    if (!data) {
      return NextResponse.json({ success: true, request: null })
    }

    return NextResponse.json({
      success: true,
      request: {
        document_name: data.document_name,
        status: data.status,
        signed_at: data.signed_at,
        preview_url: `${APP_BASE_URL}/sign-document/${data.token}/${data.access_code}?preview=td`,
      },
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
