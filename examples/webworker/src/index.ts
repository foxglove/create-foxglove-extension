import { ExtensionContext, PanelExtensionContext } from "@foxglove/studio";

import PanelWorker from "./Panel.worker";

export function initPanel(context: PanelExtensionContext): void {
  const result = new PanelWorker();
  result.addEventListener("message", (msg) => {
    const msgDiv = document.createElement("div");
    msgDiv.innerText = msg.data;
    context.panelElement.appendChild(msgDiv);
  });
}

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({
    name: "Webworker Demo",
    initPanel: initPanel,
  });
}
