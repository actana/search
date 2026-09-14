import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "test-results/**",
      "packages/*/dist/**",
      "packages/*/node_modules/**",
      // drizzle-kit output: generated SQL and its journal, not hand-written code.
      "packages/search/drizzle/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,js,mjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-case-declarations": "off",
      "no-control-regex": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-undef": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "warn",
      "prefer-const": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
