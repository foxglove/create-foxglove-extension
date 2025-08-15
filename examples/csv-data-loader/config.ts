module.exports = {
  webpack: (config) => {
    // Set up Webpack to inline .wasm imports as a base64 URL
    config.module.rules.push({
      test: /\.wasm$/i,
      type: "asset/inline",
    });
    return config;
  },
};
