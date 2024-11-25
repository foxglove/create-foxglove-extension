import { ExtensionContext } from "@foxglove/extension";

import { initExamplePanel } from "./ExamplePanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({
    name: "Foxglove Panel Settings Example",
    initPanel: initExamplePanel,
  });
}
