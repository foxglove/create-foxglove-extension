import { ExtensionContext } from "@lichtblick/suite";

import { initCallServicePanel } from "./CallServicePanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "call-service", initPanel: initCallServicePanel });
}
