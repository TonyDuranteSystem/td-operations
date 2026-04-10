import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { repairContactFolderLinks } from '@/app/(dashboard)/contacts/folder-actions'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST /api/admin/repair-contact-folders
 * One-time repair: fixes contacts pointing to company root → 2. Contacts subfolder.
 * Requires dashboard admin auth.
 */
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const result = await repairContactFolderLinks()
  return NextResponse.json(result)
}
