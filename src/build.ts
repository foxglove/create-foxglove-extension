import * as path from "path";
import webpack from "webpack";

import { info } from "./log";
import webpackConfig from "./webpackConfigExtension";

export interface BuildOptions {
  readonly entryPoint?: string;
  readonly cwd?: string;
}

export async function buildCommand(options: BuildOptions = {}): Promise<void> {
  const env = process.env.NODE_ENV === "production" ? "production" : "development";
  const extensionPath = path.resolve((options.cwd ?? process.cwd()).replace(/"$/, ""));
  const entryPoint = options.entryPoint ?? "./src/index.ts";

  const compiler = webpack(webpackConfig(extensionPath, entryPoint, env));

  return new Promise<void>((resolve, reject) => {
    info("Building...");
    compiler.run((err, result) => {
      compiler.close(() => {});
      if (err) {
        return reject(err.message);
      }
      if (result == undefined) {
        return reject(new Error(`build did not produce any output`));
      }
      if (result.hasErrors()) {
        return reject(new Error(`build failed: ${getErrorOutput(result?.compilation)}`));
      }
      info("Build complete");
      resolve();
    });
  });
}

function getErrorOutput(compilation: webpack.Compilation): string {
  const warnings = compilation
    .getWarnings()
    .map((warning) => `${warning}`)
    .join("\n");
  const errors = compilation
    .getErrors()
    .map((error) => `${error}`)
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
