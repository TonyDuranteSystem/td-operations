/**
 * Calendar team notes for ONE job (dev job 388bb74b): GET = the list, POST = add a note. STAFF ONLY and only for people who may see the Calendar:
 * the guard is the Calendar's own (`requireOpenServicesAccess` = staff user AND the open_services_audience setting), NOT the plain staff check — that
 * one also lets partners and marketing logins through. /api/* is not covered by the middleware's client bounce, so the door is locked here.
 * Notes are only ever ADDED (never edited or overwritten), the author is taken from the session, never from the request.
 */
import { NextResponse } from "next/server"
import * as Sentry from "@sentry/nextjs"
import { requireOpenServicesAccess } from "@/lib/open-services/audience"
import { addJobNote, jobForNotes, listJobNotes } from "@/lib/job-notes/read"
import { authorNameOf, checkNoteBody } from "@/lib/job-notes/types"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const access = await requireOpenServicesAccess()
  if (!access.ok) return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Unknown job." }, { status: 404 })
  try {
    if (!(await jobForNotes(params.id))) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 })
    return NextResponse.json({ notes: await listJobNotes(params.id) })
  } catch (err) {
    Sentry.captureException(err, { tags: { area: "job-notes" } })
    return NextResponse.json({ error: "Could not load the notes — please try again." }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const access = await requireOpenServicesAccess()
  if (!access.ok) return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Unknown job." }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { body?: unknown }
  const checked = checkNoteBody(body.body)
  if (!checked.ok || !checked.body) return NextResponse.json({ error: checked.error ?? "Write the note first." }, { status: 400 })
  try {
    const job = await jobForNotes(params.id)
    if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 })
    const note = await addJobNote({ jobId: params.id, body: checked.body, authorUserId: access.user.id, authorName: authorNameOf(access.user) })
    return NextResponse.json({ note, notes: await listJobNotes(params.id) })
  } catch (err) {
    Sentry.captureException(err, { tags: { area: "job-notes" } })
    return NextResponse.json({ error: "The note was not saved — please try again." }, { status: 500 })
  }
}
