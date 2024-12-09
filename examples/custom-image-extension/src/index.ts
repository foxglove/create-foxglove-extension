import { ExtensionContext } from "@lichtblick/suite";

import { initExamplePanel } from "./ExamplePanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({
    name: "Lichtblick Example Image Extension Panel",
    initPanel: initExamplePanel,
  });
}
