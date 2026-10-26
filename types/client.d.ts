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

// The plugin replaces these when it builds. `vp check` type checks with TypeScript 7, which does not
// load @types packages unless the tsconfig lists them, so declare them here. The declarations merge
// with @types/node, so a project can load both.

declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV?: string;
  }
  interface Process {
    env: ProcessEnv;
  }
}

/**
 * `process` does not exist in Foxglove. The build replaces the expression `process.env.NODE_ENV`
 * with a string, so use that exact expression rather than reading `process.env` another way.
 */
declare var process: NodeJS.Process;

/** Replaced with `globalThis`. */
declare var global: typeof globalThis;
