// @ts-check

import foxglove from "@foxglove/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["src/**/*.ts", "src/**/*.tsx"],
  extends: [foxglove.configs.base, foxglove.configs.react, foxglove.configs.typescript],
  languageOptions: {
    globals: {
      ...globals.es2020,
      ...globals.browser,
    },
    parserOptions: {
      project: "tsconfig.json",
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "react-hooks/exhaustive-deps": "error",
  },
});
