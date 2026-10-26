import { execSync } from "child_process";
import { readdir, readFile } from "fs/promises";
import * as path from "path";
import * as tar from "tar";
import { dirSync, setGracefulCleanup } from "tmp";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { createCommand, isSupportedNodeVersion } from "./create";
import { packageCommand } from "./package";

let tmpdir: string;

vi.setConfig({ testTimeout: 300 * 1000, hookTimeout: 300 * 1000 });

vi.mock("./log", () => ({
  info: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn((msg: unknown) => {
    throw new Error(`fatal() called: ${String(msg)}`);
  }),
}));

let packageTarball: string;

beforeAll(async () => {
  setGracefulCleanup();
  tmpdir = dirSync({ unsafeCleanup: true }).name;
  // Pack this repository so the generated extension builds with the code under test rather than
  // the published release.
  packageTarball = path.join(tmpdir, "create-foxglove-extension.tgz");
  // Run through a shell, since yarn is a .cmd script on Windows. yarn reports a failed build on
  // stdout, with the path to its log, so include it when the pack fails.
  try {
    execSync(`yarn pack --out "${packageTarball}"`, { stdio: "pipe" });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`yarn pack failed:\n${String(stdout)}\n${String(stderr)}`);
  }
  await tar.create(
    {
      gzip: true,
      file: path.join(tmpdir, "./template.tar.gz"),
    },
    ["./template"],
  );
});

describe("createCommand", () => {
  it("creates a skeleton extension package", async () => {
    await createCommand({
      name: "extension-test",
      cwd: tmpdir,
      dirname: tmpdir,
      createFoxgloveExtensionPackage: packageTarball,
    });

    const destDir = path.join(tmpdir, "extension-test");
    const contents = await readdir(destDir, { withFileTypes: true });

    const dirs = contents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const files = contents.filter((entry) => entry.isFile()).map((entry) => entry.name);

    expect(dirs).toHaveLength(3);
    expect(dirs).toContain(".vscode");
    expect(dirs).toContain("node_modules");
    expect(dirs).toContain("src");

    expect(files).toContain("CHANGELOG.md");
    expect(files).toContain("package.json");
    expect(files).toContain("README.md");
    expect(files).toContain("tsconfig.json");
    expect(files).toContain("package-lock.json");
    expect(files).toContain(".gitignore");
    expect(files).not.toContain("yarn.lock");

    const packageJsonStr = await readFile(path.join(destDir, "package.json"), { encoding: "utf8" });
    expect(packageJsonStr).not.toContain("${NAME}");
    expect(packageJsonStr).toContain("extension-test");
    const packageJson = JSON.parse(packageJsonStr) as Record<string, unknown>;
    expect(typeof (packageJson.devDependencies as Record<string, string>).react).toEqual("string");

    await packageCommand({ cwd: destDir }); // make sure the skeleton package is buildable and packagable

    // Foxglove loads a single script, so the build must not emit .d.ts, .css, or other files
    const builtContents = await readdir(path.join(destDir, "dist"), { withFileTypes: true });
    const builtFiles = builtContents.filter((entry) => entry.isFile()).map((entry) => entry.name);
    expect(builtFiles).toEqual(["extension.js"]);

    // Evaluate the bundle the same way Foxglove does, with only `module` and `require` in scope
    const source = await readFile(path.join(destDir, "dist", "extension.js"), { encoding: "utf8" });
    const extensionModule = { exports: {} as { activate?: (ctx: unknown) => void } };
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    const loadExtension = new Function("module", "require", source) as (
      module: typeof extensionModule,
      require: () => undefined,
    ) => void;
    loadExtension(extensionModule, () => undefined);
    const registerPanel = vi.fn();
    extensionModule.exports.activate?.({ registerPanel });
    expect(registerPanel).toHaveBeenCalledWith(expect.objectContaining({ name: "example-panel" }));
  });
});

describe("isSupportedNodeVersion", () => {
  it("accepts the Node.js versions that Vite+ supports", () => {
    expect(isSupportedNodeVersion("22.18.0")).toBe(true);
    expect(isSupportedNodeVersion("24.11.1")).toBe(true);
    expect(isSupportedNodeVersion("26.0.0")).toBe(true);
  });

  it("rejects older releases, and 23 and 25", () => {
    expect(isSupportedNodeVersion("20.18.0")).toBe(false);
    expect(isSupportedNodeVersion("22.17.1")).toBe(false);
    expect(isSupportedNodeVersion("24.10.0")).toBe(false);
    expect(isSupportedNodeVersion("25.2.0")).toBe(false);
  });
});
