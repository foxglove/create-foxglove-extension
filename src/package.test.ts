import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import JSZip from "jszip";
import * as path from "path";
import { dirSync, setGracefulCleanup } from "tmp";

import { packageCommand } from "./package";

let tmpdir: string;

jest.setTimeout(120 * 1000);

jest.mock("./log.ts", () => ({
  info: jest.fn(),
  fatal: jest.fn((msg) => {
    throw new Error(`fatal() called: ${String(msg)}`);
  }),
}));

beforeAll(() => {
  setGracefulCleanup();
  tmpdir = dirSync({ unsafeCleanup: true }).name;
});

async function createFile(pathname: string, filename: string, contents = "") {
  const fullpath = path.join(pathname, filename);
  await writeFile(fullpath, contents);
}

describe("packageCommand", () => {
  it("packages an extension", async () => {
    // Actually creating a package is slow so we can fake it instead.
    await createFile(
      tmpdir,
      "package.json",
      JSON.stringify({
        name: "test",
        displayName: "test",
        homepage: "http://example.com",
        publisher: "test",
        version: "1.0.0",
        main: "./dist/extension.js",
      }),
    );
    await createFile(tmpdir, "CHANGELOG.md");
    await createFile(tmpdir, "README.md");
    await mkdir(path.join(tmpdir, "dist"));
    await createFile(path.join(tmpdir, "dist"), "extension.js");

    await packageCommand({ cwd: tmpdir });
    const contents = await readdir(tmpdir, { withFileTypes: true });

    const bundle = contents.find((file) => file.name === "test.test-1.0.0.foxe");
    const bundlePath = path.join(tmpdir, bundle!.name);
    const bundleData = await readFile(bundlePath);
    const archive = await JSZip.loadAsync(bundleData);
    expect(archive.files["dist\\extension.js"]).not.toBeDefined();
    expect(archive.files["dist/extension.js"]).toBeDefined();
  });
});
