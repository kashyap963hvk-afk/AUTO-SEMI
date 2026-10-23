import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // WASM-backed packages are loaded from node_modules at runtime rather than bundled.
  serverExternalPackages: ["@electric-sql/pglite", "@yowasp/yosys"],
  // Recorded evidence and migrations are read from disk by API routes.
  outputFileTracingIncludes: {
    "/api/**/*": ["./evidence/**/*", "./migrations/**/*"],
    "/projects/**/*": ["./evidence/**/*", "./migrations/**/*"],
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
