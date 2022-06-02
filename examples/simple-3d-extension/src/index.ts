import { ExtensionContext } from "@foxglove/studio";
import { initThreeDeePanel } from "./ThreeDeePanel";

export function activate(extensionContext: ExtensionContext) {
  extensionContext.registerPanel({
    name: "Foxglove Example 3d Panel",
    initPanel: initThreeDeePanel,
  });
}
