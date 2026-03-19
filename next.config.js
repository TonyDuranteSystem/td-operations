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
module.exports = nextConfig
