import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // The transaction builder imports the canonical contract spec from
    // `sdks/spec/` so there is one source of truth. Turbopack only resolves
    // files under its root, so root at the repository (which also carries the
    // contributor package.json/package-lock.json) rather than `frontend/`.
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
