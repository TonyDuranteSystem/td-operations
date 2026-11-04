'use client'

import { useEffect, useState } from 'react'
import { NO_FEATURES, parseFeaturesReply, type OfferBuilderFeatures } from '@/lib/offers/rollout'

/**
 * Which NEW offer-builder pieces this screen may show for the record it is about (offer builder rollout, dev job d2971d11).
 * It asks the staff route /api/crm/admin-actions/offer-builder-features, which decides on the server (off / test / on, set by
 * Claude on Antonio's word — no screen, no button). Everything is hidden until a clean answer arrives, and anything but a
 * clean answer (expired login, error page, failed request) leaves everything hidden. While `enabled` is false nothing is asked.
 *
 * An answer belongs to the record it was asked about: if the screen is reused for another record, the old answer is not
 * shown for the new one. The last answer is kept while `enabled` flips (a closed window that opens again does not blink).
 *
 * Pass the ids the screen knows (an offer's `token` is enough for a draft offer).
 */
export function useOfferBuilderFeatures(
  subject: { leadId?: string | null; accountId?: string | null; contactId?: string | null; token?: string | null },
  enabled = true,
): OfferBuilderFeatures {
  const { leadId, accountId, contactId, token } = subject
  const key = `${leadId ?? ''}|${accountId ?? ''}|${contactId ?? ''}|${token ?? ''}`
  const [answer, setAnswer] = useState<{ key: string; features: OfferBuilderFeatures } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const qs = new URLSearchParams()
    if (leadId) qs.set('lead_id', leadId)
    if (accountId) qs.set('account_id', accountId)
    if (contactId) qs.set('contact_id', contactId)
    if (token) qs.set('token', token)
    fetch(`/api/crm/admin-actions/offer-builder-features?${qs.toString()}`, { cache: 'no-store' })
      .then(async (r) => parseFeaturesReply(r.ok, await r.json().catch(() => null)))
      .then((features) => { if (!cancelled) setAnswer({ key, features }) })
      .catch(() => { if (!cancelled) setAnswer({ key, features: NO_FEATURES }) })
    return () => { cancelled = true }
  }, [enabled, key, leadId, accountId, contactId, token])

  return answer && answer.key === key ? answer.features : NO_FEATURES
}
