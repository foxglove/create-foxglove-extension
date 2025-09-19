// Webpack is configured to import .wasm files as a base64 URL
declare module "*.wasm" {
  const url: string;
  export default url;
}
