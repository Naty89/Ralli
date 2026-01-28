/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable experimental features for better Supabase integration
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

module.exports = nextConfig;
