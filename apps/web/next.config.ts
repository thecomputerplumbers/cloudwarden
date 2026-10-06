import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: [
    "@workspace/auth",
    "@workspace/mcp",
    "@workspace/email",
    "@workspace/stripe",
    "@workspace/ui",
    "@workspace/ui-data",
    "@workspace/ui-forms",
    "@workspace/ui-shell",
  ],
}

export default nextConfig
