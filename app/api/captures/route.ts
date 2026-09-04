import { createClient } from "@/lib/supabase/server"
import { isDashboardUser, getUserDisplayName } from "@/lib/auth"
import { isValidCapturePath } from "@/lib/captures/storage"
import { capturesTable } from "@/lib/captures/db"
import { NextRequest, NextResponse } from "next/server"

/**
 * GET /api/captures
 *
 * Step 7 — "your capture folder": every picture YOU personally took, newest
 * first, and only yours (Antonio, 2026-09-04: "only mine and everyone will
 * see their own" — a flat rule, not filtered by who can see wherever each
 * one was sent). Capped at 200 — a personal history, not an archive browser.
 */
export async function GET() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const { data, error } = await capturesTable()
    .select("id, title, note, image_name, mime_type, size_bytes, destination, created_at")
    .eq("captured_by_user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200)

  if (error) {
    console.error("[captures] list error:", error)
    return NextResponse.json({ error: "Could not load your captures." }, { status: 500 })
  }
  return NextResponse.json({ captures: data ?? [] })
}

/**
 * POST /api/captures
 *
 * Second half of the capture upload flow: called AFTER the browser has already
 * PUT the bytes to the signed URL from /api/captures/upload-url. Writes the one
 * log row every capture gets (see scripts/migrations/20260904-1500-staff-captures.sql),
 * regardless of which destination it's shared to next — `destination` is set by
 * a later PATCH once the user finishes the "Share to..." step, not here.
 *
 * Staff-only. Body: { path, image_name?, mime_type?, size_bytes?, title, note? }.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const path: string | null = typeof body.path === "string" ? body.path : null
  const title: string = typeof body.title === "string" ? body.title.trim() : ""
  const note: string | null = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null
  const imageName: string | null = typeof body.image_name === "string" ? body.image_name : null
  const mimeType: string | null = typeof body.mime_type === "string" ? body.mime_type : null
  const sizeBytes: number | null = typeof body.size_bytes === "number" ? body.size_bytes : null

  if (!path || !isValidCapturePath(path)) {
    return NextResponse.json({ error: "Missing or invalid upload reference. Please try capturing again." }, { status: 400 })
  }
  if (!title) {
    return NextResponse.json({ error: "A title is required." }, { status: 400 })
  }

  const { data, error } = await capturesTable()
    .insert({
      captured_by_user_id: user.id,
      captured_by_name: getUserDisplayName(user),
      image_url: path,
      image_name: imageName,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      title,
      note,
    })
    .select()
    .single()

  if (error || !data) {
    console.error("[captures] insert error:", error)
    return NextResponse.json({ error: "Could not save the capture. Please try again." }, { status: 500 })
  }

  return NextResponse.json({ capture: data })
}
