import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/tasks — Quick-create a task from CRM chat
 * Admin only.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const body = await request.json()
  const { task_title, description, priority, category, assigned_to, due_date, account_id, status } = body

  if (!task_title?.trim()) {
    return NextResponse.json({ error: 'task_title required' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const { data, error } = await supabaseAdmin
    .from('tasks')
    .insert({
      task_title: task_title.trim(),
      description: description?.trim() || null,
      priority: priority || 'Normal',
      category: category || null,
      assigned_to: assigned_to || 'Luca',
      due_date: due_date || null,
      account_id: account_id || null,
      status: status || 'To Do',
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ id: data.id })
}
