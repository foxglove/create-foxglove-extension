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
      filename: "extension.js",
      libraryTarget: "commonjs2",
    },
    // Always use the eval-source-map option so the source map is included in the source file.
    // Because Lichtblick _evals_ the extension script to run it - the source map must be inline with
    // the source file. Using a separate source map file does not work.
    devtool: "eval-source-map",
    externals: {
      "@lichtblick/suite": "@lichtblick/suite",
    },
    resolve: {
      extensions: [".js", ".ts", ".jsx", ".tsx"],
      // The spirit of our fallback configuration is to do the expected thing when encountering a
      // native nodejs require.
      //
      // i.e. It wouldn't be surprising the `fs` module doesn't work since there's no file system in
      // extensions but it would be surprising the `path` doesn't work since thats just string
      // manipulation.
      fallback: {
        path: require.resolve("path-browserify"),

        // Since extensions don't have file-system access we disable any fallback for importing `fs`
        // This improves the out-of-the-box experience when importing files that require('fs') (i.e.
        // generated emscripten js loaders) without having to make a custom configuration to disable
        // fs fallback.
        fs: false,
      },
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
