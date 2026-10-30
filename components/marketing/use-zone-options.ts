'use client'

import { useEffect, useState } from 'react'
import { COMMON_ZONES, zoneOptions } from '@/lib/marketing/zones'

/**
 * The zones a picker offers. The list of every zone comes from the runtime (`Intl.supportedValuesOf`), and the server's list and the browser's list are not always the same, so the page the server
 * builds and the page the browser builds first would not match. Both start with the common zones; the browser's full list is added once the page is on screen.
 */
export function useZoneOptions(): Array<{ zone: string; label: string }> {
  const [list, setList] = useState<Array<{ zone: string; label: string }>>(() => [...COMMON_ZONES])
  useEffect(() => { setList(zoneOptions()) }, [])
  return list
}
