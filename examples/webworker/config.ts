module.exports = {
  webpack: (config) => {
    config.module.rules = [
      {
        test: /\.worker\.ts$/,
        use: [
          {
            loader: "worker-loader",
            // Force to inline the worker as a blob.
            options: { inline: "no-fallback" },
          },
          {
            loader: "ts-loader",
          },
        ],
      },
      ...config.module.rules,
    ];

    return config;
  },
};
