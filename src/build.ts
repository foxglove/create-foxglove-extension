import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import * as path from "path";
import type * as VitePlus from "vite-plus" with { "resolution-mode": "import" };

import { error, info } from "./log";
import { foxgloveExtension } from "./vite";

export interface BuildOptions {
  readonly entryPoint?: string;
  readonly mode?: "development" | "production";
  readonly cwd?: string;
}

// In the order Vite looks for them, so this finds the same file that `vp build` uses
const VITE_CONFIG_FILES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];

/**
 * Type check the extension, then build it into `dist/extension.js`.
 *
 * When the extension has a `vite.config.*` file it is used as-is and must include the
 * `foxgloveExtension()` plugin from `create-foxglove-extension/vite`. Otherwise the build uses
 * the plugin with its defaults.
 */
export async function buildCommand(options: BuildOptions = {}): Promise<void> {
  const mode =
    options.mode ?? (process.env.NODE_ENV === "production" ? "production" : "development");
  const extensionPath = path.resolve((options.cwd ?? process.cwd()).replace(/"$/, ""));

  const configFile = VITE_CONFIG_FILES.map((name) => path.join(extensionPath, name)).find((file) =>
    existsSync(file),
  );
  if (configFile != undefined) {
    info(`Using config file at ${configFile}`);
    if (options.entryPoint != undefined) {
      error(
        `Ignoring entryPoint, since ${configFile} configures the build. Pass the entry to foxgloveExtension() instead.`,
      );
    }
  }

  typeCheck(extensionPath);
  const vitePlus = await loadVitePlus(extensionPath);

  info("Building...");
  // Vite sets NODE_ENV to production during a build. Restore it so the default mode of a later
  // build in the same process is not affected.
  const nodeEnv = process.env.NODE_ENV;
  try {
    await vitePlus.build({
      root: extensionPath,
      mode,
      configFile: configFile ?? false,
      // An extension's own config can set its log level
      logLevel: configFile == undefined ? "warn" : undefined,
      plugins:
        configFile == undefined
          ? [foxgloveExtension({ entry: options.entryPoint })]
          : [requireFoxgloveExtensionPlugin(configFile)],
    });
  } finally {
    if (nodeEnv == undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = nodeEnv;
    }
  }
  info("Build complete");
}

/**
 * Load the extension's own vite-plus, falling back to the one next to this package. vite-plus
 * publishes a CommonJS entry, so it can be required from this CommonJS package.
 */
async function loadVitePlus(extensionPath: string): Promise<typeof VitePlus> {
  try {
    return createRequire(path.join(extensionPath, "package.json"))("vite-plus") as typeof VitePlus;
  } catch (err) {
    if (!isModuleNotFound(err, "vite-plus")) {
      throw err;
    }
  }
  try {
    return await import("vite-plus");
  } catch (err) {
    if (!isModuleNotFound(err, "vite-plus")) {
      throw err;
    }
    throw new Error(
      `Building an extension requires vite-plus. Install it with "npm install --save-dev vite-plus@^1".`,
    );
  }
}

function isModuleNotFound(err: unknown, name: string): boolean {
  const { code, message } = err as { code?: unknown; message?: unknown };
  return (
    (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") &&
    String(message).includes(`'${name}'`)
  );
}

/**
 * webpack type checked extensions as part of the build in 1.x. Vite removes types without checking
 * them, so run the extension's TypeScript first. Skipped when the extension has no tsconfig.json.
 */
function typeCheck(extensionPath: string): void {
  const tsconfig = path.join(extensionPath, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    return;
  }
  let tsc: string;
  try {
    tsc = require.resolve("typescript/bin/tsc", { paths: [extensionPath] });
  } catch (err) {
    if ((err as { code?: unknown }).code !== "MODULE_NOT_FOUND") {
      throw err;
    }
    throw new Error(
      `${tsconfig} exists, but typescript is not installed. Install it with "npm install --save-dev typescript".`,
    );
  }
  info("Type checking...");
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", tsconfig], {
    cwd: extensionPath,
    stdio: "inherit",
  });
  if (result.error != undefined) {
    throw new Error(`Could not run the type check: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      result.signal != undefined ? `Type check stopped by ${result.signal}` : "Type check failed",
    );
  }
}

/** Fails a build whose Vite config does not set up the extension build */
function requireFoxgloveExtensionPlugin(configFile: string): VitePlus.Plugin {
  return {
    name: "foxglove-extension:require-plugin",
    configResolved(config) {
      if (!config.plugins.some((plugin) => plugin.name === "foxglove-extension")) {
        throw new Error(
          `${configFile} must include foxgloveExtension() from create-foxglove-extension/vite`,
        );
      }
    },
  };
}
