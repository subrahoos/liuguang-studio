import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // Keep the native SQLite binding in Node's server runtime. Bundling it into
  // Turbopack route chunks can leave authenticated pages with a missing
  // external module after a concurrent rebuild.
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // Background video uploads allow files up to 500 MiB. The proxy clones
    // request bodies before Route Handlers read them, so leave room for the
    // multipart boundary rather than silently truncating the media at 100 MiB.
    proxyClientMaxBodySize: "512mb",
  },
  turbopack: {
    ignoreIssue: [
      {
        path: "**/next.config.ts",
        title: "Encountered unexpected file in NFT list",
      },
    ],
  },
};

export default nextConfig;
