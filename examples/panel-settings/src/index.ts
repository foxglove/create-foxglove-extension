import { ExtensionContext } from "@foxglove/studio";

import { initExamplePanel } from "./ExamplePanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({
    name: "Foxglove Panel Settings Example",
    initPanel: initExamplePanel,
  });
}
