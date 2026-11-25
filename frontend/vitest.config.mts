import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The claim-scheduler and fee-stats logic is pure (no DOM, no RPC), so the
// tests run in the node environment. React components are not unit-tested here.
//
// Vitest suites use the `.spec.ts` extension; every other `*.test.ts` in this
// package runs on the Node built-in test runner (`node --test`), which does
// not discover `.spec.ts` files — so the two runners can never pick up each
// other's files.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["lib/**/*.spec.ts", "tests/**/*.spec.ts"],
  },
});
