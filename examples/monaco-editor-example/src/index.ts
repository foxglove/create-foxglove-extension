import { ExtensionContext } from "@foxglove/extension";

import { initExamplePanel } from "./ExamplePanel";

export function activate(extensionContext: ExtensionContext) {
  extensionContext.registerPanel({ name: "Monaco Editor", initPanel: initExamplePanel });
}
