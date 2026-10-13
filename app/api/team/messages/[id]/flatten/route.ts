import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { assertGroupAccess } from '@/lib/team/groups'
import { checkRateLimit } from '@/lib/portal/rate-limit'
import { VOICE_MAX_BYTES, pickVoiceAttachment } from '@/lib/team/voice-text'
import { backupPathFor, teamChatAudioPath } from '@/lib/team/voice-flatten'
import { fragmentedMp4ToFlat, looksFragmented } from '@/lib/media/fmp4-to-flat'
import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 60

/**
 * POST /api/team/messages/[id]/flatten — repair ONE stored voice note (Body: { index }). Safari plays the fragmented MP4 that
 * iPhones record badly (cut short, or shown at DOUBLE the length after our earlier header patch). This rewrites the stored file
 * as an ordinary MP4 — same audio, nothing re-encoded — keeping the untouched original under team-chat-originals/. It marks the
 * attachment `flat` so it is never checked again, and answers with `flattened_at` so the page can reload the audio. Safe to call
 * on a file that is already fine (it only marks it). Staff only; a DM only for its two people, a group only for its members.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  const rl = checkRateLimit(`team-flatten:${user.id}`, 60, 60_000)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests. Please wait a moment.' }, { status: 429 })

  const { id: msgId } = await params
  const body = await request.json().catch(() => ({}))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: msg } = await db.from('internal_messages').select('id, thread_id, attachments, deleted_at').eq('id', msgId).maybeSingle()
  if (!msg || msg.deleted_at) return NextResponse.json({ error: 'Message not found.' }, { status: 404 })
  const { data: thread } = await db.from('internal_threads').select('thread_type, dm_key').eq('id', msg.thread_id).maybeSingle()
  if (!thread) return NextResponse.json({ error: 'Message not found.' }, { status: 404 })
  if (thread.thread_type === 'dm' && !String(thread.dm_key ?? '').split(':').includes(user.id)) {
    return NextResponse.json({ error: 'This is not your conversation.' }, { status: 403 })
  }
  const access = await assertGroupAccess(msg.thread_id, user.id)
  if (access.kind === 'denied') return NextResponse.json({ error: 'You are not in this group.' }, { status: 403 })

  const att = pickVoiceAttachment(msg.attachments, body.index)
  if (!att || !att.url) return NextResponse.json({ error: 'That is not a voice note.' }, { status: 400 })
  if (att.flat) return NextResponse.json({ ok: true, already: true, flattened_at: att.flattened_at ?? null })

  const path = teamChatAudioPath(att.url, process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!path) return NextResponse.json({ error: 'This audio cannot be repaired.' }, { status: 400 })

  const mark = async (extra: Record<string, unknown>) => {
    // Re-read right before writing so a message edited meanwhile is not overwritten with a stale copy.
    const { data: fresh } = await db.from('internal_messages').select('attachments').eq('id', msgId).maybeSingle()
    const list = Array.isArray(fresh?.attachments) ? fresh.attachments : null
    const i = body.index as number
    if (!list || !list[i] || list[i].url !== att.url) return
    const next = list.map((a: Record<string, unknown>, k: number) => (k === i ? { ...a, ...extra } : a))
    await db.from('internal_messages').update({ attachments: next }).eq('id', msgId)
  }

  try {
    // Cheap look first: most notes are already fine and only need the mark.
    const headRes = await fetch(att.url, { headers: { Range: 'bytes=0-8191' } })
    if (!headRes.ok) return NextResponse.json({ error: 'Could not load the audio.' }, { status: 502 })
    const head = new Uint8Array(await headRes.arrayBuffer())
    if (!looksFragmented(head)) {
      await mark({ flat: true })
      return NextResponse.json({ ok: true, already: true, flattened_at: null })
    }

    const fullRes = await fetch(att.url)
    if (!fullRes.ok) return NextResponse.json({ error: 'Could not load the audio.' }, { status: 502 })
    const original = new Uint8Array(await fullRes.arrayBuffer())
    if (original.length === 0 || original.length > VOICE_MAX_BYTES) return NextResponse.json({ error: 'This voice note cannot be repaired.' }, { status: 400 })
    const flat = fragmentedMp4ToFlat(original)
    if (!flat) {
      await mark({ flat: true, flatten_failed: true }) // an unusual file: leave it exactly as it is and stop checking
      return NextResponse.json({ ok: false, reason: 'unsupported' })
    }

    const bucket = supabaseAdmin.storage.from('assets')
    // 1) keep the untouched original (never overwrite an earlier backup)
    const backup = await bucket.upload(backupPathFor(path), original, { contentType: 'audio/mp4', upsert: false })
    if (backup.error && !/exists|duplicate/i.test(backup.error.message)) {
      return NextResponse.json({ error: 'Could not keep a copy of the original, so nothing was changed.' }, { status: 500 })
    }
    // 2) put the ordinary MP4 at the same address
    const up = await bucket.upload(path, flat.data, { contentType: 'audio/mp4', upsert: true, cacheControl: '60' })
    if (up.error) return NextResponse.json({ error: 'Could not save the repaired note. The original is untouched.' }, { status: 500 })

    const flattenedAt = new Date().toISOString()
    await mark({ flat: true, flattened_at: flattenedAt, size: flat.data.length })
    return NextResponse.json({ ok: true, flattened_at: flattenedAt, size: flat.data.length })
  } catch (err) {
    console.error('[team flatten]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not repair this voice note. Please try again.' }, { status: 502 })
  }
}
