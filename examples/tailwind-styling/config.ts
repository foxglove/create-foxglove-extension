// Set up loaders for css & postcss processing. We use a .pcss extension to avoid
// conflicts with the default css loaders in our base extension webpack config.
module.exports = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.pcss$/i,
      use: ["style-loader", "css-loader", "postcss-loader"],
    });
    return config;
  },
};
