import { NextResponse } from 'next/server'

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
