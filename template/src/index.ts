import { ExtensionActivate } from "@foxglove/studio";

import { ExamplePanel } from "./ExamplePanel";

export const activate: ExtensionActivate = (ctx) => {
  ctx.registerPanel({ name: "ExamplePanel", component: ExamplePanel });
};
