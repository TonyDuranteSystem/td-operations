/**
 * POST /api/accounts/correspondence
 * Upload a correspondence document for a client (account or contact).
 * - Uploads file to Drive → {account_folder}/Correspondence/
 * - Saves record in client_correspondence table (unread)
 * - Sends portal chat message to notify client
 *
 * GET /api/accounts/correspondence?account_id=xxx OR ?contact_id=xxx
 * List correspondence for CRM view.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { uploadBinaryToDrive, createFolder, listFolder } from '@/lib/google-drive'
import { createPortalNotification } from '@/lib/portal/notifications'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const accountId = formData.get('account_id') as string | null
  const contactId = formData.get('contact_id') as string | null
  const description = formData.get('description') as string | null

  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })
  if (!accountId && !contactId) return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })

  // Read file buffer
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const mimeType = file.type || 'application/octet-stream'
  const fileName = file.name

  let driveFileId: string | null = null
  let driveFileUrl: string | null = null
  let resolvedContactId = contactId

  // Upload to Drive if account has a folder
  if (accountId) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('drive_folder_id, company_name')
      .eq('id', accountId)
      .single()

    if (account?.drive_folder_id) {
      // Get or create Correspondence subfolder
      const folderContents = await listFolder(account.drive_folder_id) as { files: Array<{ id: string; name: string; mimeType: string }> }
      let correspondenceFolderId = folderContents.files?.find(
        (f) => f.name === 'Correspondence' && f.mimeType === 'application/vnd.google-apps.folder'
      )?.id
      if (!correspondenceFolderId) {
        const newFolder = await createFolder(account.drive_folder_id, 'Correspondence') as { id: string }
        correspondenceFolderId = newFolder.id
      }
      const uploaded = await uploadBinaryToDrive(fileName, buffer, mimeType, correspondenceFolderId) as { id: string; webViewLink?: string }
      driveFileId = uploaded.id
      driveFileUrl = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`
    }

    // Resolve contact_id from account if not provided
    if (!resolvedContactId) {
      const { data: link } = await supabaseAdmin
        .from('account_contacts')
        .select('contact_id')
        .eq('account_id', accountId)
        .limit(1)
        .single()
      resolvedContactId = link?.contact_id || null
    }
  }

  // Save to DB
  const { data: record, error } = await supabaseAdmin
    .from('client_correspondence')
    .insert({
      account_id: accountId || null,
      contact_id: resolvedContactId || null,
      file_name: fileName,
      drive_file_id: driveFileId,
      drive_file_url: driveFileUrl,
      description: description || null,
      uploaded_by: user.id,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Send portal chat message
  const chatMessage = `📬 You have new correspondence available. Please check your Documents → Correspondence section.`
  await supabaseAdmin.from('portal_messages').insert({
    account_id: accountId || null,
    contact_id: resolvedContactId || null,
    sender_type: 'admin',
    sender_id: user.id,
    message: chatMessage,
  })

  // Send push + email notification
  await createPortalNotification({
    account_id: accountId || undefined,
    contact_id: resolvedContactId || undefined,
    type: 'chat',
    title: '📬 New correspondence',
    body: `You have new correspondence: ${fileName}`,
    link: '/portal/documents',
  })

  return NextResponse.json({ correspondence: record })
}

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account_id')
  const contactId = searchParams.get('contact_id')

  if (!accountId && !contactId) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  let query = supabaseAdmin
    .from('client_correspondence')
    .select('*')
    .order('created_at', { ascending: false })

  if (accountId) {
    query = query.eq('account_id', accountId)
  } else if (contactId) {
    query = query.eq('contact_id', contactId).is('account_id', null)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ correspondence: data ?? [] })
}
