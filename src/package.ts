import { spawn } from "child_process";
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, readFile, readdir, stat, realpath } from "fs/promises";
import JSZip from "jszip";
import ncp from "ncp";
import fetch from "node-fetch";
import { homedir } from "os";
import { join, normalize, relative, sep } from "path";
import rimraf from "rimraf";
import { promisify } from "util";

import { getPackageDirname, getPackageId, parsePackageName } from "./extensions";
import { info } from "./log";

const cpR = promisify(ncp);

// A fixed date is used for zip file modification timestamps to
// produce deterministic .foxe files. Foxglove birthday.
const MOD_DATE = new Date("2021-02-03");

export interface PackageManifest {
  id: string;
  name: string;
  displayName: string;
  description: string;
  publisher?: string;
  namespaceOrPublisher: string;
  homepage?: string;
  license?: string;
  keywords?: string[];
  version: string;
  main: string;
  files?: string[];
  scripts?: {
    "foxglove:prepublish"?: string;
  };
}

export interface PackageOptions {
  readonly cwd?: string;
  readonly packagePath?: string;
}

export interface InstallOptions {
  readonly cwd?: string;
}

export interface PublishOptions {
  foxe?: string;
  cwd?: string;
  version?: string;
  readme?: string;
  changelog?: string;
}

enum FileType {
  File,
  Directory,
  FileOrDirectory,
}

export async function packageCommand(options: PackageOptions = {}): Promise<void> {
  const extensionPath = options.cwd ?? process.cwd();

  const pkg = await readManifest(extensionPath);

  await prepublish(extensionPath, pkg);

  const files = await collect(extensionPath, pkg);

  const packagePath = normalize(
    options.packagePath ?? join(extensionPath, getPackageDirname(pkg) + ".foxe"),
  );

  await writeFoxe(extensionPath, files, packagePath);
}

export async function installCommand(options: InstallOptions = {}): Promise<void> {
  const extensionPath = options.cwd ?? process.cwd();

  const pkg = await readManifest(extensionPath);

  await prepublish(extensionPath, pkg);

  const files = await collect(extensionPath, pkg);

  await install(files, extensionPath, pkg);
}

export async function publishCommand(options: PublishOptions): Promise<void> {
  const foxeUrl = options.foxe;
  if (foxeUrl == undefined) {
    throw new Error(`--foxe <foxe> Published .foxe file URL is required`);
  }

  // Open the package.json file
  const extensionPath = options.cwd ?? process.cwd();
  const pkgPath = join(extensionPath, "package.json");
  const pkg = await readManifest(extensionPath);

  const publisher = pkg.namespaceOrPublisher;
  if (publisher == undefined || publisher.length === 0 || publisher === "unknown") {
    throw new Error(`Invalid publisher "${publisher}" in ${pkgPath}`);
  }

  const homepage = pkg.homepage;
  if (homepage == undefined || homepage.length === 0) {
    throw new Error(`Missing required field "homepage" in ${pkgPath}`);
  }
  const license = pkg.license;
  if (license == undefined || license.length === 0) {
    throw new Error(`Missing required field "license" in ${pkgPath}`);
  }
  const version = options.version ?? pkg.version;
  if (version == undefined || version.length === 0) {
    throw new Error(`Missing required field "version" in ${pkgPath}`);
  }
  if (version === "0.0.0") {
    throw new Error(`Invalid version "${version}" in ${pkgPath}`);
  }
  const keywords = JSON.stringify(pkg.keywords ?? []);
  const readme = options.readme ?? (await githubRawFile(homepage, "README.md"));
  if (readme == undefined || readme.length === 0) {
    throw new Error(`Could not infer README.md URL. Use --readme <url>`);
  }
  const changelog = options.changelog ?? (await githubRawFile(homepage, "CHANGELOG.md"));
  if (changelog == undefined || changelog.length === 0) {
    throw new Error(`Could not infer CHANGELOG.md URL. Use --changelog <url>`);
  }

  // Fetch the .foxe file and compute the SHA256 hash
  const res = await fetch(foxeUrl);
  const foxeData = await res.arrayBuffer();
  const hash = createHash("sha256");
  const sha256sum = hash.update(new Uint8Array(foxeData)).digest("hex");

  // Print the extension.json entry
  info(`
  {
    "id": "${pkg.id}",
    "name": "${pkg.displayName ?? pkg.name}",
    "description": "${pkg.description}",
    "publisher": "${pkg.namespaceOrPublisher}",
    "homepage": "${homepage}",
    "readme": "https://raw.githubusercontent.com/foxglove/studio-extension-turtlesim/main/README.md",
    "changelog": "https://raw.githubusercontent.com/foxglove/studio-extension-turtlesim/main/CHANGELOG.md",
    "license": "${license}",
    "version": "${version}",
    "sha256sum": "${sha256sum}",
    "foxe": "${foxeUrl}",
    "keywords": ${keywords}
  }
`);
}

async function readManifest(extensionPath: string): Promise<PackageManifest> {
  const pkgPath = join(extensionPath, "package.json");
  let pkg: unknown;
  try {
    pkg = JSON.parse(await readFile(pkgPath, { encoding: "utf8" }));
  } catch (err) {
    throw new Error(`Failed to load ${pkgPath}: ${String(err)}`);
  }

  const manifest = pkg as PackageManifest;
  if (typeof manifest.name !== "string") {
    throw new Error(`Missing required field "name" in ${pkgPath}`);
  }
  if (typeof manifest.version !== "string") {
    throw new Error(`Missing required field "version" in ${pkgPath}`);
  }
  if (typeof manifest.main !== "string") {
    throw new Error(`Missing required field "main" in ${pkgPath}`);
  }
  if (manifest.files != undefined && !Array.isArray(manifest.files)) {
    throw new Error(`Invalid "files" entry in ${pkgPath}`);
  }

  const publisher = manifest.publisher ?? parsePackageName(manifest.name).namespace;
  if (publisher == undefined || publisher.length === 0) {
    throw new Error(`Unknown publisher, add a "publisher" field to package.json`);
  }
  manifest.namespaceOrPublisher = publisher;
  manifest.id = getPackageId(manifest);

  return manifest;
}

async function prepublish(extensionPath: string, pkg: PackageManifest): Promise<void> {
  const script = pkg.scripts?.["foxglove:prepublish"];
  if (script == undefined) {
    return;
  }

  info(`Executing prepublish script 'yarn run foxglove:prepublish'...`);

  await new Promise<void>((c, e) => {
    const tool = "yarn";
    const cwd = extensionPath;
    const child = spawn(tool, ["run", "foxglove:prepublish"], {
      cwd,
      shell: true,
      stdio: "inherit",
    });
    child.on("exit", (code) =>
      code === 0 ? c() : e(`${tool} failed with exit code ${code ?? "<null>"}`),
    );
    child.on("error", e);
  });
}

async function collect(extensionPath: string, pkg: PackageManifest): Promise<string[]> {
  const files = new Set<string>();

  const baseFiles = [
    join(extensionPath, "package.json"),
    join(extensionPath, "README.md"),
    join(extensionPath, "CHANGELOG.md"),
    join(extensionPath, pkg.main),
  ];

  for (const file of baseFiles) {
    if (!(await pathExists(file, FileType.File))) {
      throw new Error(`Missing required file ${file}`);
    }
    files.add(file);
  }

  if (pkg.files != undefined) {
    for (const relFile of pkg.files) {
      const file = join(extensionPath, relFile);
      if (!inDirectory(extensionPath, file)) {
        throw new Error(`File ${file} is outside of the extension directory`);
      }
      if (!(await pathExists(file, FileType.FileOrDirectory))) {
        throw new Error(`Missing required path ${file}`);
      }
      files.add(file);
    }
  } else {
    const distDir = join(extensionPath, "dist");
    if (!(await pathExists(distDir, FileType.Directory))) {
      throw new Error(`Missing required directory ${distDir}`);
    }
    files.add(distDir);
  }

  return Array.from(files.values())
    .map((f) => relative(extensionPath, f))
    .sort();
}

async function writeFoxe(baseDir: string, files: string[], outputFile: string): Promise<void> {
  const zip = new JSZip();
  for (const file of files) {
    if (await isDirectory(join(baseDir, file))) {
      await addDirToZip(zip, baseDir, file);
    } else {
      addFileToZip(zip, baseDir, file);
    }
  }

  info(`Writing archive to ${outputFile}`);
  return await new Promise((c, e) => {
    zip
      .generateNodeStream({ type: "nodebuffer", streamFiles: true })
      .pipe(createWriteStream(outputFile, { encoding: "binary" }) as NodeJS.WritableStream)
      .on("error", e)
      .on("finish", c);
  });
}

async function install(
  files: string[],
  extensionPath: string,
  pkg: PackageManifest,
): Promise<void> {
  process.chdir(extensionPath);

  const dirName = getPackageDirname(pkg);
  const homeDir = homedir();
  const snapDataDir = await realpath(join(homedir(), "snap", "foxglove-studio", "current"));

  for (const dir of [homeDir, snapDataDir]) {
    if (!isDirectory(dir)) {
      continue;
    }

    const destDir = join(dir, ".foxglove-studio", "extensions", dirName);
    await rmdir(destDir);
    await mkdir(destDir, { recursive: true });

    info(`Copying files to ${destDir}`);
    for (const file of files) {
      const target = join(destDir, file);
      info(`  - ${file} -> ${target}`);
      await cpR(file, target, { stopOnErr: true });
    }
  }
}

async function pathExists(filename: string, fileType: FileType): Promise<boolean> {
  try {
    const finfo = await stat(filename);
    switch (fileType) {
      case FileType.File:
        return finfo.isFile();
      case FileType.Directory:
        return finfo.isDirectory();
      case FileType.FileOrDirectory:
        return finfo.isFile() || finfo.isDirectory();
    }
  } catch {
    // ignore
  }
  return false;
}

async function isDirectory(pathname: string): Promise<boolean> {
  return (await stat(pathname)).isDirectory();
}

async function rmdir(dirname: string): Promise<void> {
  return await new Promise<void>((c, e) =>
    rimraf(dirname, (err) => (err != undefined ? e(err) : c())),
  );
}

async function addDirToZip(zip: JSZip, baseDir: string, dirname: string): Promise<void> {
  const fullPath = join(baseDir, dirname);
  const entries = await readdir(fullPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(dirname, entry.name);
    if (entry.isFile()) {
      addFileToZip(zip, baseDir, entryPath);
    } else if (entry.isDirectory()) {
      await addDirToZip(zip, baseDir, entryPath);
    }
  }
}

function addFileToZip(zip: JSZip, baseDir: string, filename: string) {
  const fullPath = join(baseDir, filename);
  info(`archiving ${fullPath}`);
  zip.file<"stream">(filename, createReadStream(fullPath), { createFolders: true, date: MOD_DATE });
}

function inDirectory(directory: string, pathname: string): boolean {
  const relPath = relative(directory, pathname);
  const parts = relPath.split(sep);
  return parts[0] !== "..";
}

async function githubRawFile(homepage: string, filename: string): Promise<string | undefined> {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/?]+)$/.exec(homepage);
  if (match == undefined) {
    return undefined;
  }

  const [_, org, project] = match;
  if (org == undefined || project == undefined) {
    return undefined;
  }

  const url = `https://raw.githubusercontent.com/${org}/${project}/main/${filename}`;
  try {
    const res = await fetch(url);
    const content = await res.text();
    return content.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}
