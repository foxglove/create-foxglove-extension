import { execSync, spawn } from "child_process";
import { constants, existsSync, readFileSync } from "fs";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { mkdirp } from "mkdirp";
import * as path from "path";
import sanitize from "sanitize-filename";
import * as tar from "tar";

import { info } from "./log";

// New extensions depend on exactly the release that created them, so the template and the build
// plugin match.
const { version: OWN_VERSION } = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

const DEPENDENCIES = [
  "@foxglove/extension@^2",
  "@types/react@^18",
  "@types/react-dom@^18",
  `create-foxglove-extension@${OWN_VERSION}`,
  "react@^18",
  "react-dom@^18",
  "typescript@^5",
  "vite-plus@~1.3.0",
];

export interface CreateOptions {
  readonly name: string;
  readonly cwd?: string;
  readonly dirname?: string;
  /**
   * Installed in place of the published create-foxglove-extension release, such as a path to a
   * local tarball. Used to test unreleased builds of this package.
   */
  readonly createFoxgloveExtensionPackage?: string;
}

export async function createCommand(options: CreateOptions): Promise<void> {
  const name = options.name;
  if (name !== sanitize(name)) {
    throw new Error(
      `Name "${name}" contains invalid characters. Choose a filename-compatible project name`,
    );
  }

  assertSupportedRuntime();

  const cwd = options.cwd ?? process.cwd();
  const dirname = options.dirname ?? __dirname;
  let tempDir;
  try {
    const extensionDir = path.join(cwd, name);
    if (await exists(extensionDir)) {
      throw new Error(`Directory "${extensionDir}" already exists`);
    }

    tempDir = await mkdtemp("extract-template-");
    await tar.extract({
      cwd: tempDir,
      file: path.join(dirname, "template.tar.gz"),
    });
    const templateDir = path.join(tempDir, "template");

    const replacements = new Map([["${NAME}", name]]);
    const files = await listFiles(templateDir);
    for (const file of files) {
      const srcFile = path.resolve(templateDir, file);
      const dstFile = path.resolve(extensionDir, file);
      await copyTemplateFile(srcFile, dstFile, replacements);
    }

    const localPackage = localPackageSpec(cwd, options.createFoxgloveExtensionPackage);
    const dependencies =
      localPackage == undefined
        ? DEPENDENCIES
        : DEPENDENCIES.map((dep) =>
            dep.startsWith("create-foxglove-extension@") ? localPackage : dep,
          );
    await installDependencies(extensionDir, dependencies);

    info(`Created Foxglove extension "${name}" at ${extensionDir}`);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * A path to a local tarball, with or without a `file:` prefix, is resolved against the directory
 * the command runs in, since npm installs it from inside the new extension. Other specs are
 * unchanged.
 */
function localPackageSpec(cwd: string, spec: string | undefined): string | undefined {
  if (spec == undefined) {
    return undefined;
  }
  const resolved = path.resolve(cwd, spec.replace(/^file:/, ""));
  return existsSync(resolved) ? resolved : spec;
}

/**
 * Quote an argument for the shell that `spawn` uses. cmd.exe treats `^` as an escape character
 * outside quotes, which would turn `@foxglove/extension@^2` into an exact version.
 */
function shellQuote(arg: string): string {
  if (process.platform === "win32") {
    return `"${arg}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The Node.js versions that Vite+ supports. Keep in sync with `engines` in package.json. */
export function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major >= 26;
}

/**
 * Vite+ needs a supported Node.js release, and npm 10 fails to install it with "Cannot read
 * properties of null (reading 'edgesOut')". Stop with an actionable message before creating any
 * files.
 */
function assertSupportedRuntime(): void {
  if (!isSupportedNodeVersion(process.versions.node)) {
    throw new Error(
      `create-foxglove-extension needs Node.js 24.11 or newer 24.x, 22.18 or newer 22.x, or 26 and later, and found Node.js ${process.versions.node}. Use Node.js 24.`,
    );
  }
  let version: string;
  try {
    version = execSync("npm --version", { encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(
      `create-foxglove-extension needs npm 11 or newer, and could not run "npm --version": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const major = Number(version.split(".")[0]);
  if (Number.isFinite(major) && major < 11) {
    throw new Error(
      `create-foxglove-extension needs npm 11 or newer, and found npm ${version}. Use Node.js 24, which includes npm 11, or run "npm install -g npm@11".`,
    );
  }
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(baseDir: string, curDir?: string): Promise<string[]> {
  let output: string[] = [];

  const curOrBaseDir = curDir ?? baseDir;
  const contents = await readdir(curOrBaseDir, { withFileTypes: true });
  for (const entry of contents) {
    if (entry.isDirectory()) {
      output = output.concat(await listFiles(baseDir, path.join(curOrBaseDir, entry.name)));
    } else if (entry.isFile()) {
      output.push(path.relative(baseDir, path.join(curOrBaseDir, entry.name)));
    }
  }

  return output;
}

async function copyTemplateFile(
  src: string,
  dst: string,
  replacements: Map<string, string>,
): Promise<void> {
  info(`creating ${dst}`);
  let contents = await readFile(src, { encoding: "utf8" });
  for (const [search, replacement] of replacements.entries()) {
    const regex = new RegExp(search.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g");
    contents = contents.replace(regex, replacement);
  }
  await mkdirp(path.dirname(dst));
  await writeFile(dst, contents);
}

async function installDependencies(extensionDir: string, deps: string[]): Promise<void> {
  const command = "npm";
  const args = ["install", "--save-exact", "--save-dev", ...deps];

  const commandLine = [command, ...args.map(shellQuote)].join(" ");
  info(commandLine);
  await new Promise<void>((resolve, reject) => {
    // A single command string, since Node.js deprecates passing arguments with `shell: true`
    const child = spawn(commandLine, {
      shell: true,
      stdio: "inherit",
      cwd: extensionDir,
      env: { ...process.env },
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`npm exited with code ${code ?? "<null>"}`));
        return;
      }
      resolve();
    });
  });
}
