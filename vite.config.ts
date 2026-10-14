import { defineConfig } from "vite-plus";

import { fmtConfig, lintConfig } from "./src/viteConfig";

export default defineConfig({
  lint: {
    ...lintConfig,
    // The template and examples are standalone projects with their own dependencies.
    ignorePatterns: ["dist/**", "examples/**", "template/**"],
  },
  fmt: {
    ...fmtConfig,
    ignorePatterns: ["dist/**", "examples/**", ".yarn/**"],
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
