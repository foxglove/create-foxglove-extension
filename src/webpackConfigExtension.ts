import { CleanWebpackPlugin } from "clean-webpack-plugin";
import * as path from "path";
import type { Configuration } from "webpack";

export default (
  extensionPath: string,
  entryPoint: string,
  env: string | undefined,
): Configuration => {
  const resolvedExtensionPath = path.resolve(extensionPath);
  const isDev = env == undefined || env === "development";
  const configFile = path.join(resolvedExtensionPath, "tsconfig.json");

  const config: Configuration = {
    target: "web",
    mode: isDev ? "development" : "production",
    context: resolvedExtensionPath,
    entry: entryPoint,
    output: {
      path: path.join(resolvedExtensionPath, "dist"),
      publicPath: "@FOXGLOVE_EXTENSION_PATH_PREFIX@/dist/",
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
        {
          test: /\.css$/i,
          use: ["style-loader", "css-loader"],
        },
      ],
    },
    plugins: [new CleanWebpackPlugin()],
  };

  return config;
};
