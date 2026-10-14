import type { OxfmtConfig } from "vite-plus/fmt" with { "resolution-mode": "import" };
import type { OxlintConfig } from "vite-plus/lint" with { "resolution-mode": "import" };

/** Ignores everything except TypeScript files in `src`, like the earlier ESLint setup */
function sourceOnly(): string[] {
  return [
    "/*",
    "!/src",
    "/src/**/*.*",
    // Directories can have a dot in their name too, and files in an ignored directory cannot be
    // included again
    "!/src/**/",
    "!/src/**/*.ts",
    "!/src/**/*.tsx",
    "!/src/**/*.mts",
    "!/src/**/*.cts",
  ];
}

const UNUSED_VARS_OPTIONS = {
  vars: "all",
  args: "after-used",
  varsIgnorePattern: "^_",
  argsIgnorePattern: "^_",
} as const;

/**
 * Lint configuration for Foxglove extensions, for the `lint` block of `vite.config.mts`.
 *
 * The rules follow the ESLint setup that earlier versions of this template used, from
 * `@foxglove/eslint-plugin` and the recommended configs it extends, wherever Oxlint has an
 * equivalent. Type-aware rules and type checking run through tsgolint, so `vp check` replaces the
 * `eslint` run. Oxlint's `correctness` rules for those plugins are also on, which report a few
 * problems the ESLint setup did not. Like that setup, it only lints `src`. If the extension's code is elsewhere, such as
 * an `entry` outside `src`, change `ignorePatterns` to cover it.
 *
 * Spread it to customize individual rules or the files it covers:
 *
 * @example
 * ```ts
 * lint: {
 *   ...lintConfig,
 *   ignorePatterns: [...lintConfig.ignorePatterns, "src/generated/**"],
 *   rules: { ...lintConfig.rules, "no-warning-comments": "off" },
 * },
 * ```
 */
export const lintConfig = {
  // The plugins that the earlier ESLint setup used. Oxlint's `oxc` and `unicorn` plugins would add
  // correctness rules that it never had.
  plugins: ["eslint", "typescript", "react", "import"],
  categories: {
    correctness: "error",
  },
  // Lint and type check only TypeScript in `src`, like the earlier ESLint setup. Files outside it,
  // such as scripts and config files, are often outside the tsconfig, where type-aware rules cannot
  // work, and JavaScript in `src` is usually generated, such as a wasm loader. This also keeps out
  // node_modules, which Oxlint lints unless a .gitignore excludes it.
  ignorePatterns: sourceOnly(),
  options: {
    // Includes disable comments for rules that Oxlint does not implement
    reportUnusedDisableDirectives: "error",
    typeAware: true,
    typeCheck: true,
  },
  rules: {
    // Core rules
    curly: "error",
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@mui/material",
            importNames: ["styled"],
            message: "@mui/styled has performance implications. Use tss-react/mui instead.",
          },
          {
            name: "@mui/styles",
            message: "@mui/styles has performance implications. Use tss-react/mui instead.",
          },
          {
            name: "@mui/material/styles/styled",
            message: "@mui/styled has performance implications. Use tss-react/mui instead.",
          },
          {
            name: "@emotion/styled",
            message: "@emotion/styled has performance implications. Use tss-react/mui instead.",
          },
        ],
      },
    ],
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

    // Imports. Import order is not enforced, since Oxlint has no import/order rule and sorting in
    // the formatter can reorder side effects.
    // TypeScript checks default and namespace imports, and these rules misread Vite imports such as
    // `./worker.ts?worker&inline` and `./file.ts?raw` when the file has no default export
    "import/default": "off",
    "import/namespace": "off",
    "import/export": "error",
    "import/first": "error",
    "import/newline-after-import": "error",
    // Vite treats `./worker.ts` and `./worker.ts?worker&inline` as different modules
    "import/no-duplicates": ["error", { considerQueryString: true }],
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
    // The correctness category includes the React Compiler rules, which earlier versions did not
    // enforce and extensions do not need. The immutability rule also reports the
    // `context.onRender = ...` assignment that every panel makes.
    "react/error-boundaries": "off",
    "react/globals": "off",
    "react/immutability": "off",
    "react/incompatible-library": "off",
    "react/preserve-manual-memoization": "off",
    "react/purity": "off",
    "react/refs": "off",
    "react/set-state-in-effect": "off",
    "react/set-state-in-render": "off",
    "react/static-components": "off",
    "react/use-memo": "off",
    "react/void-use-memo": "off",
    "react/exhaustive-deps": "error",
    "react/jsx-key": ["error", { checkFragmentShorthand: true }],
    "react/jsx-no-target-blank": ["error", { allowReferrer: true }],
    // Catches HTML attribute names in JSX, such as `fill-rule` instead of `fillRule`
    "react/no-unknown-property": "error",
    "react/rules-of-hooks": "error",

    // Rules that earlier versions enabled through the recommended ESLint, typescript-eslint, and
    // React configs that `@foxglove/eslint-plugin` extends
    "no-array-constructor": "error",
    "no-case-declarations": "error",
    "no-empty": "error",
    "no-empty-function": "error",
    "no-fallthrough": "error",
    "no-prototype-builtins": "error",
    "no-regex-spaces": "error",
    "no-useless-constructor": "error",
    "no-var": "error",
    "prefer-const": "error",
    "prefer-rest-params": "error",
    "prefer-spread": "error",
    "react/display-name": "error",
    "react/jsx-no-comment-textnodes": "error",
    "react/no-unescaped-entities": "error",
    "react/require-render-return": "error",
    "typescript/adjacent-overload-signatures": "error",
    "typescript/ban-ts-comment": ["error", { minimumDescriptionLength: 10 }],
    "typescript/ban-tslint-comment": "error",
    "typescript/class-literal-property-style": "error",
    "typescript/consistent-generic-constructors": "error",
    "typescript/no-confusing-void-expression": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-extraneous-class": "error",
    "typescript/no-generated-empty-object-type": "error",
    "typescript/no-inferrable-types": "error",
    "typescript/no-mixed-enums": "error",
    "typescript/no-namespace": "error",
    "typescript/no-non-null-asserted-nullish-coalescing": "error",
    "typescript/no-require-imports": "error",
    "typescript/no-unnecessary-template-expression": "error",
    "typescript/no-unnecessary-type-arguments": "error",
    "typescript/no-unnecessary-type-constraint": "error",
    "typescript/no-unnecessary-type-conversion": "error",
    "typescript/no-unnecessary-type-parameters": "error",
    "typescript/no-unsafe-enum-comparison": "error",
    "typescript/no-unsafe-function-type": "error",
    "typescript/non-nullable-type-assertion-style": "error",
    "typescript/prefer-find": "error",
    "typescript/prefer-for-of": "error",
    "typescript/prefer-function-type": "error",
    "typescript/prefer-literal-enum-member": "error",
    "typescript/prefer-optional-chain": "error",
    "typescript/prefer-promise-reject-errors": "error",
    "typescript/prefer-reduce-type-parameter": "error",
    "typescript/prefer-regexp-exec": "error",
    "typescript/prefer-return-this-type": "error",
    "typescript/prefer-string-starts-ends-with": "error",
    "typescript/related-getter-setter-pairs": "error",
    "typescript/restrict-plus-operands": [
      "error",
      {
        allowAny: false,
        allowBoolean: false,
        allowNullish: false,
        allowNumberAndString: false,
        allowRegExp: false,
      },
    ],
  },
} satisfies OxlintConfig;

/**
 * Format configuration for Foxglove extensions, for the `fmt` block of `vite.config.mts`.
 *
 * Matches the Prettier settings that earlier versions of this template used, and like that setup
 * only covers TypeScript in `src`.
 *
 * Imports are not sorted. The formatter would move imports across side-effect imports, such as
 * polyfills and stylesheets, which changes what runs first and which CSS wins.
 */
export const fmtConfig = {
  ignorePatterns: sourceOnly(),
  arrowParens: "always",
  printWidth: 100,
  semi: true,
  tabWidth: 2,
  trailingComma: "all",
  sortPackageJson: false,
  sortImports: false,
} satisfies OxfmtConfig;
