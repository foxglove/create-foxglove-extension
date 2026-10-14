import { fmtConfig, foxgloveExtension, lintConfig } from "create-foxglove-extension/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [foxgloveExtension()],
  lint: lintConfig,
  fmt: fmtConfig,
});
