import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { gmailGet, gmailPost, gmailDelete } from '@/lib/gmail'

export const dynamic = 'force-dynamic'

interface GmailLabel {
  id: string
  name: string
  type: 'system' | 'user'
  messagesTotal?: number
  messagesUnread?: number
  threadsTotal?: number
  threadsUnread?: number
}

/**
 * GET /api/inbox/labels — List Gmail labels (system + user-created)
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await gmailGet('/labels') as { labels: GmailLabel[] }

    // System labels we want to show
    const systemLabels = ['INBOX', 'SENT', 'DRAFT', 'STARRED', 'TRASH', 'SPAM']

    const labels = (result.labels || [])
      .filter(l => systemLabels.includes(l.id) || l.type === 'user')
      .map(l => ({
        id: l.id,
        name: l.name,
        type: l.type,
        unread: l.threadsUnread ?? l.messagesUnread ?? 0,
        total: l.threadsTotal ?? l.messagesTotal ?? 0,
      }))
      .sort((a, b) => {
        // System labels first, then user labels alphabetically
        if (a.type === 'system' && b.type !== 'system') return -1
        if (a.type !== 'system' && b.type === 'system') return 1
        const order = systemLabels
        const ai = order.indexOf(a.id)
        const bi = order.indexOf(b.id)
        if (ai >= 0 && bi >= 0) return ai - bi
        return a.name.localeCompare(b.name)
      })

    return NextResponse.json({ labels })
  } catch (err) {
    console.error('[labels] Error:', err)
    return NextResponse.json({ error: 'Failed to fetch labels' }, { status: 500 })
  }
}

/**
 * POST /api/inbox/labels — Create a new Gmail label (folder)
 */
export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name } = await req.json()
  if (!name?.trim()) {
    return NextResponse.json({ error: 'Label name is required' }, { status: 400 })
  }

  try {
    const result = await gmailPost('/labels', {
      name: name.trim(),
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }) as GmailLabel

    return NextResponse.json({
      success: true,
      label: { id: result.id, name: result.name, type: 'user', unread: 0, total: 0 },
    })
  } catch (err) {
    console.error('[labels] Create error:', err)
    return NextResponse.json({ error: 'Failed to create label' }, { status: 500 })
  }
}

/**
 * DELETE /api/inbox/labels — Delete a user-created Gmail label
 */
export async function DELETE(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { labelId } = await req.json()
  if (!labelId) {
    return NextResponse.json({ error: 'labelId is required' }, { status: 400 })
  }

  try {
    await gmailDelete(`/labels/${labelId}`)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[labels] Delete error:', err)
    return NextResponse.json({ error: 'Failed to delete label' }, { status: 500 })
  }
}
