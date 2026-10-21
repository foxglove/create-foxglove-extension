/// <reference types="vite-plus/client" />

// Type declarations for imports handled by the `foxgloveExtension()` Vite plugin, in addition to
// the Vite client types. Reference this file from an extension with:
//
//   /// <reference types="create-foxglove-extension/client" />

/** `.wasm` files are inlined, and the default export is a `data:application/wasm` URL. */
declare module "*.wasm" {
  const dataUrl: string;
  export default dataUrl;
}
