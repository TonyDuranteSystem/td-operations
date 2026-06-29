import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureAdmin } from '@/lib/td-communication/admin-auth'
import { validateQuestionInput, type QuestionWriteInput } from '@/lib/td-communication/questions'
import { updateQuestion, softDeleteQuestion } from '@/lib/td-communication/questions-queries'

export const dynamic = 'force-dynamic'

/** PATCH /api/td-communication/admin/questions/[id] — edit a question. Admin only. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
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

  const { valid, errors } = validateQuestionInput(body, { isCreate: false })
  if (!valid) return NextResponse.json({ error: errors.join(' ') }, { status: 400 })

  try {
    const question = await updateQuestion(params.id, body)
    return NextResponse.json({ question })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update question.'
    const code = message === 'Question not found.' ? 404 : /already exists/.test(message) ? 409 : 500
    return NextResponse.json({ error: message }, { status: code })
  }
}

/** DELETE /api/td-communication/admin/questions/[id] — soft-delete (active=false). Admin only. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  try {
    await softDeleteQuestion(params.id)
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete question.'
    const code = message === 'Question not found.' ? 404 : 500
    return NextResponse.json({ error: message }, { status: code })
  }
}
