const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Prevent webpack from bundling OpenTelemetry packages as vendor chunks
    // (Sentry injects OTel instrumentation which fails to chunk correctly in dev)
    serverComponentsExternalPackages: ['@opentelemetry/api', '@opentelemetry/core', '@opentelemetry/sdk-trace-base'],
    // Ship the repo SOURCE into the MCP serverless function so the read-only
    // codebase_read / codebase_search tools (Hermes operating-agent) can read it
    // at runtime. Scoped to the MCP route only. Source is code, not secrets;
    // the tools block .env/secrets/deps paths.
    outputFileTracingIncludes: {
      '/api/[transport]': [
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
