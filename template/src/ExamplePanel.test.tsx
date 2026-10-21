import { cleanup, renderPanel } from "create-foxglove-extension/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { initExamplePanel } from "./ExamplePanel";

afterEach(cleanup);

describe("ExamplePanel", () => {
  it("renders", async () => {
    await renderPanel(initExamplePanel);

    await expect
      .element(page.getByRole("heading", { name: "Welcome to your new extension panel!" }))
      .toBeVisible();
  });

  it("watches render state and subscribes to its topic", async () => {
    const panel = await renderPanel(initExamplePanel);

    expect(panel.watchedFields).toEqual(new Set(["topics", "currentFrame"]));
    expect(panel.subscriptions).toEqual([{ topic: "/some/topic" }]);
  });

  it("lists topics from the render state", async () => {
    const panel = await renderPanel(initExamplePanel);

    // Resolves once the panel calls done(), as Foxglove requires after every render
    await panel.render({
      topics: [{ name: "/imu", schemaName: "sensor_msgs/Imu" }],
    });

    await expect.element(page.getByText("/imu", { exact: true })).toBeVisible();
    await expect.element(page.getByText("sensor_msgs/Imu", { exact: true })).toBeVisible();
  });
});
