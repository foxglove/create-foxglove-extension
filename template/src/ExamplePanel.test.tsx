import { cleanup, simulateFoxglove, type DataSource } from "create-foxglove-extension/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { activate } from "./index";

afterEach(cleanup);

// A recording with two topics, like an MCAP file opened in Foxglove
const recording: DataSource = {
  type: "recording",
  topics: [
    { name: "/some/topic", schemaName: "std_msgs/String" },
    { name: "/imu", schemaName: "sensor_msgs/Imu" },
  ],
  messages: [
    { topic: "/some/topic", receiveTime: 1, message: { data: "first" } },
    { topic: "/some/topic", receiveTime: 2, message: { data: "second" } },
  ],
};

describe("ExamplePanel", () => {
  it("renders", async () => {
    const foxglove = await simulateFoxglove({ extension: { activate } });
    await foxglove.openPanel("example-panel");

    await expect
      .element(page.getByRole("heading", { name: "Welcome to your new extension panel!" }))
      .toBeVisible();
    await expect.element(page.getByRole("link", { name: "documentation" })).toBeVisible();
  });

  it("lists the topics of the data source", async () => {
    const foxglove = await simulateFoxglove({ extension: { activate }, dataSource: recording });
    await foxglove.openPanel("example-panel");

    await expect.element(page.getByText("/imu", { exact: true })).toBeVisible();
    await expect.element(page.getByText("sensor_msgs/Imu", { exact: true })).toBeVisible();
  });

  it("receives messages on its topic during playback", async () => {
    const foxglove = await simulateFoxglove({ extension: { activate }, dataSource: recording });
    const panel = await foxglove.openPanel("example-panel");

    // Play from the start of the recording to 2 seconds, one frame at a time
    await foxglove.advanceTo(2);

    expect(panel.subscriptions).toEqual([{ topic: "/some/topic" }]);
    expect(panel.lastRenderState?.currentFrame?.map((event) => event.message)).toEqual([
      { data: "second" },
    ]);
    await expect.element(page.getByText("Messages in the latest frame: 1")).toBeVisible();
    expect(foxglove.problems).toEqual([]);
  });
});
