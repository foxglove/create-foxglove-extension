import { ExtensionContext, PanelExtensionContext } from "@lichtblick/suite";

import PanelWorker from "./Panel.worker";

function initPanel(context: PanelExtensionContext): () => void {
  const result = new PanelWorker();
  result.addEventListener("message", (msg) => {
    const msgDiv = document.createElement("div");
    msgDiv.innerText = msg.data;
    context.panelElement.appendChild(msgDiv);
  });

  // Return a cleanup function to run when the panel is removed
  return () => {
    result.terminate();
  };
}

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({
    name: "Webworker Demo",
    initPanel,
  });
}
