'use client'

import { useEffect } from 'react'
import { FRAME_CHANGED } from '@/lib/marketing/lead-windows'

/**
 * Inside a lead window: when anything on the lead page saves (a button, a note, a payment link) the board behind the window must show the change too. Every save on these
 * pages is a non-GET request to our own marketing API, so this watches those and tells the board (same site only) to read the leads again. It changes nothing about the request.
 */
export function FrameChangeNotifier() {
  useEffect(() => {
    if (window.parent === window) return
    const original = window.fetch
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await original(...args)
      try {
        const req = args[0]
        const method = (args[1]?.method ?? (req instanceof Request ? req.method : 'GET')).toUpperCase()
        const url = typeof req === 'string' ? req : req instanceof Request ? req.url : String(req)
        if (method !== 'GET' && res.ok && /\/api\/marketing\//.test(url)) window.parent.postMessage({ type: FRAME_CHANGED }, window.location.origin)
      } catch { /* telling the board is a courtesy; the save already happened */ }
      return res
    }
    return () => { window.fetch = original }
  }, [])
  return null
}
