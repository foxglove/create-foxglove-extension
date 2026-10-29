import { createExtensionContext } from "create-foxglove-extension/testing";
import { expect, it } from "vite-plus/test";

import { activate } from "./index";

it("registers the example panel", () => {
  const extension = createExtensionContext();

  activate(extension.context);

  expect([...extension.panels.keys()]).toEqual(["example-panel"]);
});
