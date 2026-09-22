import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
