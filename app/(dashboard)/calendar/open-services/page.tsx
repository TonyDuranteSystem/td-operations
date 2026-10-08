import Link from 'next/link'
import * as Sentry from '@sentry/nextjs'
import { notFound } from 'next/navigation'
import { requireOpenServicesAccess } from '@/lib/open-services/audience'
import { loadOpenServicesInputs } from '@/lib/open-services/load'
import { buildOpenServices } from '@/lib/open-services/build'
import { parseParams, type RawSearchParams } from '@/lib/open-services/params'
import type { ViewModel } from '@/lib/open-services/types'
import { OpenServicesView } from '@/components/open-services/open-services-view'

/**
 * Open services (N1a C3, dev job be7da01a): every open job that is not a renewal or a tax return — who must move
 * next, how long it has sat, what is late. READ-ONLY. Switched by `open_services_audience` (off | owners | all).
 *
 * The guard runs FIRST and on EVERY request (this page is dynamic; nothing is cached). A denied visitor gets the
 * ordinary "page not found". A failed read shows "Could not load" — never an empty list that looks like all clear.
 * `notFound()` is called outside the try block on purpose (it works by throwing).
 */
export const dynamic = 'force-dynamic'

export default async function OpenServicesPage({ searchParams }: { searchParams: RawSearchParams }) {
  const access = await requireOpenServicesAccess()
  if (!access.ok) notFound()

  const params = parseParams(searchParams ?? {})

  let model: ViewModel | null = null
  try {
    const inputs = await loadOpenServicesInputs(access)
    model = buildOpenServices({ ...inputs, now: new Date() }, params)
  } catch (err) {
    console.error('[open-services] load failed:', err)
    // Also report it: a page that quietly says "Could not load" must still be visible to us (it only reaches the owners).
    Sentry.captureException(err, { tags: { area: 'open-services' } })
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Open services</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every open job that is not a renewal or a tax return: who has to move next, how long it has sat, and what is late.
        </p>
        <nav className="mt-3 flex gap-1 border-b text-sm" aria-label="Calendar pages">
          <Link href="/calendar" prefetch={false} className="-mb-px border-b-2 border-transparent px-3 py-2 text-muted-foreground hover:text-foreground">
            Renewals
          </Link>
          <span className="-mb-px border-b-2 border-blue-600 px-3 py-2 font-medium text-foreground" aria-current="page">
            Open services
          </span>
        </nav>
      </div>

      {model ? (
        <OpenServicesView model={model} params={params} />
      ) : (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
          <p className="font-medium">Could not load Open services.</p>
          <p className="mt-1">Nothing was changed, and nothing is hidden or fixed by this page. Reload to try again.</p>
        </div>
      )}
    </div>
  )
}
