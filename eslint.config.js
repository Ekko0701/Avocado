// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/dist/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "scripts/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: [
      "apps/desktop/src/main/**/*.ts",
      "apps/desktop/src/preload/**/*.ts",
      "apps/desktop/e2e/**/*.ts",
      "apps/desktop/test-support/**/*.ts",
      "packages/evidence/src/**/*.ts",
      "packages/remote/src/**/*.ts",
      "packages/workspace/src/**/*.ts",
      "packages/agent/src/**/*.ts",
      "packages/agent/test-support/**/*.{ts,mjs}",
      "**/*.config.{ts,js}",
    ],
    languageOptions: { globals: globals.node },
  },
);
