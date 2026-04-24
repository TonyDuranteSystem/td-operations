/**
 * Message Actions API
 *
 * GET  ?account_id=...  — fetch all actions for an account's messages (for tag display)
 * GET  ?message_id=...  — fetch action for a specific message
 * GET  ?open=true       — fetch all open actions (for dashboard Action Items)
 * POST { message_id, contact_id, account_id, action_type, label?, created_by? }
 *   — upsert an action tag on a message (one action per message)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  try {
    const accountId = req.nextUrl.searchParams.get("account_id")
    const messageId = req.nextUrl.searchParams.get("message_id")
    const openOnly = req.nextUrl.searchParams.get("open") === "true"

    let query = supabaseAdmin
      .from("message_actions")
      .select("id, message_id, contact_id, account_id, action_type, label, created_by, resolved_at, created_at")
      .order("created_at", { ascending: false })

    if (messageId) {
      query = query.eq("message_id", messageId)
    } else if (accountId) {
      query = query.eq("account_id", accountId)
    }

    if (openOnly) {
      query = query.neq("action_type", "done")
    }

    // When fetching all open actions, join message text + client names for the Actions tab
    if (openOnly) {
      const { data: enriched, error: err } = await supabaseAdmin
        .from("message_actions")
        .select(`
          id, action_type, created_at, updated_at, message_id, account_id, contact_id,
          portal_messages(message),
          accounts(company_name),
          contacts(full_name)
        `)
        .neq("action_type", "done")
        .order("updated_at", { ascending: false })
        .limit(200)
      if (err) throw err
      return NextResponse.json({ actions: enriched })
    }

    const { data, error } = await query.limit(200)
    if (error) throw error

    return NextResponse.json({ actions: data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { message_id, contact_id, account_id, action_type, label, created_by } = body

    if (!message_id || !action_type) {
      return NextResponse.json({ error: "Missing message_id or action_type" }, { status: 400 })
    }

    const validTypes = ["action_needed", "in_progress", "waiting_on_client", "done"]
    if (!validTypes.includes(action_type)) {
      return NextResponse.json({ error: `Invalid action_type. Must be one of: ${validTypes.join(", ")}` }, { status: 400 })
    }

    // Upsert: check if action already exists for this message
    const { data: existing } = await supabaseAdmin
      .from("message_actions")
      .select("id")
      .eq("message_id", message_id)
      .limit(1)
      .maybeSingle()

    if (existing) {
      // Update existing action
      const updateData: Record<string, unknown> = {
        action_type,
        updated_at: new Date().toISOString(),
      }
      if (label !== undefined) updateData.label = label
      if (created_by) updateData.created_by = created_by
      if (action_type === "done") {
        updateData.resolved_at = new Date().toISOString()
      } else {
        updateData.resolved_at = null
      }

      const { data, error } = await supabaseAdmin
        .from("message_actions")
        .update(updateData)
        .eq("id", existing.id)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ action: data, updated: true })
    }

    // Insert new action
    const { data, error } = await supabaseAdmin
      .from("message_actions")
      .insert({
        message_id,
        contact_id: contact_id || null,
        account_id: account_id || null,
        action_type,
        label: label || null,
        created_by: created_by || null,
        resolved_at: action_type === "done" ? new Date().toISOString() : null,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ action: data, created: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
