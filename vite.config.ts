import { defineConfig } from "vite-plus";

import { fmtConfig, lintConfig } from "./src/viteConfig";

export default defineConfig({
  // lintConfig covers only src, which leaves out the template and examples. Those are standalone
  // projects with their own dependencies.
  lint: lintConfig,
  // The repo formats its docs and config too, not only src
  fmt: {
    ...fmtConfig,
    ignorePatterns: ["dist/**", "node_modules/**", "examples/**", ".yarn/**"],
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
