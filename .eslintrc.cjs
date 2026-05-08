// Root ESLint — enforces the load-bearing seven principles.
// Per-package overrides live in each package's .eslintrc.

/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: ["./tsconfig.base.json", "./apps/*/tsconfig.json", "./packages/*/tsconfig.json"]
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: ["dist/", "node_modules/", "*.config.cjs", "*.config.js"],
  rules: {
    // ACL invariant I1: product code never imports @nangohq/node.
    // Only the gateway adapter directory is exempted via override below.
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@nangohq/node", "@nangohq/node/*"],
            message:
              "Do not import @nangohq/node directly. Use @aonex/connector-gateway. (HLD §17 / LLD I1)"
          }
        ]
      }
    ],
    // Discriminated-union exhaustiveness
    "@typescript-eslint/switch-exhaustiveness-check": "error",
    // Disallow `any`
    "@typescript-eslint/no-explicit-any": "error",
    // Force `import type` for type-only imports (works with verbatimModuleSyntax)
    "@typescript-eslint/consistent-type-imports": [
      "error",
      { prefer: "type-imports", fixStyle: "inline-type-imports" }
    ]
  },
  overrides: [
    {
      // The ONLY place @nangohq/node may be imported.
      files: ["packages/connector-gateway/src/adapters/nango/**/*.ts"],
      rules: { "no-restricted-imports": "off" }
    },
    {
      // Composition roots may import concrete classes across packages.
      // Everywhere else must depend on ports.
      files: ["apps/*/src/composition-root.ts"],
      rules: { "no-restricted-imports": "off" }
    }
  ]
};
