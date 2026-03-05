const js = require("@eslint/js");
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const sveltePlugin = require("eslint-plugin-svelte");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

module.exports = [
  {
    ignores: ["node_modules/**", "renderer/dist/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: [
      "main.js",
      "preload.js",
      "preload-overlay.js",
      "config/**/*.js",
      "ipc/**/*.js",
      "services/**/*.js",
      "scripts/**/*.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "preserve-caught-error": "off",
      "svelte/no-inner-declarations": "off",
      "no-redeclare": ["error", { builtinGlobals: false }],
    },
  },
  {
    files: ["main.ts", "preload.ts", "preload-overlay.ts", "preload-crop.ts", "ipc/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "e2e/**/*.ts", "playwright.config.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  ...sveltePlugin.configs["flat/recommended"],
  {
    files: ["src/**/*.svelte"],
    languageOptions: {
      parserOptions: {
        parser: tsParser,
        ecmaVersion: "latest",
        sourceType: "module",
        extraFileExtensions: [".svelte"],
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "svelte/require-each-key": "off",
      "svelte/no-at-html-tags": "off",
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: [
      "main.js",
      "preload.js",
      "preload-overlay.js",
      "main.ts",
      "preload.ts",
      "preload-overlay.ts",
      "config/**/*.js",
      "ipc/**/*.js",
      "services/**/*.js",
      "scripts/**/*.js",
    ],
    rules: {
      "svelte/no-inner-declarations": "off",
    },
  },
  prettier,
];
