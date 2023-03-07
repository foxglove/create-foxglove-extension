import { ExtensionContext, ExtensionPanelRegistration } from "@foxglove/studio";

import PanelWorker from "./Panel.worker";

const initPanel: ExtensionPanelRegistration["initPanel"] = (context) => {
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
};

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({
    name: "Webworker Demo",
    initPanel: initPanel,
  });
}
