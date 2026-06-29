import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureAdmin } from '@/lib/td-communication/admin-auth'
import { validatePackageInput, type PackageWriteInput } from '@/lib/td-communication/packages'
import { updatePackage, softDeletePackage } from '@/lib/td-communication/packages-queries'

export const dynamic = 'force-dynamic'

/** PATCH /api/td-communication/admin/packages/[slug] — edit a package (slug immutable). Admin only. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { slug: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  let body: PackageWriteInput
  try {
    body = (await req.json()) as PackageWriteInput
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const { valid, errors } = validatePackageInput(body, { isCreate: false })
  if (!valid) return NextResponse.json({ error: errors.join(' ') }, { status: 400 })

  try {
    const pkg = await updatePackage(params.slug, body)
    return NextResponse.json({ package: pkg })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update package.'
    const code = message === 'Package not found.' ? 404 : 500
    return NextResponse.json({ error: message }, { status: code })
  }
}

/** DELETE /api/td-communication/admin/packages/[slug] — soft-delete (active=false). Admin only. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { slug: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  try {
    await softDeletePackage(params.slug)
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete package.'
    const code = message === 'Package not found.' ? 404 : 500
    return NextResponse.json({ error: message }, { status: code })
  }
}
