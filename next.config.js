const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'ydzipybqeebtpcvsbtvs.supabase.co',
        pathname: '/storage/**',
      },
    ],
  },
  async rewrites() {
    return [
      // Legacy td-offers URLs: offers domain /?t=TOKEN → /offer/TOKEN
      // These are handled by Vercel redirects in vercel.json
    ]
  },
  async redirects() {
    return [
      // Legacy contract-v2.html → static file
      {
        source: '/contract-v2.html',
        destination: '/contract-template.html',
        permanent: true,
      },
    ]
  },
}

module.exports = withSentryConfig(nextConfig, {
  // Sentry webpack plugin options
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true, // Don't log during build

  // Upload source maps for better error traces
  widenClientFileUpload: true,

  // Hide source maps from users
  hideSourceMaps: true,

  // Disable Sentry telemetry
  disableLogger: true,

  // Skip source map upload if no auth token (dev/CI without Sentry)
  authToken: process.env.SENTRY_AUTH_TOKEN,
})
