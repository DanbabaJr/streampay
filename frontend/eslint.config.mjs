import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "next-env.d.ts",
      // Storybook + Playwright build output (docs/STORYBOOK.md).
      "storybook-static/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
]);

export default eslintConfig;
