// @ts-check

const foxglove = require("@foxglove/eslint-plugin");
const globals = require("globals");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config({
  ignores: ["dist/**", "examples/**", "template/**"],
  files: ["src/**/*.ts", "src/**/*.tsx"],
  extends: [foxglove.configs.base, foxglove.configs.jest, foxglove.configs.typescript],
  languageOptions: {
    globals: {
      ...globals.node,
    },
    parserOptions: {
      project: "tsconfig.json",
      tsconfigRootDir: __dirname,
    },
  },
});
