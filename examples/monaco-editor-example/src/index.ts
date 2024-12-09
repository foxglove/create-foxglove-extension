import { ExtensionContext } from "@lichtblick/suite";

import { initExamplePanel } from "./ExamplePanel";

export function activate(extensionContext: ExtensionContext) {
  extensionContext.registerPanel({ name: "Monaco Editor", initPanel: initExamplePanel });
}
