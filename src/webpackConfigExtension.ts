import { CleanWebpackPlugin } from "clean-webpack-plugin";
import * as path from "path";
import type { Configuration } from "webpack";

export default (
  extensionPath: string,
  entryPoint: string,
  env: string | undefined,
): Configuration => {
  extensionPath = path.resolve(extensionPath);
  const isDev = env == undefined || env === "development";
  const configFile = path.join(extensionPath, "tsconfig.json");

  const config: Configuration = {
    target: "web",
    mode: isDev ? "development" : "production",
    context: extensionPath,
    entry: entryPoint,
    output: {
      path: path.join(extensionPath, "dist"),
      filename: "extension.js",
      libraryTarget: "commonjs2",
    },
    devtool: isDev ? "eval-source-map" : "source-map",
    externals: {
      "@foxglove/studio": "@foxglove/studio",
    },
    resolve: {
      extensions: [".js", ".ts", ".jsx", ".tsx"],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: [
            {
              loader: "ts-loader",
              options: {
                configFile,
              },
            },
          ],
        },
      ],
    },
    plugins: [new CleanWebpackPlugin()],
  };

  return config;
};
