import { spawn } from "child_process";
import { constants } from "fs";
import { access, readdir, readFile, writeFile } from "fs/promises";
import { mkdirp } from "mkdirp";
import * as path from "path";
import sanitize from "sanitize-filename";

import { info } from "./log";

const DEPENDENCIES = [
  "@foxglove/eslint-plugin@^2",
  "@foxglove/extension@^2",
  "@types/react@^18",
  "@types/react-dom@^18",
  "create-foxglove-extension@^1",
  "eslint@^9",
  "prettier@^3",
  "react@^18",
  "react-dom@^18",
  "typescript@^5",
];

export interface CreateOptions {
  readonly name: string;
  readonly cwd?: string;
}

export async function createCommand(options: CreateOptions): Promise<void> {
  const name = options.name;
  if (name !== sanitize(name)) {
    throw new Error(
      `Name "${name}" contains invalid characters. Choose a filename-compatible project name`,
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const templateDir = path.join(__dirname, "..", "template");
  const extensionDir = path.join(cwd, name);

  if (await exists(extensionDir)) {
    throw new Error(`Directory "${extensionDir}" already exists`);
  }

  const replacements = new Map([["${NAME}", name]]);
  const files = await listFiles(templateDir);
  for (const file of files) {
    const srcFile = path.resolve(templateDir, file);
    const dstFile = path.resolve(extensionDir, file);
    await copyTemplateFile(srcFile, dstFile, replacements);
  }

  await installDependencies(extensionDir, DEPENDENCIES);

  info(`Created Foxglove extension "${name}" at ${extensionDir}`);
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

  info(`${command} ${args.join(" ")}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
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
