import * as fs from "node:fs";
import * as path from "node:path";
// Explicit `.ts` extension: the gate runs this file with stock Node type
// stripping (`node --experimental-strip-types`), which only resolves an
// import that names the file — it cannot resolve extensionless `../lib/openapi`
// the way `tsx` does. `tsx` accepts the explicit extension too, so
// `npm run generate:openapi` keeps working either way.
import { generateOpenApiSpec } from "../lib/openapi.ts";

function main() {
  const spec = generateOpenApiSpec();
  // Determinism discipline: `generateOpenApiSpec()` returns a literal object
  // (stable key order, no timestamps), so `JSON.stringify` is already stable
  // across runs and platforms. Normalize line endings as well: a description
  // carrying `\r\n` must not make the committed artifact differ between a
  // CRLF checkout and CI (see `a3af379` and scripts/check_generated.sh).
  const jsonContent = (JSON.stringify(spec, null, 2) + "\n").replace(/\r\n?/g, "\n");

  const currentDir = import.meta.dirname || path.resolve(".");

  // 1. Output to frontend/public/openapi.json
  const publicDir = path.resolve(currentDir, "../public");
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  const publicOutPath = path.join(publicDir, "openapi.json");
  fs.writeFileSync(publicOutPath, jsonContent, "utf-8");
  console.log(`Generated OpenAPI spec at ${publicOutPath}`);

  // 2. Output to repo docs/openapi.json
  const docsDir = path.resolve(currentDir, "../../docs");
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  const docsOutPath = path.join(docsDir, "openapi.json");
  fs.writeFileSync(docsOutPath, jsonContent, "utf-8");
  console.log(`Generated OpenAPI spec at ${docsOutPath}`);
}

main();
