import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const FRONTEND_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/link") {
    return nextResolve(pathToFileURL(path.join(FRONTEND_ROOT, "test/mocks/link.tsx")).href, context);
  }

  if (specifier === "next/navigation") {
    return nextResolve(pathToFileURL(path.join(FRONTEND_ROOT, "test/mocks/navigation.ts")).href, context);
  }

  if (specifier === "@stellar/freighter-api") {
    return nextResolve(pathToFileURL(path.join(FRONTEND_ROOT, "test/mocks/freighter.ts")).href, context);
  }

  if (specifier.startsWith("@/")) {
    const subpath = specifier.slice(2);
    const resolvedPath = path.join(FRONTEND_ROOT, subpath);
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"]) {
      try {
        const full = resolvedPath + ext;
        return await nextResolve(pathToFileURL(full).href, context);
      } catch {}
    }
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parentDir = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : FRONTEND_ROOT;
    const resolvedPath = path.resolve(parentDir, specifier);
    for (const ext of [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"]) {
      try {
        const full = resolvedPath + ext;
        return await nextResolve(pathToFileURL(full).href, context);
      } catch {}
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && (url.endsWith(".tsx") || (url.endsWith(".ts") && !url.includes("node_modules")))) {
    const filePath = fileURLToPath(url);
    const source = await readFile(filePath, "utf8");
    const { code } = esbuild.transformSync(source, {
      loader: url.endsWith(".tsx") ? "tsx" : "ts",
      format: "esm",
      jsx: "automatic",
      sourcefile: filePath,
    });
    return {
      format: "module",
      shortCircuit: true,
      source: code,
    };
  }
  return nextLoad(url, context);
}
