import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @vektor/ui and @vektor/shared are workspace packages, not published —
  // Next needs to run them through its own compiler rather than treating
  // them as pre-built external deps.
  transpilePackages: ["@vektor/ui", "@vektor/shared"],
};

export default nextConfig;
