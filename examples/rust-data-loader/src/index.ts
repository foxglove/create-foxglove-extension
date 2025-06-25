import { Experimental } from "@foxglove/extension";
// @ts-expect-error: types aren't getting picked up for *.wasm
import wasmUrl from "../rust/target/wasm32-unknown-unknown/release/example_ndjson_foxglove_data_loader.wasm";

export function activate(extensionContext: Experimental.ExtensionContext): void {
  extensionContext.registerDataLoader({
    type: "file",
    wasmUrl,
    supportedFileType: ".ndjson",
  });
}
