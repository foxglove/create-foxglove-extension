import { foxgloveExtension } from "create-foxglove-extension/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [foxgloveExtension()],
});
