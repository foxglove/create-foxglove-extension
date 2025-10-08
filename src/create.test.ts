import { readdir, readFile } from "fs/promises";
import * as path from "path";
import * as tar from "tar";
import { dirSync, setGracefulCleanup } from "tmp";

import { createCommand } from "./create";
import { packageCommand } from "./package";

let tmpdir: string;

jest.setTimeout(300 * 1000);

jest.mock("./log.ts", () => ({
  info: jest.fn(),
  fatal: jest.fn((msg) => {
    throw new Error(`fatal() called: ${String(msg)}`);
  }),
}));

beforeAll(async () => {
  setGracefulCleanup();
  tmpdir = dirSync({ unsafeCleanup: true }).name;
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
    await createCommand({ name: "extension-test", cwd: tmpdir, dirname: tmpdir });

    const destDir = path.join(tmpdir, "extension-test");
    const contents = await readdir(destDir, { withFileTypes: true });

    const dirs = contents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const files = contents.filter((entry) => entry.isFile()).map((entry) => entry.name);

    expect(dirs).toHaveLength(2);
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

    // make sure the skeleton package is buildable and packagable
    await packageCommand({ cwd: destDir });

    // make sure we don't generate unneeded .d.ts files
    const builtContents = await readdir(path.join(destDir, "dist"), { withFileTypes: true });
    const builtFiles = builtContents.filter((entry) => entry.isFile()).map((entry) => entry.name);
    expect(builtFiles.some((name) => name.endsWith(".d.ts"))).toBe(false);
  });
});
