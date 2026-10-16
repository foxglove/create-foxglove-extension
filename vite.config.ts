import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

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
    projects: [
      {
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        // The panel test harness runs in the browser, like the tests in generated extensions.
        test: {
          name: "browser",
          include: ["src/**/*.test.mts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
