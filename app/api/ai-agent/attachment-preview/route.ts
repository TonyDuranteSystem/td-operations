import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/ai-agent/attachment-preview?message_id=xxx&attachment_id=yyy
 * Proxies a Gmail attachment as an image response.
 * Admin-only. Used by the AI Agent chat to show inline image previews.
 */
export async function GET(request: NextRequest) {
  // Admin auth check
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const messageId = searchParams.get('message_id')
  const attachmentId = searchParams.get('attachment_id')
  const mimeType = searchParams.get('mime_type') || 'image/png'

  if (!messageId || !attachmentId) {
    return NextResponse.json({ error: 'message_id and attachment_id required' }, { status: 400 })
  }

  // Only allow image types
  if (!mimeType.startsWith('image/')) {
    return NextResponse.json({ error: 'Only image attachments can be previewed' }, { status: 400 })
  }

  try {
    const { getGmailAttachment } = await import('@/lib/gmail')
    const attachment = await getGmailAttachment(messageId, attachmentId)

    // Convert Buffer to Uint8Array for NextResponse compatibility
    const uint8 = new Uint8Array(attachment.data)
    return new NextResponse(uint8, {
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(uint8.length),
        'Cache-Control': 'private, max-age=300', // 5 min cache
      },
    })
  } catch (err) {
    console.error('[attachment-preview] Error:', err)
    const message = err instanceof Error ? err.message : 'Failed to fetch attachment'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const maxDuration = 30
