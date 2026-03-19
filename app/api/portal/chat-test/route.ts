import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'

export async function GET() {
  const supabase = createClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ auth: 'FAILED', error: error?.message })
  }

  // Try inserting a test message
  const { data, error: insertError } = await supabaseAdmin
    .from('portal_messages')
    .insert({
      account_id: '30c2cd96-03e4-43cf-9536-81d961b18b1d',
      sender_type: 'client',
      sender_id: user.id,
      message: 'Test message from debug endpoint',
    })
    .select()
    .single()

  return NextResponse.json({
    auth: 'OK',
    user_id: user.id,
    email: user.email,
    role: user.app_metadata?.role,
    message_insert: data ? 'OK' : 'FAILED',
    insert_error: insertError?.message,
  })
}
