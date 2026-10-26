import { mkdir, readdir, readFile, symlink, writeFile } from "fs/promises";
import * as path from "path";
import { dirSync, setGracefulCleanup } from "tmp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { buildCommand } from "./build";
import { foxgloveExtension } from "./vite";

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
// Smallest valid wasm module: magic number and version
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const INDEX_TS = `
import fs, { readFileSync } from "fs";
import * as path from "path";

import "./style.css";
import logo from "./logo.png";
import wasm from "./module.wasm";
import text from "./notes.txt?raw";

export function activate(ctx: { result: Record<string, unknown> }): void {
  ctx.result.logo = logo;
  ctx.result.wasm = wasm;
  ctx.result.text = text;
  ctx.result.joined = path.join("a", "b");
  ctx.result.fs = fs;
  ctx.result.readFileSync = readFileSync;
  ctx.result.nodeEnv = process.env.NODE_ENV;
  ctx.result.envDev = import.meta.env.DEV;
  ctx.result.envProd = import.meta.env.PROD;
  ctx.result.hasGlobal = typeof global.setTimeout === "function";
  ctx.result.lazy = import("./lazy").then((module) => module.value);
  ctx.result.wasmUrl = new URL("./module.wasm", import.meta.url).href;
  ctx.result.importMetaUrl = import.meta.url;
}
`;

type ExtensionModule = {
  exports: { activate?: (ctx: { result: Record<string, unknown> }) => void };
};

let projectDir: string;

// Each test runs a full build, which can take a while on a cold CI runner
vi.setConfig({ testTimeout: 60 * 1000 });

beforeEach(async () => {
  setGracefulCleanup();
  projectDir = dirSync({ unsafeCleanup: true }).name;
  await mkdir(path.join(projectDir, "src"));
  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({ name: "fixture", publisher: "test", version: "1.0.0" }),
  );
  await writeFile(path.join(projectDir, "src", "index.ts"), INDEX_TS);
  await writeFile(path.join(projectDir, "src", "style.css"), ".fixture-panel { color: red; }");
  await writeFile(path.join(projectDir, "src", "logo.png"), PNG);
  await writeFile(path.join(projectDir, "src", "module.wasm"), WASM);
  await writeFile(path.join(projectDir, "src", "notes.txt"), "raw text");
  await writeFile(path.join(projectDir, "src", "lazy.ts"), "export const value = 'lazy';");
  await writeFile(
    path.join(projectDir, "src", "env.d.ts"),
    `declare module "*.png" { const url: string; export default url; }
declare module "*.wasm" { const url: string; export default url; }
declare module "*?raw" { const text: string; export default text; }
declare const global: typeof globalThis;
declare module "*?worker&inline" { const Worker: new () => Worker; export default Worker; }
interface ImportMeta { readonly env: { readonly DEV: boolean; readonly PROD: boolean } }`,
  );
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  vi.unstubAllEnvs();
});

async function buildFixture(
  mode: "development" | "production",
  buildOptions: { minify?: boolean; sourcemap?: boolean } = {},
): Promise<string> {
  const { build } = await import("vite-plus");
  await build({
    root: projectDir,
    mode,
    configFile: false,
    logLevel: "silent",
    plugins: [foxgloveExtension()],
    build: buildOptions,
  });
  return await readFile(path.join(projectDir, "dist", "extension.js"), "utf8");
}

/** Evaluate a bundle the way Foxglove does and return what its `activate` reported. */
function evaluate(source: string): { result: Record<string, unknown>; styles: string[] } {
  const styles: string[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ setAttribute: () => undefined, textContent: "" }),
    head: { appendChild: (el: { textContent: string }) => styles.push(el.textContent) },
  };
  const extensionModule: ExtensionModule = { exports: {} };
  // Foxglove does not provide `global`, so shadow Node's to catch bundles that rely on it
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
  const loadExtension = new Function("module", "require", "global", source) as (
    module: ExtensionModule,
    require: () => undefined,
    global: undefined,
  ) => void;
  loadExtension(extensionModule, () => undefined, undefined);
  const result: Record<string, unknown> = {};
  extensionModule.exports.activate?.({ result });
  return { result, styles };
}

describe("foxgloveExtension", () => {
  it("emits a single CommonJS bundle that Foxglove can evaluate", async () => {
    const source = await buildFixture("production");

    expect(await readdir(path.join(projectDir, "dist"))).toEqual(["extension.js"]);
    expect(source).toMatch(/\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,/);

    const { result } = evaluate(source);
    expect(result.nodeEnv).toBe("production");
    expect(result.envDev).toBe(false);
    expect(result.envProd).toBe(true);
  });

  it("loads CommonJS dependencies written for sloppy mode, as webpack did", async () => {
    const packageDir = path.join(projectDir, "node_modules", "sloppy-counter");
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "sloppy-counter", main: "index.js" }),
    );
    // Assigning an undeclared variable, as some older emscripten output does
    await writeFile(
      path.join(packageDir, "index.js"),
      "counter = 0;\nmodule.exports = () => ++counter;",
    );
    await writeFile(
      path.join(projectDir, "src", "index.ts"),
      `import next from "sloppy-counter";
export function activate(ctx: { result: Record<string, unknown> }): void {
  ctx.result.count = next();
}`,
    );

    expect(evaluate(await buildFixture("production")).result.count).toBe(1);
    expect(evaluate(await buildFixture("development")).result.count).toBe(1);
  });

  it("keeps the source map out of extension.js when it is hidden", async () => {
    const { build } = await import("vite-plus");
    await build({
      root: projectDir,
      mode: "production",
      configFile: false,
      logLevel: "silent",
      plugins: [foxgloveExtension()],
      build: { sourcemap: "hidden" },
    });

    expect(await readdir(path.join(projectDir, "dist"))).toEqual(["extension.js"]);
    expect(await readFile(path.join(projectDir, "dist", "extension.js"), "utf8")).not.toContain(
      "sourceMappingURL",
    );
  });

  it("accepts build.lib: false and rejects output options under their deprecated name", async () => {
    const { build } = await import("vite-plus");
    const options = { root: projectDir, configFile: false as const, logLevel: "silent" as const };

    await build({ ...options, plugins: [foxgloveExtension()], build: { lib: false } });
    await expect(
      build({
        ...options,
        plugins: [foxgloveExtension()],
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        build: { rollupOptions: { output: { entryFileNames: "x.js" } } },
      }),
    ).rejects.toThrow(/build\.lib/);
  });

  it("respects minify and sourcemap settings from the Vite config", async () => {
    const source = await buildFixture("production", { minify: false, sourcemap: false });

    expect(source).toContain("function activate(ctx)");
    expect(source).not.toContain("sourceMappingURL");
    expect(evaluate(source).result.nodeEnv).toBe("production");
  });

  it("keeps code that contains a source map comment when source maps are off", async () => {
    await writeFile(
      path.join(projectDir, "src", "index.ts"),
      `export function activate(ctx: { result: Record<string, unknown> }): void {
  ctx.result.comment = "//# sourceMappingURL=" + "x";
  ctx.result.after = "still here";
}`,
    );

    const { result } = evaluate(await buildFixture("production", { sourcemap: false }));

    expect(result.comment).toBe("//# sourceMappingURL=x");
    expect(result.after).toBe("still here");
  });

  it("fails when extension code imports a Node.js module that has no browser version", async () => {
    await writeFile(
      path.join(projectDir, "src", "index.ts"),
      `import crypto from "crypto";
export function activate(ctx: { result: Record<string, unknown> }): void {
  ctx.result.crypto = crypto;
}`,
    );

    await expect(buildFixture("production")).rejects.toThrow(/Node\.js module "crypto"/);
  });

  it("fails when a worker would be emitted as a separate file", async () => {
    await writeFile(path.join(projectDir, "src", "echo.worker.ts"), "self.postMessage('ready');");
    await writeFile(
      path.join(projectDir, "src", "index.ts"),
      `import EchoWorker from "./echo.worker.ts?worker";
export function activate(ctx: { result: Record<string, unknown> }): void {
  ctx.result.worker = EchoWorker;
}`,
    );

    await expect(buildFixture("production")).rejects.toThrow(/\?worker&inline/);
  });

  it("fails when config.ts holds webpack configuration from 1.x", async () => {
    await writeFile(path.join(projectDir, "config.ts"), "module.exports = { webpack: (c) => c };");

    await expect(buildFixture("production")).rejects.toThrow(/config\.ts/);
  });

  it("uses the same config metadata marker as Vite+", async () => {
    // The plugin skips build-only work under this marker. Vite+ uses it for lazyPlugins, so this
    // fails if a Vite+ update renames it.
    const { lazyPlugins } = await import("vite-plus");
    vi.stubEnv("VP_RESOLVING_CONFIG_METADATA", "1");

    expect(lazyPlugins(() => [])).toBeUndefined();
  });

  it("leaves the config.ts check to builds, so linting and formatting still work", async () => {
    await writeFile(path.join(projectDir, "config.ts"), "module.exports = { webpack: (c) => c };");
    const { resolveConfig } = await import("vite-plus");

    // `vp check` and `vp fmt` resolve the config only for its metadata, which Vite+ marks
    vi.stubEnv("VP_RESOLVING_CONFIG_METADATA", "1");
    await expect(
      resolveConfig(
        { root: projectDir, configFile: false, logLevel: "silent", plugins: [foxgloveExtension()] },
        "build",
      ),
    ).resolves.toBeDefined();
    vi.unstubAllEnvs();
    await expect(buildFixture("production")).rejects.toThrow(/config\.ts/);
  });

  it("leaves the output options check to builds too", async () => {
    const { build, resolveConfig } = await import("vite-plus");
    const options = {
      root: projectDir,
      configFile: false as const,
      logLevel: "silent" as const,
      plugins: [foxgloveExtension()],
      build: { rolldownOptions: { output: { entryFileNames: "x.js" } } },
    };

    vi.stubEnv("VP_RESOLVING_CONFIG_METADATA", "1");
    await expect(resolveConfig(options, "build")).resolves.toBeDefined();
    vi.unstubAllEnvs();
    await expect(build(options)).rejects.toThrow(/build\.lib/);
  });

  it("detects webpack configuration under a quoted key", async () => {
    await writeFile(
      path.join(projectDir, "config.ts"),
      `module.exports = { "webpack": (config) => config };`,
    );

    await expect(buildFixture("production")).rejects.toThrow(/config\.ts/);
  });

  it("fails when the Vite config sets build.lib", async () => {
    const { build } = await import("vite-plus");
    await expect(
      build({
        root: projectDir,
        configFile: false,
        logLevel: "silent",
        plugins: [foxgloveExtension()],
        build: { lib: { entry: "src/index.ts", formats: ["es"] } },
      }),
    ).rejects.toThrow(/build\.lib/);
  });

  it("leaves Node.js modules alone for code that runs in Node.js", async () => {
    const [compatibility] = foxgloveExtension();
    const resolveId = compatibility?.resolveId as (
      this: unknown,
      source: string,
      importer: string,
      options: object,
    ) => Promise<unknown>;

    const serverContext = { environment: { config: { consumer: "server" } } };
    await expect(
      resolveId.call(serverContext, "fs", "/project/src/index.test.ts", {}),
    ).resolves.toBeUndefined();
    await expect(
      resolveId.call(serverContext, "path", "/project/src/index.test.ts", {}),
    ).resolves.toBeUndefined();
    const clientContext = { environment: { config: { consumer: "client" } } };
    await expect(resolveId.call(clientContext, "fs", "/project/src/index.ts", {})).resolves.toBe(
      "\0foxglove-extension:empty:fs",
    );
  });

  it("ignores a config.ts that is not webpack configuration", async () => {
    await writeFile(
      path.join(projectDir, "config.ts"),
      "// Settings that used to sit next to the webpack config\nexport const answer = 42;",
    );

    expect(evaluate(await buildFixture("production")).result.nodeEnv).toBe("production");
  });

  it("inlines assets, wasm, and raw imports", async () => {
    const { result } = evaluate(await buildFixture("production"));

    expect(result.logo).toMatch(/^data:image\/png;base64,/);
    expect(result.wasm).toBe(`data:application/wasm;base64,${WASM.toString("base64")}`);
    expect(result.text).toBe("raw text");
  });

  it("imports the default export of CommonJS packages that set __esModule, as webpack did", async () => {
    const packageDir = path.join(projectDir, "node_modules", "fake-umd");
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "fake-umd", main: "index.js" }),
    );
    await writeFile(
      path.join(packageDir, "index.js"),
      `Object.defineProperty(exports, "__esModule", { value: true });
exports.default = function Component() { return "component"; };`,
    );
    await writeFile(
      path.join(projectDir, "src", "index.ts"),
      `import Component from "fake-umd";
export function activate(ctx: { result: Record<string, unknown> }): void {
  ctx.result.component = typeof Component;
}`,
    );

    expect(evaluate(await buildFixture("production")).result.component).toBe("function");
  });

  it('warns that "type": "module" changes CommonJS default imports', async () => {
    await writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "fixture", publisher: "test", version: "1.0.0", type: "module" }),
    );
    const { build, createLogger } = await import("vite-plus");
    const logger = createLogger("silent");
    const warnings: string[] = [];
    logger.warn = (message: string) => {
      warnings.push(message);
    };

    await build({
      root: projectDir,
      configFile: false,
      customLogger: logger,
      plugins: [foxgloveExtension()],
    });

    expect(warnings.join("\n")).toContain('"type": "module"');
  });

  it("keeps license comments from dependencies in the minified bundle", async () => {
    const packageDir = path.join(projectDir, "node_modules", "licensed-lib");
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "licensed-lib", main: "index.js" }),
    );
    await writeFile(
      path.join(packageDir, "index.js"),
      `/**
 * @license licensed-lib v1.0.0
 * Copyright Example. MIT License.
 */
module.exports = function hello() { return "hello"; };`,
    );
    await writeFile(
      path.join(projectDir, "src", "index.ts"),
      `import hello from "licensed-lib";
export function activate(ctx: { result: Record<string, unknown> }): void {
  ctx.result.hello = hello();
}`,
    );

    const source = await buildFixture("production");

    expect(source).toContain("@license licensed-lib v1.0.0");
    expect(evaluate(source).result.hello).toBe("hello");
  });

  it("keeps inlined files out of the source map", async () => {
    await writeFile(path.join(projectDir, "src", "logo.png"), Buffer.alloc(20_000, 7));
    await writeFile(
      path.join(projectDir, "src", "module.wasm"),
      Buffer.concat([WASM, Buffer.alloc(20_000, 1)]),
    );

    const source = await buildFixture("production");
    const encoded =
      /sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/.exec(
        source,
      )?.[1];
    const map = JSON.parse(Buffer.from(encoded ?? "", "base64").toString("utf8")) as {
      sources: string[];
      sourcesContent: string[];
    };

    expect(map.sources.some((file) => file.endsWith("index.ts"))).toBe(true);
    expect(map.sourcesContent.join("")).not.toContain("base64,");
    // The 40 kB of inlined files appear once in the bundle, not again in the source map
    expect(encoded?.length).toBeLessThan(60_000);
  });

  it("inlines workers with their own source maps", async () => {
    await writeFile(
      path.join(projectDir, "src", "echo.worker.ts"),
      `import wasm from "./module.wasm";
import { readFileSync } from "fs";
self.postMessage(['ready', wasm, typeof readFileSync]);`,
    );
    await writeFile(
      path.join(projectDir, "src", "index.ts"),
      `import EchoWorker from "./echo.worker.ts?worker&inline";
export function activate(ctx: { result: Record<string, unknown> }): void {
  ctx.result.worker = EchoWorker;
}`,
    );

    const source = await buildFixture("production");

    expect(await readdir(path.join(projectDir, "dist"))).toEqual(["extension.js"]);
    // The worker is embedded as a string, with its own inline source map rather than a reference
    // to a .map file that is never emitted
    expect(source).toContain("`ready`");
    expect(source).toContain(WASM.toString("base64"));
    expect(source).not.toMatch(/sourceMappingURL=[^\s"'`]*\.map\b/);
    expect(source.match(/sourceMappingURL=data:application\/json/g)).toHaveLength(2);
  });

  it("injects CSS into the document instead of emitting a stylesheet", async () => {
    const { styles } = evaluate(await buildFixture("production"));

    expect(styles).toHaveLength(1);
    expect(styles[0]).toContain(".fixture-panel");
  });

  it("resolves path to a browser implementation and fs to an empty stub", async () => {
    const { result } = evaluate(await buildFixture("production"));

    expect(result.joined).toBe("a/b");
    expect(result.fs).toEqual({});
    expect(result.readFileSync).toBeUndefined();
  });

  it("defines import.meta.url so that new URL() with relative files works", async () => {
    const { result } = evaluate(await buildFixture("production"));

    expect(result.wasmUrl).toBe(`data:application/wasm;base64,${WASM.toString("base64")}`);
    expect(result.importMetaUrl).toBe("foxglove-extension://test.fixture/extension.js");
  });

  it("replaces global with globalThis", async () => {
    const { result } = evaluate(await buildFixture("production"));

    expect(result.hasGlobal).toBe(true);
  });

  it("bundles dynamic imports into the single output file", async () => {
    const { result } = evaluate(await buildFixture("production"));

    expect(await readdir(path.join(projectDir, "dist"))).toEqual(["extension.js"]);
    await expect(result.lazy).resolves.toBe("lazy");
  });

  it("wraps development builds in eval with their own source URL and source map", async () => {
    const source = await buildFixture("development");

    expect(source.startsWith("eval(")).toBe(true);
    const inner = JSON.parse(source.slice("eval(".length, source.lastIndexOf(")"))) as string;
    expect(inner).toMatch(/\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,/);
    expect(inner).toContain("//# sourceURL=foxglove-extension://test.fixture/extension.dev.js");

    const { result, styles } = evaluate(source);
    expect(result.nodeEnv).toBe("development");
    expect(result.envDev).toBe(true);
    expect(result.envProd).toBe(false);
    expect(styles).toHaveLength(1);
  });
});

describe("buildCommand", () => {
  it("builds with the plugin defaults when there is no vite config", async () => {
    await buildCommand({ cwd: projectDir, mode: "production" });

    const source = await readFile(path.join(projectDir, "dist", "extension.js"), "utf8");
    expect(evaluate(source).result.nodeEnv).toBe("production");
  });

  it("type checks the extension before building", async () => {
    await mkdir(path.join(projectDir, "node_modules"));
    await symlink(
      path.resolve("node_modules", "typescript"),
      path.join(projectDir, "node_modules", "typescript"),
      "junction",
    );
    await writeFile(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [] },
        files: ["src/index.ts"],
      }),
    );
    await writeFile(
      path.join(projectDir, "src", "index.ts"),
      `export const count: number = "one";`,
    );

    await expect(buildCommand({ cwd: projectDir, mode: "production" })).rejects.toThrow(
      /Type check failed/,
    );
  });

  it("fails when there is a tsconfig.json but typescript is not installed", async () => {
    await writeFile(path.join(projectDir, "tsconfig.json"), "{}");

    await expect(buildCommand({ cwd: projectDir, mode: "production" })).rejects.toThrow(
      /typescript is not installed/,
    );
  });

  it("builds with the extension's own vite-plus", async () => {
    await mkdir(path.join(projectDir, "node_modules"));
    await symlink(
      path.resolve("node_modules", "vite-plus"),
      path.join(projectDir, "node_modules", "vite-plus"),
      "junction",
    );

    await buildCommand({ cwd: projectDir, mode: "production" });

    const source = await readFile(path.join(projectDir, "dist", "extension.js"), "utf8");
    expect(evaluate(source).result.nodeEnv).toBe("production");
  });

  it("requires the foxgloveExtension plugin in the Vite config", async () => {
    await writeFile(path.join(projectDir, "vite.config.mjs"), "export default {};");

    await expect(buildCommand({ cwd: projectDir, mode: "production" })).rejects.toThrow(
      /must include foxgloveExtension\(\)/,
    );
  });

  it("rejects a webpack config.ts", async () => {
    await writeFile(path.join(projectDir, "config.ts"), "module.exports = { webpack: (c) => c };");

    await expect(buildCommand({ cwd: projectDir })).rejects.toThrow(/config\.ts/);
  });
});
