import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { isBuiltin } from "module";
import * as path from "path";
import type { Plugin, Rolldown } from "vite-plus" with { "resolution-mode": "import" };

import { getPackageId } from "./extensions";

export interface FoxgloveExtensionPluginOptions {
  /**
   * Entry point of the extension, relative to the project root. The module must export an
   * `activate` function. Defaults to `src/index.ts`.
   */
  readonly entry?: string;
}

const EMPTY_MODULE_PREFIX = "\0foxglove-extension:empty:";

// Node.js file system modules have no meaning inside an extension. They resolve to an empty module
// so that code paths which never run in the browser, such as generated emscripten loaders that
// `require("fs")`, still bundle.
const EMPTY_NODE_MODULES = new Map<string, object>([
  ["fs", fs],
  ["node:fs", fs],
  ["fs/promises", fsPromises],
  ["node:fs/promises", fsPromises],
]);

/**
 * An empty stand-in for a Node.js module. The default export is an empty object and every named
 * export of the real module is `undefined`, so both `import fs from "fs"` and
 * `import { readFileSync } from "fs"` bundle.
 */
function emptyNodeModule(nodeModule: object): string {
  const exportNames = Object.keys(nodeModule).filter(
    (key) => key !== "default" && /^[A-Za-z_$][\w$]*$/.test(key),
  );
  return [
    "export default {};",
    ...exportNames.map((key) => `export const ${key} = undefined;`),
  ].join("\n");
}

/**
 * Resolves Node.js file system modules to empty modules, and loads `.wasm` imports without a query
 * as a base64 data URL default export. Vite does not support those imports, and extensions built
 * with earlier versions rely on the data URL. Used for the extension and for inlined workers.
 */
function moduleCompatibilityPlugin(): Plugin {
  return {
    name: "foxglove-extension:module-compatibility",
    enforce: "pre",
    async resolveId(source, importer, options) {
      // Code that runs in Node.js, such as Vitest tests outside the browser, keeps Node's modules
      if (this.environment.config.consumer === "server") {
        return undefined;
      }
      if (EMPTY_NODE_MODULES.has(source)) {
        return `${EMPTY_MODULE_PREFIX}${source}`;
      }
      if (!isBuiltin(source) || importer == undefined || /[\\/]node_modules[\\/]/.test(importer)) {
        return undefined;
      }
      // Vite replaces other Node.js modules with an empty object and only warns, so the extension
      // would fail at runtime instead. webpack failed the build. Dependencies are left alone, since
      // their "browser" field can map a Node.js module away on purpose.
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved?.id.startsWith("__vite-browser-external") === true) {
        this.error(
          `${importer} imports the Node.js module "${source}", which extensions cannot use. Use a browser package instead, and map it with resolve.alias in vite.config.ts if a dependency needs it.`,
        );
      }
      return resolved;
    },
    async load(id) {
      const nodeModule = id.startsWith(EMPTY_MODULE_PREFIX)
        ? EMPTY_NODE_MODULES.get(id.slice(EMPTY_MODULE_PREFIX.length))
        : undefined;
      if (nodeModule != undefined) {
        return emptyNodeModule(nodeModule);
      }
      if (!id.endsWith(".wasm")) {
        return undefined;
      }
      this.addWatchFile(id);
      const data = await fsPromises.readFile(id);
      return `export default ${JSON.stringify(`data:application/wasm;base64,${data.toString("base64")}`)};`;
    },
  };
}

/**
 * Vite plugin that builds a Foxglove extension.
 *
 * Foxglove loads an extension by evaluating `dist/extension.js` with
 * `new Function("module", "require", source)` and calling `module.exports.activate`. The host
 * only provides `module` and `require`, so the bundle must be a single CommonJS script that does
 * not reference a free `exports` binding, load any sibling files, or rely on `process`.
 *
 * The plugin configures a library build that meets those requirements:
 *
 * - Output is a single CommonJS file at `dist/extension.js` with `@foxglove/extension` external.
 * - Images, fonts, `.wasm` files, and other assets are inlined as data URLs.
 * - CSS is injected into the document at load time rather than emitted as a separate file.
 * - The bundle runs in strict mode, as ES modules do.
 * - `process.env.NODE_ENV`, `import.meta.env.DEV`, and `import.meta.env.PROD` follow the build
 *   mode, and `global` is replaced with `globalThis`.
 * - `path` resolves to `path-browserify` and `fs` resolves to an empty module.
 * - Dynamic `import()` calls are bundled into the same file.
 * - Inlined workers get the same `.wasm` and `fs` handling. Workers that would be emitted as
 *   separate files fail the build, since Foxglove cannot load them.
 * - Production builds embed an inline source map. Development builds wrap the bundle in a direct
 *   `eval` with its own source map so DevTools breakpoints bind to the original sources.
 * - A leftover webpack `config.ts` from create-foxglove-extension 1.x fails the build instead of
 *   being ignored.
 *
 * The plugin sets the options that the bundle format depends on, such as `build.lib` and
 * `build.outDir`. Setting `build.lib` or `build.rolldownOptions.output` in `vite.config.ts` fails
 * the build. `build.minify` and `build.sourcemap: false` from `vite.config.ts` are respected.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { foxgloveExtension } from "create-foxglove-extension/vite";
 * import { defineConfig } from "vite-plus";
 *
 * export default defineConfig({
 *   plugins: [foxgloveExtension()],
 * });
 * ```
 */
export function foxgloveExtension(options: FoxgloveExtensionPluginOptions = {}): Plugin[] {
  return [moduleCompatibilityPlugin(), buildPlugin(options.entry ?? "src/index.ts")];
}

function buildPlugin(entry: string): Plugin {
  let isBuild = false;
  let isDev = false;
  let hasSourceMap = true;
  let packageId = "unknown";
  let packageIdError: string | undefined;

  return {
    name: "foxglove-extension",
    enforce: "pre",

    config(userConfig, { command, mode }) {
      const shared = {
        resolve: {
          alias: [{ find: /^(node:)?path$/, replacement: require.resolve("path-browserify") }],
        },
        worker: {
          plugins: () => [moduleCompatibilityPlugin()],
        },
      };
      if (command !== "build") {
        return shared;
      }

      // Vite merges arrays from the two configs, which would add outputs rather than replace them
      if (
        userConfig.build?.lib != undefined ||
        userConfig.build?.rolldownOptions?.output != undefined
      ) {
        throw new Error(
          "foxgloveExtension() sets build.lib and build.rolldownOptions.output, so remove them from vite.config.ts",
        );
      }
      isBuild = true;
      isDev = mode === "development";
      hasSourceMap = userConfig.build?.sourcemap !== false;
      const root = path.resolve(userConfig.root ?? process.cwd());
      assertNoWebpackConfig(root);
      try {
        packageId = readPackageId(root);
      } catch (err) {
        packageIdError = err instanceof Error ? err.message : String(err);
      }
      return {
        ...shared,
        define: {
          "process.env.NODE_ENV": JSON.stringify(isDev ? "development" : "production"),
          // Vite derives these from NODE_ENV, which it sets to production for every build.
          "import.meta.env.DEV": JSON.stringify(isDev),
          "import.meta.env.PROD": JSON.stringify(!isDev),
          // webpack defined `global` for browser builds, and some packages still read it.
          global: "globalThis",
          // CommonJS output has no `import.meta`. A valid URL keeps `new URL(path, import.meta.url)`
          // working. Vite has already inlined the files those expressions refer to.
          "import.meta.url": JSON.stringify(
            `foxglove-extension://${encodeURIComponent(packageId)}/extension.js`,
          ),
        },
        build: {
          outDir: "dist",
          emptyOutDir: true,
          copyPublicDir: false,
          minify: userConfig.build?.minify ?? !isDev,
          // Inline so that inlined workers carry their own source maps. `generateBundle` moves the
          // main bundle's source map after the CSS snippet.
          sourcemap: hasSourceMap ? "inline" : false,
          // Everything must live in the single extension.js file.
          assetsInlineLimit: () => true,
          cssCodeSplit: false,
          lib: {
            entry,
            formats: ["cjs"],
            fileName: () => "extension.js",
          },
          rolldownOptions: {
            external: ["@foxglove/extension"],
            output: {
              // Foxglove loads a single file, so dynamic imports cannot become separate chunks.
              codeSplitting: false,
              exports: "named",
              // The extension's own code is ES modules, which are strict. This also makes bundled
              // CommonJS dependencies strict, as ES module output from Vite would. webpack ran
              // those in sloppy mode.
              strict: true,
              // Foxglove evaluates the bundle with only `module` and `require` in scope.
              intro: "var exports = module.exports;",
            },
          },
        },
      };
    },

    configResolved(config) {
      if (packageIdError != undefined) {
        config.logger.warn(
          `Could not read the extension name from package.json, so the build uses "unknown": ${packageIdError}`,
        );
      }
    },

    generateBundle: {
      // Vite emits the library stylesheet in its own generateBundle hook, so this runs after it.
      order: "post",
      handler(_outputOptions, bundle) {
        if (!isBuild) {
          return;
        }

        let css = "";
        for (const [fileName, output] of Object.entries(bundle)) {
          if (output.type === "asset" && fileName.endsWith(".css")) {
            css +=
              typeof output.source === "string"
                ? output.source
                : Buffer.from(output.source).toString("utf8");
            delete bundle[fileName];
          }
        }

        const chunk = Object.values(bundle).find(
          (output): output is Rolldown.OutputChunk => output.type === "chunk" && output.isEntry,
        );
        if (chunk == undefined) {
          return;
        }

        // Foxglove only loads extension.js, so any other file would be missing at runtime.
        const extraFiles = Object.keys(bundle).filter((fileName) => fileName !== chunk.fileName);
        if (extraFiles.length > 0) {
          this.error(
            `The build emitted ${extraFiles.join(", ")} in addition to extension.js, but Foxglove only loads extension.js. Import workers with "?worker&inline" so they are embedded in the bundle.`,
          );
        }

        let code = hasSourceMap ? stripSourceMappingUrl(chunk.code) : chunk.code;
        if (css.length > 0) {
          // Appended rather than prepended so that no source map positions move. Panels render
          // after `activate` is called, which is after the whole bundle has run.
          code += `\n${cssInjectionSnippet(css)}`;
        }
        if (chunk.map != undefined) {
          const encodedMap = Buffer.from(chunk.map.toString()).toString("base64");
          code += `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${encodedMap}`;
        }

        if (isDev) {
          // `new Function` prepends a two-line header to the source it compiles, so every position
          // in an inline source map is off by two lines and DevTools breakpoints never bind. A
          // direct eval compiles the bundle as its own script that starts at line one, and it
          // still sees the `module` and `require` parameters of the enclosing function.
          code += `\n//# sourceURL=foxglove-extension://${encodeURIComponent(packageId)}/extension.dev.js\n`;
          code = `eval(${JSON.stringify(code)});`;
        }

        chunk.code = `${code}\n`;
        chunk.map = null;
      },
    },
  };
}

/** Removes the source map comment that the bundler appends on its own last line */
function stripSourceMappingUrl(code: string): string {
  return code.replace(/(^|\n)\/\/# sourceMappingURL=data:[^\n]*\n?$/, "");
}

function cssInjectionSnippet(css: string): string {
  return `(function(){if(typeof document==="undefined"){return;}var style=document.createElement("style");style.setAttribute("data-foxglove-extension","");style.textContent=${JSON.stringify(css)};document.head.appendChild(style);})();`;
}

function readPackageId(root: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    publisher?: string;
  };
  return getPackageId(pkg);
}

/**
 * create-foxglove-extension 1.x applied the `webpack` function exported from `config.ts`. Vite never
 * reads that file, so fail rather than silently drop customizations like `worker-loader`.
 */
function assertNoWebpackConfig(root: string): void {
  const configPath = path.join(root, "config.ts");
  // 1.x called `config.webpack(...)`, so look for a `webpack` property or function, quoted or not
  if (
    !fs.existsSync(configPath) ||
    !/\bwebpack\b["']?\s*[:(=]/.test(fs.readFileSync(configPath, "utf8"))
  ) {
    return;
  }
  throw new Error(
    `Found webpack configuration in ${configPath}. Extensions are built with Vite as of create-foxglove-extension 2.0, and config.ts is no longer applied. Move any customizations into vite.config.ts and delete config.ts. See node_modules/create-foxglove-extension/MIGRATING.md or https://github.com/foxglove/create-foxglove-extension/blob/main/MIGRATING.md`,
  );
}
