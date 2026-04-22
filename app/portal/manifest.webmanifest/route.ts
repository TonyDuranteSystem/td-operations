import { NextResponse } from 'next/server'

// Content is 100% static (no cookies, no DB, no request-dependent data).
// Force-static tells Next's build worker to cache the response indefinitely
// instead of attempting a dynamic prerender — which is flaky in CI and
// intermittently emits a false "no response returned from route handler"
// error on a handler that only has one branch (this one). See commit
// history on this file + failed CI run ee7f762.
export const dynamic = 'force-static'

export function GET() {
  return NextResponse.json(
    {
      name: 'TD Portal',
      short_name: 'TD Portal',
      description: 'Tony Durante LLC - Client Portal',
      start_url: '/portal',
      display: 'standalone',
      background_color: '#f8fafc',
      theme_color: '#BE1E2D',
      icons: [
        {
          src: '/portal-icons/icon-192.png',
          sizes: '192x192',
          type: 'image/png',
        },
        {
          src: '/portal-icons/icon-512.png',
          sizes: '512x512',
          type: 'image/png',
        },
        {
          src: '/portal-icons/icon-192-maskable.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'maskable',
        },
        {
          src: '/portal-icons/icon-512-maskable.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },
    {
      headers: {
        'Content-Type': 'application/manifest+json',
      },
    }
  )
}
