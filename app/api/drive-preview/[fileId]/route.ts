/**
 * Drive File Preview — streams a file directly from Google Drive by file ID.
 * Dashboard users only. Used by the CRM file manager.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { downloadFileBinary } from '@/lib/google-drive'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  try {
    const { buffer, mimeType, fileName } = await downloadFileBinary(fileId)

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(fileName || 'file')}"`,
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (err) {
    console.error('[drive-preview] Error:', err)
    return NextResponse.json({ error: 'Failed to load file' }, { status: 500 })
  }
}
