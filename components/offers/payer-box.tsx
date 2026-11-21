'use client'

import { useEffect, useRef } from 'react'
import { mountPayerBox } from '@/lib/offers/payer-box'
import type { OfferCredential } from '@/lib/offers/offer-api-client'

/** React wrapper around the shared "Is someone else paying?" box (dev job e62bc2b6). */
export function PayerBox({ cred, lang }: { cred: OfferCredential; lang?: string | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const { token, code, pass, preview } = cred
  useEffect(() => {
    if (!ref.current) return
    return mountPayerBox(ref.current, { token, code, pass, preview }, lang)
  }, [token, code, pass, preview, lang])
  return <div ref={ref} />
}
