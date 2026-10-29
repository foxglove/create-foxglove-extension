import type {
  Experimental,
  ExtensionContext,
  Immutable,
  MessageEvent,
  PanelExtensionContext,
  RenderState,
  SettingsTreeAction,
  Subscription,
} from "@foxglove/extension";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import {
  cleanup,
  renderPanel,
  simulateFoxglove,
  type DataSource,
  type SimulatedPanel,
} from "./index.mjs";

afterEach(cleanup);

/** What a probe panel saw */
interface Probe {
  readonly renders: Record<string, unknown>[];
  context?: PanelExtensionContext;
}

/**
 * A panel without a UI framework that watches `fields`, subscribes to `topics`, records a copy of
 * every render state, and shows the messages of its latest frame.
 */
function probePanel(
  probe: Probe,
  options: {
    fields?: (keyof RenderState)[];
    topics?: Subscription[] | string[];
    setup?: (context: PanelExtensionContext) => void;
  } = {},
): (context: PanelExtensionContext) => () => void {
  return (context) => {
    probe.context = context;
    const list = document.createElement("ul");
    context.panelElement.appendChild(list);
    context.onRender = (renderState, done) => {
      probe.renders.push({ ...renderState });
      if (renderState.currentFrame != undefined) {
        list.replaceChildren(
          ...renderState.currentFrame.map((event) =>
            Object.assign(document.createElement("li"), {
              textContent: `${event.topic}: ${JSON.stringify(
                event.message,
                (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
              )}`,
            }),
          ),
        );
      }
      done();
    };
    for (const field of options.fields ?? []) {
      context.watch(field);
    }
    if (options.topics != undefined) {
      context.subscribe(options.topics as Subscription[]);
    }
    options.setup?.(context);
    return () => {
      list.remove();
    };
  };
}

function newProbe(): Probe {
  return { renders: [] };
}

function lastRender(probe: Probe): Record<string, unknown> {
  const render = probe.renders[probe.renders.length - 1];
  if (render == undefined) {
    throw new Error("The panel has not rendered");
  }
  return render;
}

function frameMessages(render: Record<string, unknown>): unknown[] {
  return ((render.currentFrame as MessageEvent[] | undefined) ?? []).map((event) => event.message);
}

const recording: DataSource = {
  type: "recording",
  topics: [
    { name: "/speed", schemaName: "Speed" },
    { name: "/other", schemaName: "Other" },
  ],
  messages: [
    { topic: "/speed", receiveTime: 10, message: { value: 1 } },
    { topic: "/other", receiveTime: 10.5, message: { value: "x" } },
    { topic: "/speed", receiveTime: 11, message: { value: 2 } },
    { topic: "/speed", receiveTime: 12, message: { value: 3 } },
  ],
};

describe("panels", () => {
  it("mounts the panel in a frame in the layout, with an empty initial state", async () => {
    const probe = newProbe();
    const panel = await renderPanel(probePanel(probe), { name: "probe" });

    expect(panel.element.isConnected).toBe(true);
    expect(panel.frame.contains(panel.element)).toBe(true);
    expect(panel.context.initialState).toEqual({});
    await expect.element(page.getByRole("region", { name: "probe" })).toBeVisible();
  });

  it("shows the default title the panel sets in its title bar", async () => {
    const panel = await renderPanel((context) => {
      context.setDefaultPanelTitle("Speed plot");
    });

    expect(panel.title).toBe("Speed plot");
    await expect.element(page.getByRole("region", { name: "Speed plot" })).toBeVisible();
  });

  it("renders as soon as the panel sets onRender, with the topics and color scheme", async () => {
    const probe = newProbe();
    await renderPanel(probePanel(probe, { fields: ["topics", "colorScheme"] }), {
      dataSource: recording,
      colorScheme: "dark",
    });

    expect(lastRender(probe).colorScheme).toBe("dark");
    expect(lastRender(probe).topics).toEqual([
      { name: "/other", schemaName: "Other", datatype: "Other" },
      { name: "/speed", schemaName: "Speed", datatype: "Speed" },
    ]);
  });

  it("delivers only watched fields, in one render state object that is updated in place", async () => {
    const seen: Immutable<RenderState>[] = [];
    const panel = await renderPanel(
      (context) => {
        context.onRender = (renderState, done) => {
          seen.push(renderState);
          done();
        };
        context.watch("currentTime");
      },
      { dataSource: recording },
    );
    await panel.foxglove.advance(0.5);

    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
    expect(Object.keys(seen[0]!)).toEqual(["currentTime"]);
  });

  it("does not render when nothing the panel watches changed", async () => {
    const probe = newProbe();
    const panel = await renderPanel(probePanel(probe, { fields: ["topics"] }), {
      dataSource: recording,
    });
    const renders = probe.renders.length;

    await panel.foxglove.setVariable("unwatched", 1);
    await panel.foxglove.advance(1);

    expect(probe.renders).toHaveLength(renders);
  });

  it("waits for done() before rendering again, then renders the latest state", async () => {
    const held: (() => void)[] = [];
    const seenValues: unknown[] = [];
    const panel = await renderPanel(
      (context) => {
        context.watch("variables");
        context.onRender = (renderState, done) => {
          seenValues.push(renderState.variables?.get("count"));
          // Finish the first render right away, and hold the rest until the test releases them
          if (seenValues.length === 1) {
            done();
          } else {
            held.push(done);
          }
        };
      },
      { variables: { count: 0 } },
    );

    panel.context.setVariable("count", 1);
    await expect.poll(() => seenValues).toEqual([0, 1]);
    panel.context.setVariable("count", 2);
    panel.context.setVariable("count", 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seenValues).toEqual([0, 1]);

    held.shift()!();
    await expect.poll(() => seenValues).toEqual([0, 1, 3]);
    held.shift()!();
    await panel.foxglove.settle();
  });

  it("reports a panel that calls done() twice", async () => {
    const panel = await renderPanel((context) => {
      context.watch("colorScheme");
      context.onRender = (_renderState, done) => {
        done();
        done();
      };
    });

    expect(panel.foxglove.problems).toEqual([
      'Panel "panel" called done() more than once for one render',
    ]);
  });

  it("fails when a panel does not call done()", async () => {
    const panel = await renderPanel(
      (context) => {
        context.watch("currentTime");
        context.onRender = () => undefined;
      },
      { dataSource: recording, renderTimeoutMs: 200 },
    ).catch((error: unknown) => error);

    expect(String(panel)).toContain('Panel "panel" did not call done()');
  });

  it("shows an error in place of a panel that throws while rendering", async () => {
    const panel = await renderPanel((context) => {
      context.watch("colorScheme");
      context.onRender = () => {
        throw new Error("render failed");
      };
    });

    expect(panel.error?.message).toBe("render failed");
    await expect.element(page.getByRole("alert")).toHaveTextContent("Panel error: render failed");
    expect(panel.foxglove.problems).toEqual(['Panel "panel" threw while rendering: render failed']);
  });

  it("rejects when initPanel throws, and leaves nothing behind", async () => {
    const result = await renderPanel((context) => {
      context.panelElement.textContent = "half-initialized panel";
      throw new Error("init failed");
    }).catch((error: unknown) => error);

    expect(String(result)).toContain('initPanel of panel "panel" threw: init failed');
    expect(document.body.textContent).not.toContain("half-initialized panel");
  });

  it("runs the cleanup function on unmount, and ignores calls after it", async () => {
    const cleanupPanel = vi.fn();
    const panel = await renderPanel(
      (context) => {
        context.watch("topics");
        context.onRender = (_renderState, done) => {
          done();
        };
        return cleanupPanel;
      },
      { dataSource: { type: "live", services: { "/ok": () => "ok" } } },
    );

    panel.unmount();

    expect(cleanupPanel).toHaveBeenCalledTimes(1);
    expect(panel.element.isConnected).toBe(false);
    panel.context.saveState({ after: "unmount" });
    expect(panel.savedState).toBeUndefined();
    await expect(panel.context.callService!("/ok", {})).rejects.toThrow(
      "Service call after panel was unmounted",
    );
  });

  it("reopens a panel with its saved state when the layout reloads", async () => {
    const panel = await renderPanel((context) => {
      const count = (context.initialState as { count?: number }).count ?? 0;
      context.panelElement.textContent = `Count: ${count}`;
      context.saveState({ count: count + 1 });
    });

    const reloaded = await panel.reload();

    expect(panel.mounted).toBe(false);
    expect(reloaded.initialState).toEqual({ count: 1 });
    await expect.element(page.getByText("Count: 1")).toBeVisible();
  });

  it("opens a sibling panel when a panel calls layout.addPanel", async () => {
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerPanel({
          name: "opener",
          initPanel: (panelContext) => {
            panelContext.layout.addPanel({
              position: "sibling",
              type: "my-extension.details",
              getState: () => ({ topic: "/speed" }),
            });
          },
        });
        context.registerPanel({
          name: "details",
          initPanel: (panelContext) => {
            panelContext.panelElement.textContent = `Details for ${(panelContext.initialState as { topic: string }).topic}`;
          },
        });
      },
    });

    await foxglove.openPanel("opener");

    expect(foxglove.panels.map((panel) => panel.name)).toEqual(["opener", "details"]);
    await expect.element(page.getByText("Details for /speed")).toBeVisible();
  });
});

describe("recordings", () => {
  it("backfills the latest message on each subscribed topic, as a seek", async () => {
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, { fields: ["currentFrame", "didSeek"], topics: [{ topic: "/speed" }] }),
      { dataSource: recording },
    );

    expect(frameMessages(lastRender(probe))).toEqual([{ value: 1 }]);
    expect(lastRender(probe).didSeek).toBe(true);

    await panel.foxglove.seek(11.5);

    expect(frameMessages(lastRender(probe))).toEqual([{ value: 2 }]);
    expect(lastRender(probe).didSeek).toBe(true);
  });

  it("plays the messages on subscribed topics in order as time advances", async () => {
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, {
        fields: ["currentFrame", "currentTime", "didSeek"],
        topics: [{ topic: "/speed" }],
      }),
      { dataSource: recording, frameDuration: 0.25 },
    );
    probe.renders.length = 0;

    await panel.foxglove.advanceTo(12);

    const delivered = probe.renders.flatMap(frameMessages);
    expect(delivered).toEqual([{ value: 2 }, { value: 3 }]);
    expect(lastRender(probe).currentTime).toEqual({ sec: 12, nsec: 0 });
    expect(lastRender(probe).didSeek).toBe(false);
    await expect.element(page.getByText('/speed: {"value":3}')).toBeVisible();
  });

  it("stops at the end of the recording", async () => {
    const panel = await renderPanel(probePanel(newProbe(), { fields: ["currentTime"] }), {
      dataSource: recording,
      frameDuration: 1,
    });

    await panel.foxglove.advance(100);

    expect(panel.foxglove.currentTime).toEqual({ sec: 12, nsec: 0 });
  });

  it("delivers allFrames for topics subscribed by name", async () => {
    const probe = newProbe();
    await renderPanel(probePanel(probe, { fields: ["allFrames"], topics: ["/speed"] }), {
      dataSource: recording,
    });

    const allFrames = lastRender(probe).allFrames as MessageEvent[];
    expect(allFrames.map((event) => event.message)).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 3 },
    ]);
  });

  it("seeks when the panel calls seekPlayback", async () => {
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, { fields: ["currentTime"], topics: [{ topic: "/speed" }] }),
      { dataSource: recording },
    );

    panel.context.seekPlayback!({ sec: 11, nsec: 0 });
    await panel.foxglove.settle();

    expect(panel.foxglove.currentTime).toEqual({ sec: 11, nsec: 0 });
    expect(lastRender(probe).currentTime).toEqual({ sec: 11, nsec: 0 });
  });

  it("loads every message on a topic with subscribeMessageRange", async () => {
    const batches: unknown[][] = [];
    const panel = await renderPanel(
      (context) => {
        context.subscribeMessageRange!({
          topic: "/speed",
          onNewRangeIterator: async (iterator) => {
            for await (const batch of iterator) {
              batches.push(batch.map((event) => event.message));
            }
          },
        });
      },
      { dataSource: recording },
    );
    await panel.foxglove.settle();

    expect(batches).toEqual([[{ value: 1 }, { value: 2 }, { value: 3 }]]);
  });

  it("sets previewTime when the playback bar is hovered or a panel sets it", async () => {
    const probe = newProbe();
    const panel = await renderPanel(probePanel(probe, { fields: ["previewTime"] }), {
      dataSource: recording,
    });

    await panel.foxglove.hover(11);
    expect(lastRender(probe).previewTime).toBe(11);

    panel.context.setPreviewTime(10.5);
    await panel.foxglove.settle();
    expect(lastRender(probe).previewTime).toBe(10.5);

    await panel.foxglove.hover(undefined);
    expect(lastRender(probe).previewTime).toBeUndefined();
  });

  it("plays in real time until paused", async () => {
    const panel = await renderPanel(probePanel(newProbe(), { fields: ["currentTime"] }), {
      dataSource: recording,
    });

    panel.foxglove.play({ speed: 2 });
    await expect.poll(() => panel.foxglove.currentTime?.sec ?? 0).toBeGreaterThan(10);
    await panel.foxglove.pause();

    expect(panel.foxglove.isPlaying).toBe(false);
  });
});

describe("converters and aliases", () => {
  function converterExtension(context: ExtensionContext): void {
    context.registerMessageConverter({
      type: "schema",
      fromSchemaName: "Speed",
      toSchemaName: "SpeedKph",
      converter: (message: { value: number }) =>
        message.value === 2 ? undefined : { kph: message.value * 3.6 },
    });
    context.registerTopicAliases(({ topics, globalVariables }) =>
      topics
        .filter((topic) => topic.name === "/speed")
        .map((topic) => ({
          name: `/${typeof globalVariables.robot === "string" ? globalVariables.robot : "robot"}/speed`,
          sourceTopicName: topic.name,
        })),
    );
    context.registerMessageConverter({
      type: "topic",
      inputTopics: ["/speed"],
      outputTopic: "/speed_doubled",
      outputSchemaName: "Doubled",
      create: () => (event) => ({ doubled: (event.message as { value: number }).value * 2 }),
    });
  }

  it("lists alias topics, converter outputs, and the schemas topics convert to", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        converterExtension(context);
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, { fields: ["topics"] }),
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("probe");

    expect(lastRender(probe).topics).toEqual([
      { name: "/other", schemaName: "Other", datatype: "Other" },
      { name: "/robot/speed", schemaName: "Speed", datatype: "Speed", convertibleTo: ["SpeedKph"] },
      { name: "/speed", schemaName: "Speed", datatype: "Speed", convertibleTo: ["SpeedKph"] },
      { name: "/speed_doubled", schemaName: "Doubled", datatype: "Doubled" },
    ]);
  });

  it("converts messages for subscriptions that set convertTo", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        converterExtension(context);
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, {
            fields: ["currentFrame"],
            topics: [{ topic: "/speed", convertTo: "SpeedKph" }],
          }),
        });
      },
      dataSource: recording,
      frameDuration: 1,
    });
    await foxglove.openPanel("probe");
    await foxglove.advanceTo(12);

    const events = probe.renders.flatMap(
      (render) => (render.currentFrame as MessageEvent[] | undefined) ?? [],
    );
    // The converter skips the message with value 2 by returning undefined
    expect(events.map((event) => event.message)).toEqual([{ kph: 3.6 }, { kph: 10.8 }]);
    expect(events[0]!.schemaName).toBe("SpeedKph");
    expect(events[0]!.originalMessageEvent?.message).toEqual({ value: 1 });
  });

  it("delivers messages on alias topics, and follows variables that change the alias", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        converterExtension(context);
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, {
            fields: ["currentFrame", "topics"],
            topics: [{ topic: "/alpha/speed" }],
          }),
        });
      },
      dataSource: recording,
      variables: { robot: "alpha" },
    });
    await foxglove.openPanel("probe");

    const events = (lastRender(probe).currentFrame as MessageEvent[] | undefined) ?? [];
    expect(events.map((event) => [event.topic, event.message])).toEqual([
      ["/alpha/speed", { value: 1 }],
    ]);

    await foxglove.setVariable("robot", "beta");
    const topics = lastRender(probe).topics as { name: string }[];
    expect(topics.map((topic) => topic.name)).toContain("/beta/speed");
  });

  it("runs topic converters for subscribers of their output topic", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        converterExtension(context);
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, {
            fields: ["currentFrame"],
            topics: [{ topic: "/speed_doubled" }],
          }),
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("probe");
    await foxglove.advanceTo(11);

    expect(probe.renders.flatMap(frameMessages)).toEqual([{ doubled: 2 }, { doubled: 4 }]);
  });

  it("reports a converter that throws, and keeps playing", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerMessageConverter({
          type: "schema",
          fromSchemaName: "Speed",
          toSchemaName: "Broken",
          converter: () => {
            throw new Error("bad message");
          },
        });
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, {
            fields: ["currentFrame"],
            topics: [{ topic: "/speed", convertTo: "Broken" }, { topic: "/other" }],
          }),
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("probe");
    await foxglove.advanceTo(11);

    expect(foxglove.problems[0]).toBe(
      'The message converter from Speed to Broken threw on a message on "/speed": bad message',
    );
    expect(probe.renders.flatMap(frameMessages)).toContainEqual({ value: "x" });
  });
});

describe("layout state", () => {
  it("shares variables between panels", async () => {
    const reader = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerPanel({
          name: "writer",
          initPanel: (panelContext) => {
            const button = document.createElement("button");
            button.textContent = "Select robot B";
            button.onclick = () => {
              panelContext.setVariable("robot", "B");
            };
            panelContext.panelElement.append(button);
          },
        });
        context.registerPanel({
          name: "reader",
          initPanel: probePanel(reader, { fields: ["variables"] }),
        });
      },
    });
    await foxglove.openPanel("writer");
    await foxglove.openPanel("reader");

    await page.getByRole("button", { name: "Select robot B" }).click();
    await foxglove.settle();

    expect(lastRender(reader).variables).toEqual(new Map([["robot", "B"]]));
    expect(foxglove.variables.get("robot")).toBe("B");
  });

  it("shares state between panels of the same type", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, { fields: ["sharedPanelState"] }),
        });
      },
    });
    const first = await foxglove.openPanel("probe");
    await foxglove.openPanel("probe");

    first.context.setSharedPanelState({ selected: "/speed" });
    await foxglove.settle();

    const states = probe.renders.map((render) => render.sharedPanelState);
    expect(states.filter((state) => state != undefined)).toEqual([
      { selected: "/speed" },
      { selected: "/speed" },
    ]);
  });

  it("delivers the color scheme when it changes", async () => {
    const probe = newProbe();
    const panel = await renderPanel(probePanel(probe, { fields: ["colorScheme"] }));

    await panel.foxglove.setColorScheme("dark");

    expect(probe.renders.map((render) => render.colorScheme)).toEqual(["light", "dark"]);
  });

  it("delivers only the app settings a panel subscribed to", async () => {
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, {
        fields: ["appSettings"],
        setup: (context) => {
          context.subscribeAppSettings(["timezone"]);
        },
      }),
      { appSettings: { timezone: "UTC", other: "hidden" } },
    );

    expect(lastRender(probe).appSettings).toEqual(new Map([["timezone", "UTC"]]));
    await panel.foxglove.setAppSetting("timezone", "America/Denver");
    expect(lastRender(probe).appSettings).toEqual(new Map([["timezone", "America/Denver"]]));
  });
});

describe("live connections", () => {
  it("delivers received messages to subscribers and adds new topics", async () => {
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, {
        fields: ["currentFrame", "currentTime", "topics"],
        topics: [{ topic: "/status" }],
      }),
      { dataSource: { type: "live", startTime: 100 } },
    );

    await panel.foxglove.receive([
      { topic: "/status", schemaName: "Status", message: { ok: true } },
      { topic: "/ignored", schemaName: "Other", message: {} },
    ]);

    expect(frameMessages(lastRender(probe))).toEqual([{ ok: true }]);
    expect(lastRender(probe).currentTime).toEqual({ sec: 100, nsec: 0 });
    const topics = lastRender(probe).topics as { name: string }[];
    expect(topics.map((topic) => topic.name)).toEqual(["/ignored", "/status"]);
  });

  it("records published messages, and lets the simulated robot answer them", async () => {
    // The robot answers through the simulation, which exists once the panel is open
    const robot: { answer?: (message: unknown) => void } = {};
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, {
        fields: ["currentFrame"],
        topics: [{ topic: "/ack" }],
        setup: (context) => {
          context.advertise!("/cmd", "Command");
          const button = document.createElement("button");
          button.textContent = "Stop";
          button.onclick = () => {
            context.publish!("/cmd", { action: "stop" });
          };
          context.panelElement.append(button);
        },
      }),
      {
        dataSource: {
          type: "live",
          topics: [{ name: "/ack", schemaName: "Ack" }],
          onPublish: (message) => {
            robot.answer?.({ received: message.message });
          },
        },
      },
    );
    robot.answer = (message) => {
      void panel.foxglove.receive({ topic: "/ack", message });
    };

    await page.getByRole("button", { name: "Stop" }).click();
    await panel.foxglove.settle();

    expect(panel.foxglove.published).toEqual([{ topic: "/cmd", message: { action: "stop" } }]);
    expect(panel.advertisements.get("/cmd")).toEqual({ schemaName: "Command" });
    await expect.element(page.getByText('/ack: {"received":{"action":"stop"}}')).toBeVisible();
  });

  it("throws when a panel publishes without advertising", async () => {
    const panel = await renderPanel(() => undefined, { dataSource: { type: "live" } });

    expect(() => {
      panel.context.publish!("/cmd", {});
    }).toThrow('Panel "panel" published on "/cmd" without advertising it');
  });

  it("answers service calls with mocked responses, and records them", async () => {
    const panel = await renderPanel(() => undefined, {
      dataSource: {
        type: "live",
        services: {
          "/add": (request) => {
            const { a, b } = request as { a: number; b: number };
            return { sum: a + b };
          },
          "/fail": () => {
            throw new Error("robot busy");
          },
        },
      },
    });

    await expect(panel.context.callService!("/add", { a: 1, b: 2 })).resolves.toEqual({ sum: 3 });
    await expect(panel.context.callService!("/fail", {})).rejects.toThrow("robot busy");
    await expect(panel.context.callService!("/missing", {})).rejects.toThrow(
      'Service "/missing" is not available',
    );
    expect(panel.foxglove.serviceCalls.map((call) => [call.service, call.response])).toEqual([
      ["/add", { sum: 3 }],
      ["/fail", undefined],
      ["/missing", undefined],
    ]);
  });

  it("leaves out what the data source does not support, as Foxglove does", async () => {
    const live = await renderPanel(() => undefined, {
      dataSource: { type: "live", capabilities: { publish: false, services: false } },
    });
    const file = await renderPanel(() => undefined, { dataSource: recording });

    for (const context of [live.context, file.context]) {
      // Foxglove sets the members to undefined rather than leaving them out
      for (const member of ["advertise", "unadvertise", "publish", "callService"]) {
        expect(context).toHaveProperty(member, undefined);
      }
    }
    expect(live.context).toHaveProperty("seekPlayback", undefined);
    expect(typeof file.context.seekPlayback).toBe("function");
  });

  it("updates parameters that panels set", async () => {
    const probe = newProbe();
    const panel = await renderPanel(probePanel(probe, { fields: ["parameters"] }), {
      dataSource: { type: "live", parameters: { "/max_speed": 1 } },
    });

    panel.context.setParameter("/max_speed", 2);
    await panel.foxglove.settle();

    expect(lastRender(probe).parameters).toEqual(new Map([["/max_speed", 2]]));
  });

  it("delivers the connection's host and port", async () => {
    const probe = newProbe();
    await renderPanel(probePanel(probe, { fields: ["connection" as keyof RenderState] }), {
      dataSource: { type: "live", url: "ws://robot.local:8765" },
    });

    expect(lastRender(probe).connection).toEqual({ host: "robot.local", port: 8765 });
  });
});

describe("settings sidebar", () => {
  function settingsPanel(actions: SettingsTreeAction[]): (context: PanelExtensionContext) => void {
    return (context) => {
      context.updatePanelSettingsEditor({
        nodes: {
          general: {
            label: "General",
            renamable: true,
            visible: true,
            actions: [{ type: "action", id: "reset", label: "Reset" }],
            fields: {
              title: { label: "Title", input: "string", value: "Speed" },
              enabled: { label: "Enabled", input: "boolean", value: false },
              units: {
                label: "Units",
                input: "select",
                value: "m/s",
                options: [
                  { label: "Meters per second", value: "m/s" },
                  { label: "Kilometers per hour", value: "km/h" },
                ],
              },
              limit: { label: "Limit", input: "number", value: 3 },
              offset: { label: "Offset", input: "vec3", value: [0, 0, 0] },
              locked: { label: "Locked", input: "string", value: "fixed", disabled: true },
            },
          },
        },
        actionHandler: (action) => {
          actions.push(action);
        },
      });
    };
  }

  it("shows each field as a labeled control that sends update actions", async () => {
    const actions: SettingsTreeAction[] = [];
    await renderPanel(settingsPanel(actions));

    await page.getByLabelText("Title").fill("Velocity");
    await page.getByLabelText("Enabled").click();
    await page.getByLabelText("Units").selectOptions("Kilometers per hour");
    await page.getByLabelText("Limit").fill("5");
    await page.getByLabelText("Offset Y").fill("2");

    expect(actions).toEqual([
      {
        action: "update",
        payload: { path: ["general", "title"], input: "string", value: "Velocity" },
      },
      {
        action: "update",
        payload: { path: ["general", "enabled"], input: "boolean", value: true },
      },
      { action: "update", payload: { path: ["general", "units"], input: "select", value: "km/h" } },
      { action: "update", payload: { path: ["general", "limit"], input: "number", value: 5 } },
      {
        action: "update",
        payload: { path: ["general", "offset"], input: "vec3", value: [0, 2, 0] },
      },
    ]);
    await expect.element(page.getByLabelText("Locked")).toBeDisabled();
  });

  it("shows node actions, renaming, and the visibility toggle", async () => {
    const actions: SettingsTreeAction[] = [];
    await renderPanel(settingsPanel(actions));

    await page.getByRole("button", { name: "Reset" }).click();
    await page.getByLabelText("Show General").click();
    await page.getByLabelText("Rename General").fill("Main");
    await userEvent.keyboard("{Enter}");

    expect(actions).toEqual([
      { action: "perform-node-action", payload: { id: "reset", path: ["general"] } },
      {
        action: "update",
        payload: { path: ["general", "visible"], input: "boolean", value: false },
      },
      { action: "update", payload: { path: ["general", "label"], input: "string", value: "Main" } },
    ]);
  });

  it("edits settings by path, and refuses fields that do not exist or are disabled", async () => {
    const actions: SettingsTreeAction[] = [];
    const panel = await renderPanel(settingsPanel(actions));

    await panel.settings.update(["general", "limit"], 10);
    await panel.settings.performAction(["general"], "reset");

    expect(actions).toEqual([
      { action: "update", payload: { path: ["general", "limit"], input: "number", value: 10 } },
      { action: "perform-node-action", payload: { id: "reset", path: ["general"] } },
    ]);
    await expect(panel.settings.update(["general", "missing"], 1)).rejects.toThrow(
      'There is no setting at ["general", "missing"]',
    );
    await expect(panel.settings.update(["general", "locked"], "x")).rejects.toThrow(
      'The setting at ["general", "locked"] is disabled',
    );
  });

  it("keeps the sidebar in step with the panel's tree", async () => {
    const panel = await renderPanel((context) => {
      let count = 0;
      const update = () => {
        context.updatePanelSettingsEditor({
          nodes: {
            general: {
              label: `Clicked ${count} times`,
              actions: [{ type: "action", id: "click", label: "Click" }],
            },
          },
          actionHandler: () => {
            count += 1;
            update();
          },
        });
      };
      update();
    });

    await page.getByRole("button", { name: "Click" }).click();
    await panel.foxglove.settle();

    await expect.element(page.getByRole("group", { name: "Clicked 1 times" })).toBeVisible();
  });
});

describe("loading extensions", () => {
  it("loads a built extension bundle the way Foxglove does", async () => {
    const source = `
      module.exports.activate = function (context) {
        context.registerPanel({
          name: "bundled",
          initPanel: function (panelContext) {
            panelContext.panelElement.textContent = "Loaded from the bundle";
          },
        });
      };
    `;
    const foxglove = await simulateFoxglove({ extension: { source } });

    await foxglove.openPanel("bundled");

    await expect.element(page.getByText("Loaded from the bundle")).toBeVisible();
  });

  it("explains which panels exist when opening one that does not", async () => {
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerPanel({ name: "real", initPanel: () => undefined });
      },
    });

    await expect(foxglove.openPanel("missing")).rejects.toThrow(
      'The extension did not register a panel named "missing". Registered panels: "real"',
    );
  });

  it("waits for an async activate function", async () => {
    const foxglove = await simulateFoxglove({
      extension: async (context: Experimental.ExtensionContext) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        context.registerDataLoader({ type: "file", wasmUrl: "x.wasm", supportedFileType: ".bin" });
      },
    });

    expect(foxglove.extension.dataLoaders).toHaveLength(1);
  });
});

describe("fake timers", () => {
  it("keeps working when the test installs fake timers", async () => {
    vi.useFakeTimers();
    try {
      const probe = newProbe();
      const panel: SimulatedPanel = await renderPanel(
        probePanel(probe, { fields: ["currentTime"] }),
        { dataSource: recording },
      );
      await panel.foxglove.advance(0.1);
      expect(lastRender(probe).currentTime).toEqual({ sec: 10, nsec: 100_000_000 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("edge cases", () => {
  it("gives a panel the latest message on a topic another panel already subscribes to", async () => {
    const second = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerPanel({
          name: "first",
          initPanel: probePanel(newProbe(), {
            fields: ["currentFrame"],
            topics: [{ topic: "/speed" }],
          }),
        });
        context.registerPanel({
          name: "second",
          initPanel: probePanel(second, {
            fields: ["currentFrame", "didSeek"],
            topics: [{ topic: "/speed" }],
          }),
        });
      },
      dataSource: recording,
      frameDuration: 0.5,
    });
    await foxglove.openPanel("first");
    await foxglove.advanceTo(11.5);

    await foxglove.openPanel("second");

    expect(frameMessages(lastRender(second))).toEqual([{ value: 2 }]);
  });

  it("lets awaited calls finish while playing", async () => {
    const probe = newProbe();
    const panel = await renderPanel(probePanel(probe, { fields: ["currentTime", "variables"] }), {
      dataSource: { type: "live" },
    });

    panel.foxglove.play();
    await panel.foxglove.setVariable("mode", "auto");
    await panel.foxglove.settle();
    await panel.foxglove.pause();

    expect(lastRender(probe).variables).toEqual(new Map([["mode", "auto"]]));
    expect(panel.foxglove.isPlaying).toBe(false);
  });

  it("stops playing and reports it when a frame fails", async () => {
    let calls = 0;
    const panel = await renderPanel(
      (context) => {
        context.watch("currentTime");
        context.onRender = (_renderState, done) => {
          calls += 1;
          // The panel stops calling done() after its first render
          if (calls === 1) {
            done();
          }
        };
      },
      { dataSource: recording, renderTimeoutMs: 200 },
    );

    panel.foxglove.play();
    await expect.poll(() => panel.foxglove.isPlaying).toBe(false);

    await expect(panel.foxglove.settle()).rejects.toThrow('Panel "panel" did not call done()');
  });

  it("runs a topic converter with several inputs once per message when loading ranges", async () => {
    const batches: unknown[] = [];
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerMessageConverter({
          type: "topic",
          inputTopics: ["/speed", "/other"],
          outputTopic: "/merged",
          outputSchemaName: "Merged",
          create: () => (event) => ({ from: event.topic }),
        });
        context.registerPanel({
          name: "range",
          initPanel: (panelContext) => {
            panelContext.subscribeMessageRange!({
              topic: "/merged",
              onNewRangeIterator: async (iterator) => {
                for await (const batch of iterator) {
                  batches.push(...batch.map((event) => event.message));
                }
              },
            });
          },
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("range");

    expect(batches).toEqual([
      { from: "/speed" },
      { from: "/other" },
      { from: "/speed" },
      { from: "/speed" },
    ]);
  });

  it("creates a topic converter again after a seek, like Foxglove", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerMessageConverter({
          type: "topic",
          inputTopics: ["/speed"],
          outputTopic: "/count",
          outputSchemaName: "Count",
          create: () => {
            let count = 0;
            return () => {
              count += 1;
              return { count, big: 1n };
            };
          },
        });
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, { fields: ["currentFrame"], topics: [{ topic: "/count" }] }),
        });
      },
      dataSource: recording,
      frameDuration: 1,
    });
    await foxglove.openPanel("probe");
    await foxglove.advanceTo(12);
    await foxglove.seek(11);

    expect(probe.renders.flatMap(frameMessages)).toEqual([
      { count: 1, big: 1n },
      { count: 2, big: 1n },
      { count: 3, big: 1n },
      { count: 1, big: 1n },
    ]);
    expect(foxglove.problems).toEqual([]);
  });

  it("lists a topic converter's output only when one of its inputs exists", async () => {
    const probe = newProbe();
    await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerMessageConverter({
          type: "topic",
          inputTopics: ["/gps"],
          outputTopic: "/fix",
          outputSchemaName: "Fix",
          create: () => () => undefined,
        });
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, { fields: ["topics"] }),
        });
      },
      dataSource: recording,
    }).then(async (foxglove) => await foxglove.openPanel("probe"));

    const topics = lastRender(probe).topics as { name: string }[];
    expect(topics.map((topic) => topic.name)).toEqual(["/other", "/speed"]);
  });

  it("reports a topic problem once, however often topics are computed", async () => {
    const panel = await renderPanel(probePanel(newProbe(), { fields: ["topics"] }), {
      dataSource: recording,
    });
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerTopicAliases(() => [{ name: "/speed", sourceTopicName: "/other" }]);
      },
      dataSource: recording,
    });

    await foxglove.setVariable("a", 1);
    await foxglove.setVariable("a", 2);

    expect(foxglove.problems).toEqual([
      'The topic alias "/speed" is ignored because a topic with that name already exists',
    ]);
    expect(panel.foxglove.problems).toEqual([]);
  });

  it("merges saved state into the panel's state, like Foxglove", async () => {
    const panel = await renderPanel(
      (context) => {
        context.saveState({ color: "red" });
      },
      { initialState: { topic: "/speed" }, width: 300, height: 120 },
    );

    expect(panel.savedState).toEqual({ topic: "/speed", color: "red" });
    const reloaded = await panel.reload();
    expect(reloaded.initialState).toEqual({ topic: "/speed", color: "red" });
    expect(reloaded.element.getBoundingClientRect().height).toBe(120);
  });

  it("reports a range loader that throws before it returns a promise", async () => {
    const panel = await renderPanel(
      (context) => {
        context.subscribeMessageRange!({
          topic: "/speed",
          onNewRangeIterator: () => {
            throw new Error("not ready");
          },
        });
      },
      { dataSource: recording },
    );

    expect(panel.foxglove.problems).toEqual([
      'onNewRangeIterator of panel "panel" threw for "/speed": not ready',
    ]);
  });
});

describe("waiting for the backend", () => {
  it("waits for service calls before settling", async () => {
    const panel = await renderPanel(
      (context) => {
        const button = document.createElement("button");
        button.textContent = "Reset";
        button.onclick = () => {
          void context.callService!("/reset", {}).then((response) => {
            context.panelElement.append(`Reset: ${JSON.stringify(response)}`);
          });
        };
        context.panelElement.append(button);
      },
      {
        dataSource: {
          type: "live",
          services: {
            "/reset": async () => {
              await new Promise((resolve) => setTimeout(resolve, 300));
              return { ok: true };
            },
          },
        },
      },
    );

    await page.getByRole("button", { name: "Reset" }).click();
    await panel.foxglove.settle();

    expect(panel.element.textContent).toContain('Reset: {"ok":true}');
  });

  it("lets service handlers and onPublish answer through the robot", async () => {
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, {
        fields: ["currentFrame"],
        topics: [{ topic: "/state" }],
        setup: (context) => {
          context.advertise!("/cmd", "Command");
        },
      }),
      {
        dataSource: {
          type: "live",
          topics: [{ name: "/state", schemaName: "State" }],
          services: {
            "/start": async (_request, robot) => {
              await robot.receive({ topic: "/state", message: { running: true } });
              return "started";
            },
          },
          onPublish: async (message, robot) => {
            await robot.receive({ topic: "/state", message: { command: message.message } });
            await robot.receive({ topic: "/unknown", message: {} });
          },
        },
      },
    );

    await expect(panel.context.callService!("/start", {})).resolves.toBe("started");
    panel.context.publish!("/cmd", "stop");
    await panel.foxglove.settle();

    expect(probe.renders.flatMap(frameMessages)).toEqual([{ running: true }, { command: "stop" }]);
    expect(panel.foxglove.problems).toEqual([
      'onPublish failed for a message on "/cmd": A message on "/unknown" has no schemaName, and "/unknown" is not in the data source\'s topics. Add the topic to topics, or set schemaName on the message.',
    ]);
  });
});

describe("matching Foxglove", () => {
  it("runs one converter for each topic and target schema", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        for (const label of ["first", "second"]) {
          context.registerMessageConverter({
            type: "schema",
            fromSchemaName: "Speed",
            toSchemaName: "Labeled",
            converter: () => ({ label }),
          });
        }
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, {
            fields: ["currentFrame"],
            topics: [{ topic: "/speed", convertTo: "Labeled" }],
          }),
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("probe");

    expect(frameMessages(lastRender(probe))).toEqual([{ label: "first" }]);
  });

  it("skips a render when a converter throws, as Foxglove does", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerMessageConverter({
          type: "schema",
          fromSchemaName: "Speed",
          toSchemaName: "Broken",
          converter: () => {
            throw new Error("bad message");
          },
        });
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, {
            fields: ["currentFrame"],
            topics: [{ topic: "/speed", convertTo: "Broken" }, { topic: "/other" }],
          }),
        });
      },
      dataSource: {
        type: "recording",
        topics: [
          { name: "/speed", schemaName: "Speed" },
          { name: "/other", schemaName: "Other" },
        ],
        messages: [
          { topic: "/speed", receiveTime: 1, message: {} },
          { topic: "/other", receiveTime: 1, message: { lost: true } },
          { topic: "/other", receiveTime: 2, message: { kept: true } },
        ],
      },
      frameDuration: 1,
    });
    await foxglove.openPanel("probe");
    await foxglove.advanceTo(2);

    expect(probe.renders.flatMap(frameMessages)).toEqual([{ kept: true }]);
  });

  it("unmounts a panel that throws while rendering", async () => {
    const cleanupPanel = vi.fn();
    let renders = 0;
    const panel = await renderPanel(
      (context) => {
        context.watch("currentTime");
        context.onRender = () => {
          renders += 1;
          throw new Error("render failed");
        };
        return cleanupPanel;
      },
      { dataSource: recording },
    );
    await panel.foxglove.advance(0.5);

    expect(renders).toBe(1);
    expect(cleanupPanel).toHaveBeenCalledTimes(1);
    expect(panel.mounted).toBe(false);
    await expect.element(page.getByText("Panel error: render failed")).toBeVisible();
  });

  it("starts range loading again, and backfills, when an alias points somewhere else", async () => {
    const loads: unknown[][] = [];
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerTopicAliases(({ globalVariables }) => [
          {
            name: "/selected",
            sourceTopicName: globalVariables.source === "other" ? "/other" : "/speed",
          },
        ]);
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, {
            fields: ["currentFrame"],
            topics: [{ topic: "/selected" }],
            setup: (panelContext) => {
              panelContext.subscribeMessageRange!({
                topic: "/selected",
                onNewRangeIterator: async (iterator) => {
                  const load: unknown[] = [];
                  loads.push(load);
                  for await (const batch of iterator) {
                    load.push(...batch.map((event) => event.message));
                  }
                },
              });
            },
          }),
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("probe");
    await foxglove.advanceTo(11);

    await foxglove.setVariable("source", "other");

    expect(loads).toEqual([[{ value: 1 }, { value: 2 }, { value: 3 }], [{ value: "x" }]]);
    expect(frameMessages(lastRender(probe))).toEqual([{ value: "x" }]);
  });

  it("provides metadata and attachments from a recording", async () => {
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, {
        fields: ["metadata" as keyof RenderState, "attachments" as keyof RenderState],
      }),
      {
        dataSource: {
          type: "recording",
          metadata: [{ name: "robot", metadata: { serial: "42" } }],
          attachments: [
            { name: "map.png", mediaType: "image/png", logTime: 3, data: new Uint8Array([1, 2]) },
          ],
        },
      },
    );
    const context = panel.context as Experimental.PanelExtensionContext;

    expect(lastRender(probe).metadata).toEqual([{ name: "robot", metadata: { serial: "42" } }]);
    expect(lastRender(probe).attachments).toEqual([
      {
        id: "0",
        name: "map.png",
        mediaType: "image/png",
        logTime: { sec: 3, nsec: 0 },
        createTime: { sec: 3, nsec: 0 },
        sizeBytes: 2,
      },
    ]);
    await expect(context.fetchAttachment!("0")).resolves.toEqual(new Uint8Array([1, 2]));
  });

  it("reports render state fields the simulation does not provide", async () => {
    const panel = await renderPanel((context) => {
      context.watch("notAField" as keyof RenderState);
      // Compare mode fields are undefined outside compare mode, in Foxglove too
      context.watch("comparisonSources" as keyof RenderState);
    });

    expect(panel.foxglove.problems).toEqual([
      'Panel "panel" watches "notAField", which the simulated Foxglove does not provide',
    ]);
  });

  it("passes modules to a bundle's require", async () => {
    const source = `
      const label = require("label-module");
      module.exports.activate = (context) => {
        context.registerPanel({
          name: "bundled",
          initPanel: (panelContext) => {
            panelContext.panelElement.textContent = label;
          },
        });
      };
    `;
    const foxglove = await simulateFoxglove({
      extension: { source, modules: { "label-module": "From a module" } },
    });

    await foxglove.openPanel("bundled");

    await expect.element(page.getByText("From a module")).toBeVisible();
  });
});

describe("tests", () => {
  it("find elements in one panel by its test id, across renders", async () => {
    const panel = await renderPanel(
      probePanel(newProbe(), { fields: ["currentFrame"], topics: [{ topic: "/speed" }] }),
      {
        dataSource: recording,
        frameDuration: 1,
      },
    );
    const inPanel = page.getByTestId(panel.testId);

    await expect.element(inPanel.getByText('/speed: {"value":1}')).toBeVisible();
    await panel.foxglove.advanceTo(12);
    await expect.element(inPanel.getByText('/speed: {"value":3}')).toBeVisible();
  });

  it("refuses settings values the sidebar cannot send", async () => {
    const sent: SettingsTreeAction[] = [];
    const panel = await renderPanel((context) => {
      context.updatePanelSettingsEditor({
        nodes: {
          general: {
            fields: {
              limit: { label: "Limit", input: "number", value: 3, max: 10 },
              units: {
                label: "Units",
                input: "select",
                value: "furlongs",
                options: [{ label: "Meters", value: "m" }],
              },
            },
          },
        },
        actionHandler: (action) => {
          sent.push(action);
        },
      });
    });

    await expect(panel.settings.update(["general", "limit"], "seven")).rejects.toThrow(
      'cannot set ["general", "limit"] to "seven": it takes a number',
    );
    // Like Foxglove's number input, an out-of-range number is clamped rather than refused
    await panel.settings.update(["general", "limit"], 99);
    expect(sent.at(-1)).toEqual({
      action: "update",
      payload: { path: ["general", "limit"], input: "number", value: 10 },
    });
    await expect(panel.settings.update(["general", "units"], "km")).rejects.toThrow(
      "it is not one of the enabled options",
    );
    // A value that matches no option shows as empty
    await expect.element(page.getByLabelText("Units")).toHaveValue("");
  });

  it("plays a minute of recording frame by frame within a test's time", async () => {
    const messages = Array.from({ length: 60 }, (_value, index) => ({
      topic: "/speed",
      receiveTime: index + 1,
      message: { value: index },
    }));
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, { fields: ["currentFrame"], topics: [{ topic: "/speed" }] }),
      {
        dataSource: {
          type: "recording",
          topics: [{ name: "/speed", schemaName: "Speed" }],
          messages,
        },
      },
    );

    const started = performance.now();
    await panel.foxglove.advanceTo(60);

    expect(probe.renders.flatMap(frameMessages)).toHaveLength(60);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("stops advancing when the simulation is closed", async () => {
    const panel = await renderPanel(probePanel(newProbe(), { fields: ["currentTime"] }), {
      dataSource: recording,
    });

    const advancing = panel.foxglove.advanceTo(12);
    panel.foxglove.close();

    await expect(advancing).rejects.toThrow("The simulated Foxglove was closed");
  });
});

describe("review fixes", () => {
  it("does not repeat a message for a panel that joins a topic after it played", async () => {
    const second = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerPanel({
          name: "first",
          initPanel: probePanel(newProbe(), {
            fields: ["currentFrame"],
            topics: [{ topic: "/speed" }],
          }),
        });
        context.registerPanel({
          name: "second",
          initPanel: probePanel(second, {
            fields: ["currentFrame"],
            topics: [{ topic: "/speed" }],
          }),
        });
      },
      dataSource: recording,
      frameDuration: 1,
    });
    await foxglove.openPanel("first");
    // The last frame holds the message at 12
    await foxglove.advanceTo(12);

    await foxglove.openPanel("second");

    expect(second.renders.flatMap(frameMessages)).toEqual([{ value: 3 }]);
  });

  it("keeps the sidebar on the panel the test selected", async () => {
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerPanel({
          name: "focused",
          initPanel: (panelContext) => {
            panelContext.watch("currentTime");
            const focusedPath = ["general"];
            panelContext.onRender = (_renderState, done) => {
              panelContext.updatePanelSettingsEditor({
                focusedPath,
                nodes: { general: { label: "Focused settings" } },
                actionHandler: () => undefined,
              });
              done();
            };
          },
        });
        context.registerPanel({
          name: "other",
          initPanel: (panelContext) => {
            panelContext.updatePanelSettingsEditor({
              nodes: { general: { label: "Other settings" } },
              actionHandler: () => undefined,
            });
          },
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("focused");
    const other = await foxglove.openPanel("other");

    other.select();
    await foxglove.advance(0.5);

    await expect.element(page.getByRole("group", { name: "Other settings" })).toBeVisible();
  });

  it("renders toolbar icons given by name", async () => {
    const panel = await renderPanel((context) => {
      (context as Experimental.PanelExtensionContext).setPanelToolbarItems([
        {
          type: "button",
          id: "refresh",
          tooltip: "Refresh",
          icon: "refresh" as unknown as SVGElement,
        },
      ]);
    });

    await expect
      .element(page.getByTestId(panel.testId).getByRole("button", { name: "Refresh" }))
      .toBeVisible();
  });

  it("rejects times outside the valid range", async () => {
    await expect(
      renderPanel(() => undefined, {
        dataSource: { type: "live", startTime: { sec: 0, nsec: -5 } },
      }),
    ).rejects.toThrow("nsec must be from 0 to 999999999");
  });

  it("does not load a bundle that only has a default export, like Foxglove", async () => {
    const source = `module.exports.default = { activate: function () {} };`;

    await expect(simulateFoxglove({ extension: { source } })).rejects.toThrow(
      "The extension bundle does not export an activate function",
    );
  });
});

describe("review fixes, round 3", () => {
  it("restarts range loading with the converter for the alias's new schema", async () => {
    const loads: unknown[][] = [];
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        for (const fromSchemaName of ["Speed", "Other"]) {
          context.registerMessageConverter({
            type: "schema",
            fromSchemaName,
            toSchemaName: "Out",
            converter: () => ({ from: fromSchemaName }),
          });
        }
        context.registerTopicAliases(({ globalVariables }) => [
          {
            name: "/selected",
            sourceTopicName: globalVariables.source === "other" ? "/other" : "/speed",
          },
        ]);
        context.registerPanel({
          name: "range",
          initPanel: (panelContext) => {
            panelContext.subscribeMessageRange!({
              topic: "/selected",
              convertTo: "Out",
              onNewRangeIterator: async (iterator) => {
                const load: unknown[] = [];
                loads.push(load);
                for await (const batch of iterator) {
                  load.push(...batch.map((event) => event.message));
                }
              },
            });
          },
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("range");

    await foxglove.setVariable("source", "other");

    expect(loads.at(-1)).toEqual([{ from: "Other" }]);
    expect(foxglove.problems).toEqual([]);
  });

  it("does not deadlock when a service handler sends messages to a panel waiting on it", async () => {
    const probe = newProbe();
    const panel = await renderPanel(
      (context) => {
        context.watch("currentFrame");
        context.subscribe([{ topic: "/state" }]);
        let initialized = false;
        context.onRender = (renderState, done) => {
          probe.renders.push({ ...renderState });
          if (initialized) {
            done();
            return;
          }
          initialized = true;
          void context.callService!("/init", {}).then(() => {
            done();
          });
        };
      },
      {
        dataSource: {
          type: "live",
          topics: [{ name: "/state", schemaName: "State" }],
          services: {
            "/init": async (_request, robot) => {
              await robot.receive({ topic: "/state", message: { ready: true } });
              return "ok";
            },
          },
        },
        renderTimeoutMs: 1000,
      },
    );
    await panel.foxglove.receive({ topic: "/state", message: { first: true } });

    expect(probe.renders.flatMap(frameMessages)).toContainEqual({ ready: true });
  });

  it("renders once without currentFrame after a frame with messages, like Foxglove", async () => {
    const probe = newProbe();
    const panel = await renderPanel(
      probePanel(probe, { fields: ["currentFrame"], topics: [{ topic: "/speed" }] }),
      { dataSource: recording, frameDuration: 0.5 },
    );
    probe.renders.length = 0;

    await panel.foxglove.advanceTo(12);

    // Frames alternate between one with a /speed message and one without
    expect(probe.renders.map((render) => frameMessages(render).length)).toEqual([0, 1, 0, 1]);
  });

  it("reports a cleanup function that throws after a render error", async () => {
    const panel = await renderPanel((context) => {
      context.watch("colorScheme");
      context.onRender = () => {
        throw new Error("render failed");
      };
      return () => {
        throw new Error("cleanup failed");
      };
    });

    expect(panel.foxglove.problems).toEqual([
      'Panel "panel" threw while rendering: render failed',
      'The cleanup function of panel "panel" threw: cleanup failed',
    ]);
  });

  it("records panels of other types that a panel asks to add", async () => {
    const panel = await renderPanel((context) => {
      context.layout.addPanel({
        position: "sibling",
        type: "Plot",
        getState: () => ({ paths: [] }),
      });
    });

    expect(panel.foxglove.addedPanels).toEqual([
      { type: "Plot", initialState: { paths: [] }, panel: undefined },
    ]);
    expect(panel.foxglove.problems).toEqual([]);
  });

  it("opens registered panels whose names contain dots", async () => {
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerPanel({
          name: "map.view",
          initPanel: (panelContext) => {
            panelContext.panelElement.textContent = "Map view";
          },
        });
        context.registerPanel({
          name: "opener",
          initPanel: (panelContext) => {
            panelContext.layout.addPanel({
              position: "sibling",
              type: "acme.ext.map.view",
              getState: () => ({}),
            });
          },
        });
      },
    });

    await foxglove.openPanel("opener");

    expect(foxglove.addedPanels[0]?.panel?.name).toBe("map.view");
  });

  it("reports an alias function that returns something other than a list", async () => {
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerTopicAliases((() => undefined) as never);
      },
      dataSource: recording,
    });

    expect(foxglove.problems).toEqual([
      "A topic alias function returned something other than a list of { name, sourceTopicName }",
    ]);
  });

  it("leaves topics unchanged when a live message is rejected, and checks service names", async () => {
    const probe = newProbe();
    const panel = await renderPanel(probePanel(probe, { fields: ["topics"] }), {
      dataSource: { type: "live", services: {} },
    });

    await expect(
      panel.foxglove.receive([
        { topic: "/new", schemaName: "New", message: {} },
        { topic: "/unknown", message: {} },
      ]),
    ).rejects.toThrow('A message on "/unknown" has no schemaName');
    await panel.foxglove.receive({ topic: "/new", schemaName: "New", message: {} });

    expect(lastRender(probe).topics).toEqual([
      { name: "/new", schemaName: "New", datatype: "New" },
    ]);
    await expect(panel.context.callService!("toString", {})).rejects.toThrow(
      'Service "toString" is not available',
    );
  });

  it("measures binary data by its byte length", async () => {
    const image = { data: new Uint8Array(2_000_000) };
    const sizes: number[] = [];
    await renderPanel(
      (context) => {
        context.watch("currentFrame");
        context.subscribe([{ topic: "/image" }]);
        context.onRender = (renderState, done) => {
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          sizes.push(...(renderState.currentFrame ?? []).map((event) => event.sizeInBytes));
          done();
        };
      },
      {
        dataSource: {
          type: "recording",
          topics: [{ name: "/image", schemaName: "Image" }],
          messages: [{ topic: "/image", receiveTime: 0, message: image }],
        },
      },
    );

    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeGreaterThanOrEqual(2_000_000);
    expect(sizes[0]).toBeLessThan(2_001_000);
  });
});

describe("review fixes, round 4", () => {
  it("skips a frame whose converter fails once, and still renders other changes", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerMessageConverter({
          type: "schema",
          fromSchemaName: "Speed",
          toSchemaName: "Broken",
          converter: () => {
            throw new Error("bad message");
          },
        });
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, {
            fields: ["currentFrame", "variables"],
            topics: [{ topic: "/speed", convertTo: "Broken" }],
          }),
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("probe");

    await foxglove.setVariable("mode", "manual");

    expect(lastRender(probe).variables).toEqual(new Map([["mode", "manual"]]));
    expect(foxglove.problems).toHaveLength(1);
  });

  it("lets the robot set parameters that panels cannot", async () => {
    const probe = newProbe();
    const panel = await renderPanel(probePanel(probe, { fields: ["parameters"] }), {
      dataSource: { type: "live", capabilities: { parameters: false } },
    });

    await panel.foxglove.setParameter("/mode", "auto");

    expect(lastRender(probe).parameters).toEqual(new Map([["/mode", "auto"]]));
    expect(panel.foxglove.problems).toEqual([]);
    const file = await renderPanel(() => undefined, { dataSource: recording });
    await expect(file.foxglove.setParameter("/mode", "auto")).rejects.toThrow(
      "setParameter() is for live data sources",
    );
  });

  it("checks play speeds, seeks before the start, and one-sided recording bounds", async () => {
    const panel = await renderPanel(() => undefined, {
      dataSource: {
        type: "recording",
        startTime: 5,
        topics: [{ name: "/a", schemaName: "A" }],
        messages: [{ topic: "/a", receiveTime: 6, message: {} }],
      },
    });

    expect(() => {
      panel.foxglove.play({ speed: 0 });
    }).toThrow("play() needs a speed greater than 0");
    await panel.foxglove.seekFromStart(-2);
    expect(panel.foxglove.currentTime).toEqual({ sec: 5, nsec: 0 });

    const onlyStart = await renderPanel(() => undefined, {
      dataSource: { type: "recording", startTime: 5, messages: [], topics: [] },
    });
    expect(onlyStart.foxglove.endTime).toEqual({ sec: 5, nsec: 0 });
  });

  it("keeps settings.tree current, and records toolbar links instead of following them", async () => {
    const panel = await renderPanel((context) => {
      const update = (color: string) => {
        context.updatePanelSettingsEditor({
          nodes: { general: { fields: { color: { label: "Color", input: "rgb", value: color } } } },
          actionHandler: (action) => {
            if (action.action === "update") {
              update(String(action.payload.value));
            }
          },
        });
      };
      update("blue");
      (context as Experimental.PanelExtensionContext).setPanelToolbarItems([
        {
          type: "link",
          id: "docs",
          tooltip: "Docs",
          href: "https://example.com/docs",
          target: "_self",
          icon: "docs" as unknown as SVGElement,
        },
        {
          type: "link",
          id: "off",
          tooltip: "Off",
          href: "https://example.com/off",
          disabled: true,
          icon: "off" as unknown as SVGElement,
        },
      ]);
    });
    const settings = panel.settings;

    await settings.update(["general", "color"], "red");
    await page.getByRole("link", { name: "Docs" }).click();

    expect(settings.tree?.nodes.general?.fields?.color?.value).toBe("red");
    expect(panel.followedLinks).toEqual(["https://example.com/docs"]);
    await expect.element(page.getByLabelText("Off")).toHaveAttribute("aria-disabled", "true");
  });
});

describe("review fixes, round 5", () => {
  it("delivers the rest of allFrames when a converter throws on one message", async () => {
    const probe = newProbe();
    const foxglove = await simulateFoxglove({
      extension: (context: ExtensionContext) => {
        context.registerMessageConverter({
          type: "schema",
          fromSchemaName: "Speed",
          toSchemaName: "Checked",
          converter: (message: { value: number }) => {
            if (message.value === 2) {
              throw new Error("bad value");
            }
            return { checked: message.value };
          },
        });
        context.registerPanel({
          name: "probe",
          initPanel: probePanel(probe, {
            fields: ["allFrames"],
            topics: [{ topic: "/speed", convertTo: "Checked", preload: true }],
          }),
        });
      },
      dataSource: recording,
    });
    await foxglove.openPanel("probe");

    const allFrames = lastRender(probe).allFrames as MessageEvent[];
    expect(allFrames.map((event) => event.message)).toEqual([{ checked: 1 }, { checked: 3 }]);
  });

  it("clamps and rounds numbers typed in the sidebar, like Foxglove's number input", async () => {
    const sent: unknown[] = [];
    await renderPanel((context) => {
      context.updatePanelSettingsEditor({
        nodes: {
          general: {
            fields: {
              gain: { label: "Gain", input: "number", value: 1, min: 0, max: 10, precision: 1 },
            },
          },
        },
        actionHandler: (action) => {
          if (action.action === "update") {
            sent.push(action.payload.value);
          }
        },
      });
    });

    await page.getByLabelText("Gain").fill("25.37");
    await page.getByLabelText("Gain").fill("3.14159");

    expect(sent).toEqual([10, 3.1]);
  });

  it("does not report a seek without a data source", async () => {
    const probe = newProbe();
    await renderPanel(probePanel(probe, { fields: ["didSeek", "colorScheme"] }));

    // Foxglove delivers false, which differs from the field being unset
    expect(lastRender(probe).didSeek).toBe(false);
  });

  it("ignores done() after the panel unmounted", async () => {
    let finish: (() => void) | undefined;
    const panel = await renderPanel(
      (context) => {
        context.watch("currentTime");
        let first = true;
        context.onRender = (_renderState, done) => {
          if (first) {
            first = false;
            done();
          } else {
            finish = done;
          }
        };
      },
      { dataSource: recording, renderTimeoutMs: 5000 },
    );
    const renders = panel.renderCount;
    void panel.foxglove.advance(0.1).catch(() => undefined);
    await expect.poll(() => finish).toBeDefined();

    panel.unmount();
    finish!();

    expect(panel.renderCount).toBe(renders);
  });

  it("keeps read-only text areas enabled, and describes toggles with their help", async () => {
    await renderPanel((context) => {
      context.updatePanelSettingsEditor({
        nodes: {
          general: {
            fields: {
              notes: { label: "Notes", input: "multiline-string", value: "x", readonly: true },
              mode: {
                label: "Mode",
                input: "toggle",
                value: "a",
                options: ["a", "b"],
                help: "How the robot moves",
              },
            },
          },
        },
        actionHandler: () => undefined,
      });
    });

    await expect.element(page.getByLabelText("Notes")).toBeEnabled();
    await expect.element(page.getByLabelText("Notes")).toHaveAttribute("readonly");
    await expect
      .element(page.getByRole("radio", { name: "b" }))
      .toHaveAccessibleDescription("How the robot moves");
  });

  it("moves a live clock in one step", async () => {
    const probe = newProbe();
    const panel = await renderPanel(probePanel(probe, { fields: ["currentTime"] }), {
      dataSource: { type: "live" },
    });
    const renders = probe.renders.length;

    await panel.foxglove.advanceTo(600);

    expect(probe.renders.length - renders).toBe(1);
    expect(panel.foxglove.currentTime).toEqual({ sec: 600, nsec: 0 });
  });
});
