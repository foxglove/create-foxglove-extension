import { spawn } from "child_process";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, readFile, readdir, stat } from "fs/promises";
import JSZip from "jszip";
import ncp from "ncp";
import { homedir } from "os";
import { join, normalize, relative, sep } from "path";
import { rimraf } from "rimraf";
import { promisify } from "util";

import { getPackageDirname, getPackageId, parsePackageName } from "./extensions";
import { info } from "./log";

const cpR = promisify(ncp);

// A fixed date is used for zip file modification timestamps to
// produce deterministic .foxe files.
const MOD_DATE = new Date("2021-02-03");

export interface PackageManifest {
  id: string;
  name: string;
  displayName?: string;
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
    "lichtblick:prepublish"?: string;
  };
}

export interface PackageOptions {
  readonly cwd?: string;
  readonly packagePath?: string;
}

export interface InstallOptions {
  readonly cwd?: string;
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
  const script = pkg.scripts?.["lichtblick:prepublish"];
  if (script == undefined) {
    return;
  }

  info(`Executing prepublish script 'npm run lichtblick:prepublish'...`);

  await new Promise<void>((resolve, reject) => {
    const tool = "npm";
    const cwd = extensionPath;
    const child = spawn(tool, ["run", "lichtblick:prepublish"], {
      cwd,
      shell: true,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${tool} failed with exit code ${String(code ?? "<null>")}`));
      }
    });
    child.on("error", reject);
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
  await new Promise((resolve, reject) => {
    zip
      .generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE" })
      .pipe(createWriteStream(outputFile, { encoding: "binary" }) as NodeJS.WritableStream)
      .on("error", reject)
      .on("finish", resolve);
  });
}

async function install(
  files: string[],
  extensionPath: string,
  pkg: PackageManifest,
): Promise<void> {
  process.chdir(extensionPath);

  const dirName = getPackageDirname(pkg);

  // The snap package does not use the regular _home_ directory but instead uses a separate snap
  // application directory to limit filesystem access.
  //
  // We look for this app directory as a signal that the user installed the snap package rather than
  // the deb package. If we detect a snap installation directory, we install to the snap path and
  // exit.
  const snapAppDir = join(homedir(), "snap", "lichtblick-suite", "current");
  if (await isDirectory(snapAppDir)) {
    info(`Detected snap install at ${snapAppDir}`);
    const extensionDir = join(snapAppDir, ".lichtblick-suite", "extensions", dirName);
    await copyFiles(files, extensionDir);
    return;
  }

  // If there is no snap install present then we install to the home directory
  const defaultExtensionDir = join(homedir(), ".lichtblick-suite", "extensions", dirName);
  await copyFiles(files, defaultExtensionDir);
}

async function copyFiles(files: string[], destDir: string): Promise<void> {
  await rimraf(destDir);
  await mkdir(destDir, { recursive: true });

  info(`Copying files to ${destDir}`);
  for (const file of files) {
    const target = join(destDir, file);
    info(`  - ${file} -> ${target}`);
    await cpR(file, target, { stopOnErr: true });
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
  try {
    return (await stat(pathname)).isDirectory();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_) {
    // ignore any error from stat and assume not a directory
  }
  return false;
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
  // zip file paths must use / as separator.
  const zipFilename = filename.replace(/\\/g, "/");
  zip.file<"stream">(zipFilename, createReadStream(fullPath), {
    createFolders: true,
    date: MOD_DATE,
  });
}

function inDirectory(directory: string, pathname: string): boolean {
  const relPath = relative(directory, pathname);
  const parts = relPath.split(sep);
  return parts[0] !== "..";
}
