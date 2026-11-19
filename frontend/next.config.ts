import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // The repo root carries its own package.json/package-lock.json (the
    // contributor scripts wrapper). Without an explicit root, Turbopack
    // infers the workspace root from the nearest lockfile — which on
    // Netlify is the repo root — and warns on every deploy. Pin it to the
    // frontend directory so module resolution is unambiguous.
    root: path.join(__dirname),
  },
};

export default nextConfig;
