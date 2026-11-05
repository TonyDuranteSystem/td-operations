import { NextResponse } from 'next/server'
import { OWN_RELEASE_ID } from '@/lib/release/own-release'

export const dynamic = 'force-dynamic'

/**
 * GET /api/release → { version } — which release THIS deployment is (dev job dc629a3d).
 *
 * The open CRM pages ask this every minute and compare the answer with the release they were loaded with
 * (lib/hooks/use-release-check.ts). It is a constant baked into the build: NO database, NO Gmail, nothing to slow down or fail.
 * Behind the normal login (it is deliberately NOT in the middleware's public list; the commit is already public through
 * /api/health, but there is no reason to open a second public door). Never cached: a cached answer would hide a new release.
 */
export async function GET() {
  return NextResponse.json({ version: OWN_RELEASE_ID }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}
