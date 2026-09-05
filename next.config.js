const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Prevent webpack from bundling OpenTelemetry packages as vendor chunks
    // (Sentry injects OTel instrumentation which fails to chunk correctly in dev)
    serverComponentsExternalPackages: [
      '@opentelemetry/api', '@opentelemetry/core', '@opentelemetry/sdk-trace-base',
      // @sparticuz/chromium ships its Chromium binary as a file it locates relative to
      // its own package folder at runtime. Webpack bundling relocates/rewrites the
      // package and breaks that lookup ("input directory .../bin does not exist") —
      // marking it (and puppeteer-core, which drives it) external keeps both untouched
      // so the traced output preserves their real node_modules layout.
      '@sparticuz/chromium', 'puppeteer-core',
    ],
    // Ship the repo SOURCE into the serverless functions that expose the
    // read-only codebase_read / codebase_search tools so they can read it at
    // runtime. Source is code, not secrets; the tools block .env/secrets/deps.
    //   - /api/[transport]        : MCP server (Hermes connects directly)
    //   - /api/cron/hermes-bridge : the server-side worker (sonnet) — without
    //     this, fs.readFile works locally but ENOENTs on Vercel.
    outputFileTracingIncludes: {
      // Marking @sparticuz/chromium external (above) stops webpack from relocating it,
      // but Next.js's own file tracer still decides which files actually ship in the
      // deployed function by following static require()/import calls — and this
      // package reaches its ~70MB of Chromium binary assets through a dynamic path at
      // runtime, which the tracer can't see. Without this, the package's JS ships but
      // its actual binaries don't, which is the exact failure already found live
      // ("input directory .../bin does not exist") even after marking it external.
      '/api/owner/export/pdf': [
        './node_modules/@sparticuz/chromium/bin/**',
      ],
      '/api/[transport]': [
        './app/**/*.{ts,tsx,js,jsx,sql,md,css}',
        './lib/**/*.{ts,tsx,js,jsx,sql}',
        './components/**/*.{ts,tsx,js,jsx,css}',
        './scripts/**/*.{ts,js,sql}',
        './middleware.ts',
        './next.config.js',
      ],
      '/api/cron/hermes-bridge': [
        './app/**/*.{ts,tsx,js,jsx,sql,md,css}',
        './lib/**/*.{ts,tsx,js,jsx,sql}',
        './components/**/*.{ts,tsx,js,jsx,css}',
        './scripts/**/*.{ts,js,sql}',
        './middleware.ts',
        './next.config.js',
      ],
    },
  },
  eslint: {
    // Warnings in MCP tool files should not block production builds.
    // ESLint still runs in pre-commit (lint-staged) and pre-push hooks.
    ignoreDuringBuilds: true,
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
