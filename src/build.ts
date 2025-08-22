import { existsSync } from "fs";
import * as path from "path";
import webpack from "webpack";

import { info } from "./log";
import buildWebpackConfig from "./webpackConfigExtension";

export interface BuildOptions {
  readonly entryPoint?: string;
  readonly mode?: "development" | "production";
  readonly cwd?: string;
}

function objectIsWebpackConfig(
  obj: unknown,
): obj is { webpack: (config: webpack.Configuration) => webpack.Configuration } {
  return typeof obj === "object" && obj != undefined && "webpack" in obj;
}

export async function buildCommand(options: BuildOptions = {}): Promise<void> {
  const env =
    options.mode ?? (process.env.NODE_ENV === "production" ? "production" : "development");
  const extensionPath = path.resolve((options.cwd ?? process.cwd()).replace(/"$/, ""));
  const entryPoint = options.entryPoint ?? "./src/index.ts";
  const configPath = path.join(extensionPath, "config.ts");

  let webpackConfig = buildWebpackConfig(extensionPath, entryPoint, env);
  if (existsSync(configPath)) {
    info(`Using config file at ${configPath}`);
    const config: unknown = await import(configPath);
    if (objectIsWebpackConfig(config)) {
      webpackConfig = config.webpack(webpackConfig);
    }
  }
  const compiler = webpack(webpackConfig);

  await new Promise<void>((resolve, reject) => {
    info("Building...");
    compiler.run((err, result) => {
      compiler.close(() => {
        if (err) {
          reject(err);
          return;
        }
        if (result == undefined) {
          reject(new Error(`build did not produce any output`));
          return;
        }
        if (result.hasErrors()) {
          reject(new Error(`build failed: ${getErrorOutput(result.compilation)}`));
          return;
        }
        info("Build complete");
        resolve();
      });
    });
  });
}

function getErrorOutput(compilation: webpack.Compilation): string {
  const warnings = compilation
    .getWarnings()
    .map((warning) => warning.message)
    .join("\n");
  const errors = compilation
    .getErrors()
    .map((error) => error.message)
    .join("\n");
  let output = "";
  if (warnings.length > 0) {
    output += `Warnings:\n${warnings}`;
  }
  if (errors.length > 0) {
    output += `${output.length > 0 ? "\n\n" : ""}Errors:\n${errors}`;
  }
  return output;
}
