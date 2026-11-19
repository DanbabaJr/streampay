import * as fs from "node:fs";
import * as path from "node:path";
import { generateOpenApiSpec } from "../lib/openapi";

function main() {
  const spec = generateOpenApiSpec();
  const jsonContent = JSON.stringify(spec, null, 2) + "\n";

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
