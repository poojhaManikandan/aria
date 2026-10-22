/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The mock pipeline keeps all state in-process (in-memory event bus), so no
  // external services are required to run or demo the application.
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
};

export default nextConfig;
