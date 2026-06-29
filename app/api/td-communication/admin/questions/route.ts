import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureStaff, ensureAdmin } from '@/lib/td-communication/admin-auth'
import { validateQuestionInput, type QuestionWriteInput } from '@/lib/td-communication/questions'
import { listQuestions, createQuestion } from '@/lib/td-communication/questions-queries'

export const dynamic = 'force-dynamic'

/** GET /api/td-communication/admin/questions — list all questions (incl. inactive). Staff only. */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = await ensureStaff(user)
  if (gate) return gate

  try {
    const questions = await listQuestions({ includeInactive: true })
    return NextResponse.json({ questions })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load questions.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** POST /api/td-communication/admin/questions — create a question. Admin only. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  let body: QuestionWriteInput
  try {
    body = (await req.json()) as QuestionWriteInput
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const { valid, errors } = validateQuestionInput(body, { isCreate: true })
  if (!valid) return NextResponse.json({ error: errors.join(' ') }, { status: 400 })

  try {
    const question = await createQuestion(body)
    return NextResponse.json({ question }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create question.'
    const code = /already exists/.test(message) ? 409 : 500
    return NextResponse.json({ error: message }, { status: code })
  }
}
