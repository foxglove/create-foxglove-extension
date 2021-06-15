import { ExtensionContext } from "@foxglove/studio";
import { initExamplePanel } from "./ExamplePanel.tsx";

export function activate(extensionContext: ExtensionContext) {
  extensionContext.registerPanel({ name: "example-panel", initPanel: initExamplePanel });
}
