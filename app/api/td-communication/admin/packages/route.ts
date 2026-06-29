import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureStaff, ensureAdmin } from '@/lib/td-communication/admin-auth'
import { validatePackageInput, type PackageWriteInput } from '@/lib/td-communication/packages'
import { listPackages, createPackage } from '@/lib/td-communication/packages-queries'

export const dynamic = 'force-dynamic'

/** GET /api/td-communication/admin/packages — list all packages (incl. retired). Staff only. */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = await ensureStaff(user)
  if (gate) return gate

  try {
    const packages = await listPackages({ includeInactive: true })
    return NextResponse.json({ packages })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load packages.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** POST /api/td-communication/admin/packages — create a package. Admin only. */
export async function POST(req: NextRequest): Promise<NextResponse> {
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

  const { valid, errors } = validatePackageInput(body, { isCreate: true })
  if (!valid) return NextResponse.json({ error: errors.join(' ') }, { status: 400 })

  try {
    const pkg = await createPackage(body)
    return NextResponse.json({ package: pkg }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create package.'
    const code = /already exists/.test(message) ? 409 : 500
    return NextResponse.json({ error: message }, { status: code })
  }
}
