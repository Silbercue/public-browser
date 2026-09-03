import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // CLI und Tooling-Scripts geben bewusst auf der Konsole aus
    files: ["scripts/**", "src/cli/**"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: ["build/", "node_modules/", "test-hardest/", "test-stress/", "research/"],
  }
);
