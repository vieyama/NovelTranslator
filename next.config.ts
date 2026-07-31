import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker deployment (see Dockerfile): copies only the files a production
  // server needs into .next/standalone, so the runtime image doesn't need
  // the full node_modules tree.
  output: "standalone",
};

export default nextConfig;
