import { fmtConfig, foxgloveExtension, lintConfig } from "create-foxglove-extension/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  plugins: [foxgloveExtension()],
  lint: lintConfig,
  fmt: fmtConfig,
  test: {
    // Tests run in Chromium so panels render the same way they do in Foxglove. Set `headless` to
    // false, or run `npx vp test --browser.headless=false`, to watch the tests in a browser window.
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
