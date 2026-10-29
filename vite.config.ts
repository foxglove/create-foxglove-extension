import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

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
    projects: [
      {
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        // The panel test harness runs in the browser, like the tests in generated extensions.
        optimizeDeps: {
          // Vite does not find this import in the .mts test files when it starts, and optimizing it
          // partway through a cold run reloads the tests
          include: ["vite-plus/test/browser"],
        },
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
