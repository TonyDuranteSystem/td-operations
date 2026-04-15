const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Warnings in MCP tool files should not block production builds.
    // ESLint still runs in pre-commit (lint-staged) and pre-push hooks.
    ignoreDuringBuilds: true,
  },
  // Explicitly bundle the Unicode TTF fonts into every serverless function
  // that may touch lib/pdf/*. Vercel's output file tracing does not follow
  // `readFile(join(process.cwd(), 'public/fonts/*.ttf'))` calls automatically
  // because they are runtime-resolved paths, so without this the fonts are
  // left in /public as static assets and are NOT available at /var/task/public/
  // inside the function sandbox. See dev_task 208d20be + commit a8003b3e.
  outputFileTracingIncludes: {
    '/api/**/*': ['./public/fonts/**'],
    '/app/api/**/*': ['./public/fonts/**'],
  },
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
