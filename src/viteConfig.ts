import type { OxfmtConfig } from "vite-plus/fmt" with { "resolution-mode": "import" };
import type { OxlintConfig } from "vite-plus/lint" with { "resolution-mode": "import" };

const UNUSED_VARS_OPTIONS = {
  vars: "all",
  args: "after-used",
  varsIgnorePattern: "^_",
  argsIgnorePattern: "^_",
} as const;

/**
 * Lint configuration for Foxglove extensions, for the `lint` block of `vite.config.mts`.
 *
 * The rules follow `@foxglove/eslint-plugin`, which earlier versions of this template used with
 * ESLint, wherever Oxlint has an equivalent. Type-aware rules and type checking run through
 * tsgolint, so `vp check` replaces separate `eslint` and `tsc --noEmit` runs.
 *
 * Spread it to customize individual rules:
 *
 * @example
 * ```ts
 * lint: {
 *   ...lintConfig,
 *   rules: { ...lintConfig.rules, "no-warning-comments": "off" },
 * },
 * ```
 */
export const lintConfig: OxlintConfig = {
  plugins: ["eslint", "typescript", "react", "import", "oxc", "unicorn"],
  categories: {
    correctness: "error",
  },
  // Oxlint lints node_modules unless a .gitignore excludes it
  ignorePatterns: ["dist/**", "node_modules/**"],
  options: {
    // Includes disable comments for rules that Oxlint does not implement
    reportUnusedDisableDirectives: "error",
    typeAware: true,
    typeCheck: true,
  },
  rules: {
    // Core rules
    curly: "error",
    "no-eval": "error",
    "no-implied-eval": "error",
    "no-new-func": "error",
    "no-param-reassign": "error",
    "no-underscore-dangle": ["error", { allowAfterThis: true }],
    "no-unused-expressions": ["error", { enforceForJSX: true }],
    "no-unused-vars": ["error", UNUSED_VARS_OPTIONS],
    "no-useless-rename": "error",
    // Track future work in an issue instead of a code comment
    "no-warning-comments": ["error", { location: "anywhere" }],
    "object-shorthand": "error",
    "prefer-arrow-callback": ["error", { allowNamedFunctions: true }],

    // Imports. Import order is handled by the formatter.
    "import/export": "error",
    "import/first": "error",
    "import/newline-after-import": "error",
    "import/no-duplicates": "error",
    "import/no-mutable-exports": "error",

    // TypeScript
    "typescript/await-thenable": "error",
    // `<T>x` assertions are not valid in JSX, so prefer `x as T` everywhere
    "typescript/consistent-type-assertions": ["error", { assertionStyle: "as" }],
    "typescript/explicit-module-boundary-types": "error",
    "typescript/no-base-to-string": "error",
    "typescript/no-confusing-non-null-assertion": "error",
    "typescript/no-deprecated": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-meaningless-void-operator": ["error", { checkNever: true }],
    "typescript/no-misused-promises": "error",
    "typescript/no-shadow": "error",
    "typescript/no-unnecessary-boolean-literal-compare": "error",
    "typescript/no-unnecessary-condition": "error",
    "typescript/no-unnecessary-type-assertion": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/only-throw-error": "error",
    "typescript/prefer-includes": "error",
    "typescript/prefer-nullish-coalescing": ["error", { ignoreConditionalTests: true }],
    "typescript/promise-function-async": "error",
    "typescript/restrict-template-expressions": [
      "error",
      {
        allowAny: false,
        allowBoolean: false,
        allowNullish: false,
        allowNumber: true,
        allowRegExp: false,
        allowNever: false,
      },
    ],
    "typescript/return-await": ["error", "always"],
    "typescript/strict-boolean-expressions": [
      "error",
      {
        allowString: true,
        allowNullableString: true,
        allowNumber: false,
        allowNullableNumber: false,
        allowNullableBoolean: false,
        allowNullableObject: true,
        allowAny: false,
      },
    ],
    "typescript/switch-exhaustiveness-check": "error",
    "typescript/use-unknown-in-catch-callback-variable": "error",

    // React
    // Panels assign `context.onRender`, which the React Compiler immutability rule reports as
    // mutating a prop.
    "react/immutability": "off",
    "react/exhaustive-deps": "error",
    "react/jsx-key": "error",
    "react/jsx-no-target-blank": ["error", { allowReferrer: true }],
    // Catches HTML attribute names in JSX, such as `fill-rule` instead of `fillRule`
    "react/no-unknown-property": "error",
    "react/rules-of-hooks": "error",
  },
};

/**
 * Format configuration for Foxglove extensions, for the `fmt` block of `vite.config.mts`.
 *
 * Matches the Prettier settings that earlier versions of this template used. Imports are sorted
 * into groups of packages, then internal paths, then relative paths.
 */
export const fmtConfig: OxfmtConfig = {
  ignorePatterns: ["dist/**", "node_modules/**"],
  arrowParens: "always",
  printWidth: 100,
  semi: true,
  tabWidth: 2,
  trailingComma: "all",
  sortPackageJson: false,
  sortImports: {
    groups: [
      ["builtin", "external"],
      ["internal", "subpath"],
      ["parent", "sibling", "index"],
      "style",
      "unknown",
    ],
    newlinesBetween: true,
  },
};
