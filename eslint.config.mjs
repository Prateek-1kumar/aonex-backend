// ESLint flat config (ESLint 9). Migrated from the legacy .eslintrc.cjs.
//
// Enforces the load-bearing principles:
//   - product code never imports @nangohq/node (ACL invariant I1)
//   - discriminated-union switch exhaustiveness (type-aware)
//   - no `any`
//   - `import type` for type-only imports (works with verbatimModuleSyntax)
//
// Type-aware rules use the typescript-eslint project service. tsconfigRootDir is
// pinned to this file's directory so per-package `eslint src/` invocations
// resolve tsconfigs from the repo root regardless of cwd.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/.next/**",
      "**/*.d.ts",
      "**/*.config.cjs",
      "**/*.config.js",
      "**/*.config.mjs",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ACL invariant I1: product code never imports @nangohq/node.
      // Only the gateway adapter dir + composition roots are exempted below.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@nangohq/node", "@nangohq/node/*"],
              message:
                "Do not import @nangohq/node directly. Use @aonex/connector-gateway. (HLD §17 / LLD I1)",
            },
          ],
        },
      ],
      // Underscore-prefixed identifiers are intentionally unused (the code's
      // existing convention for required-but-unused params/bindings).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Discriminated-union exhaustiveness (requires type information).
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // Disallow `any`.
      "@typescript-eslint/no-explicit-any": "error",
      // Force `import type` for type-only imports.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    // Test files get pragmatic latitude: `any` for mocks/fixtures and inline
    // `import("…").Type` casts when wiring up test doubles.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
  {
    // The ONLY place @nangohq/node may be imported.
    files: ["packages/connector-gateway/src/adapters/nango/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Composition roots may import concrete classes across packages.
    // Everywhere else must depend on ports.
    files: ["apps/*/src/composition-root.ts"],
    rules: { "no-restricted-imports": "off" },
  },
);
