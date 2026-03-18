import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'TD Portal',
    short_name: 'TD Portal',
    description: 'Tony Durante LLC - Client Portal',
    start_url: '/portal',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#2563eb',
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
    ],
  }
}
