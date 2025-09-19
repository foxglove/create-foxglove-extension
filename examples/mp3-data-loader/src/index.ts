import { Experimental } from "@foxglove/extension";

// Import the .wasm file as a base64 data URL to be bundled with the extension
import wasmUrl from "../rust/target/wasm32-unknown-unknown/release/foxglove_data_loader.wasm";

export function activate(extensionContext: Experimental.ExtensionContext): void {
  extensionContext.registerDataLoader({
    type: "file",
    wasmUrl,
    supportedFileType: ".mp3",
  });
}
