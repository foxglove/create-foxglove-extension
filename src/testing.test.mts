import type { PanelExtensionContext, SettingsTreeAction } from "@foxglove/extension";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { cleanup, createExtensionContext, makeMessageEvent, renderPanel } from "./testing.mjs";

afterEach(cleanup);

/** A panel without a UI framework that exercises most of the context API. */
function initTestPanel(context: PanelExtensionContext): () => void {
  const heading = document.createElement("h1");
  heading.textContent = "Test panel";
  context.panelElement.appendChild(heading);

  context.watch("topics");
  context.watch("currentFrame");
  context.subscribe([{ topic: "/input" }]);
  context.advertise?.("/output", "std_msgs/String");
  context.setDefaultPanelTitle("Test");
  context.updatePanelSettingsEditor({
    nodes: {
      general: {
        label: "General",
        fields: { color: { label: "Color", input: "rgb", value: "#fff" } },
      },
    },
    actionHandler: (action: SettingsTreeAction) => {
      if (action.action === "update") {
        context.saveState({ color: action.payload.value });
      }
    },
  });

  context.onRender = (renderState, done) => {
    heading.textContent = `${renderState.topics?.length ?? 0} topics`;
    for (const event of renderState.currentFrame ?? []) {
      context.publish?.("/output", { data: event.message });
    }
    done();
  };

  return () => {
    heading.remove();
  };
}

describe("renderPanel", () => {
  it("mounts the panel in an element attached to the document", async () => {
    const panel = await renderPanel(initTestPanel, { width: 200, height: 100 });

    expect(document.body.contains(panel.element)).toBe(true);
    expect(panel.element.getBoundingClientRect()).toMatchObject({ width: 200, height: 100 });
    expect(panel.element.textContent).toBe("Test panel");
  });

  it("passes an empty initial state by default, like a newly added panel", async () => {
    const panel = await renderPanel(initTestPanel);

    expect(panel.context.initialState).toEqual({});
  });

  it("records the calls the panel makes to its context", async () => {
    const panel = await renderPanel(initTestPanel, { initialState: { color: "#000" } });

    expect(panel.context.initialState).toEqual({ color: "#000" });
    expect(panel.watchedFields).toEqual(new Set(["topics", "currentFrame"]));
    expect(panel.subscriptions).toEqual([{ topic: "/input" }]);
    expect(panel.advertisements.get("/output")).toEqual({ schemaName: "std_msgs/String" });
    expect(panel.defaultTitle).toBe("Test");
  });

  it("delivers watched render state and resolves when the panel calls done", async () => {
    const panel = await renderPanel(initTestPanel);

    await panel.render({
      topics: [{ name: "/input", schemaName: "std_msgs/String", datatype: "std_msgs/String" }],
      currentFrame: [makeMessageEvent("/input", "hello")],
    });

    expect(panel.element.textContent).toBe("1 topics");
    expect(panel.published).toEqual([{ topic: "/output", message: { data: "hello" } }]);
  });

  it("drops render state fields the panel does not watch", async () => {
    const onRender = vi.fn((_state: unknown, done: () => void) => {
      done();
    });
    const panel = await renderPanel((context) => {
      context.watch("topics");
      context.onRender = onRender;
    });

    await panel.render({ topics: [], currentTime: { sec: 1, nsec: 0 } });

    expect(onRender).toHaveBeenCalledWith({ topics: [] }, expect.any(Function));
  });

  it("keeps fields from earlier renders and clears currentFrame, like Foxglove", async () => {
    const states: unknown[] = [];
    const panel = await renderPanel((context) => {
      context.watch("topics");
      context.watch("currentFrame");
      context.onRender = (renderState, done) => {
        states.push({ ...renderState });
        done();
      };
    });
    const topics = [{ name: "/a", schemaName: "s", datatype: "s" }];

    await panel.render({ topics });
    await panel.render({ currentFrame: [makeMessageEvent("/a", 1)] });
    await panel.render({ topics: [] });

    expect(states).toEqual([
      { topics, currentFrame: undefined },
      { topics, currentFrame: [makeMessageEvent("/a", 1)] },
      { topics: [], currentFrame: undefined },
    ]);
  });

  it("rejects a render when none of the fields are watched", async () => {
    const panel = await renderPanel(initTestPanel);

    await expect(panel.render({ currentTime: { sec: 1, nsec: 0 } })).rejects.toThrow(
      /does not watch any of \[currentTime\]/,
    );
  });

  it("rejects a render when the panel does not call done", async () => {
    const panel = await renderPanel(
      (context) => {
        context.watch("topics");
        context.onRender = () => {};
      },
      { renderTimeoutMs: 50 },
    );

    await expect(panel.render({ topics: [] })).rejects.toThrow(/did not call done\(\)/);
  });

  it("waits for a panel that sets onRender after initPanel returns", async () => {
    const panel = await renderPanel((context) => {
      setTimeout(() => {
        context.watch("topics");
        context.onRender = (_state, done) => {
          done();
        };
      }, 20);
    });

    expect(panel.watchedFields).toEqual(new Set(["topics"]));
    await panel.render({ topics: [] });
  });

  it("sends settings actions to the panel's settings tree", async () => {
    const panel = await renderPanel(initTestPanel);

    panel.performSettingsAction({
      action: "update",
      payload: { path: ["general", "color"], input: "rgb", value: "#f00" },
    });

    expect(panel.savedState).toEqual({ color: "#f00" });
  });

  it("answers service calls with the handlers it was given", async () => {
    const panel = await renderPanel(() => {}, {
      services: { "/add": (request) => (request as { a: number; b: number }).a + 1 },
      renderTimeoutMs: 0,
    });

    await expect(panel.context.callService?.("/add", { a: 1, b: 2 })).resolves.toBe(2);
    await expect(panel.context.callService?.("/missing", {})).rejects.toThrow(/No handler/);
  });

  it("rejects publishing to a topic that was not advertised", async () => {
    const panel = await renderPanel(() => {}, { renderTimeoutMs: 0 });

    expect(() => panel.context.publish?.("/output", {})).toThrow(/without advertising/);
  });

  it("runs the panel's cleanup function and removes the element on unmount", async () => {
    const panel = await renderPanel(initTestPanel);
    const element = panel.element;

    cleanup();

    expect(element.textContent).toBe("");
    expect(document.body.contains(element)).toBe(false);
  });
});

describe("createExtensionContext", () => {
  it("records registered panels, converters, and topic aliases", () => {
    const extension = createExtensionContext();

    extension.context.registerPanel({ name: "panel", initPanel: initTestPanel });
    extension.context.registerMessageConverter({
      fromSchemaName: "a",
      toSchemaName: "b",
      converter: (message: unknown) => message,
    });
    extension.context.registerTopicAliases(() => []);

    expect(extension.context.mode).toBe("test");
    expect([...extension.panels.keys()]).toEqual(["panel"]);
    expect(extension.messageConverters).toHaveLength(1);
    expect(extension.topicAliasFunctions).toHaveLength(1);
  });

  it("rejects panels registered twice with the same name", () => {
    const extension = createExtensionContext();
    extension.context.registerPanel({ name: "panel", initPanel: initTestPanel });

    expect(() => {
      extension.context.registerPanel({ name: "panel", initPanel: initTestPanel });
    }).toThrow(/already registered/);
  });
});
