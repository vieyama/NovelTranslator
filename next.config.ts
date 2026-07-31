import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker deployment (see Dockerfile): copies only the files a production
  // server needs into .next/standalone, so the runtime image doesn't need
  // the full node_modules tree.
  output: "standalone",
  // better-sqlite3 ships prebuilt native binaries under a dynamically
  // computed path (per-platform/arch); belt-and-suspenders in case Next's
  // automatic output-file tracing doesn't follow that require() statically.
  outputFileTracingIncludes: {
    "/*": ["node_modules/better-sqlite3/**/*"],
  },
};

export default nextConfig;
