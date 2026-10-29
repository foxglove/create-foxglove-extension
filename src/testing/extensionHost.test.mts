import type { Experimental, ExtensionContext } from "@foxglove/extension";
import { describe, expect, it } from "vite-plus/test";

import {
  createExtensionContext,
  makeMessageEvent,
  type DataLoaderRegistration,
  type UserScriptUtilityRegistration,
  type VideoDecoderRegistration,
} from "./index.mjs";

// Fails to compile if @foxglove/extension changes the registration arguments in a way that the
// harness's own types miss. The harness declares them itself so that it works with versions of
// @foxglove/extension that predate them.
type AssertAssignable<T extends U, U> = [T, U];
export type CheckRegistrationTypes = [
  AssertAssignable<Experimental.RegisterDataLoaderArgs, DataLoaderRegistration>,
  AssertAssignable<Experimental.RegisterUserScriptUtilityArgs, UserScriptUtilityRegistration>,
  AssertAssignable<Experimental.RegisterVideoDecoderArgs, VideoDecoderRegistration>,
];

describe("createExtensionContext", () => {
  it("records registered panels, converters, and topic aliases", () => {
    const extension = createExtensionContext();
    const initPanel = () => undefined;
    const aliases = () => [];

    extension.context.registerPanel({ name: "a", initPanel });
    extension.context.registerMessageConverter({
      type: "schema",
      fromSchemaName: "A",
      toSchemaName: "B",
      converter: (message) => message,
    });
    extension.context.registerMessageConverter({
      type: "topic",
      inputTopics: ["/in"],
      outputTopic: "/out",
      outputSchemaName: "Out",
      create: () => () => undefined,
    });
    extension.context.registerTopicAliases(aliases);

    expect([...extension.panels.keys()]).toEqual(["a"]);
    expect(extension.messageConverters).toHaveLength(2);
    expect(extension.schemaConverters.map((converter) => converter.toSchemaName)).toEqual(["B"]);
    expect(extension.topicConverters.map((converter) => converter.outputTopic)).toEqual(["/out"]);
    expect(extension.topicAliasFunctions).toEqual([aliases]);
  });

  it("treats converters registered without a type as schema converters", () => {
    const extension = createExtensionContext();

    extension.context.registerMessageConverter({
      fromSchemaName: "A",
      toSchemaName: "B",
      converter: (message: unknown) => message,
    });

    expect(extension.schemaConverters[0]?.type).toBe("schema");
  });

  it("passes the mode Foxglove passes", () => {
    const extension = createExtensionContext();

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(extension.context.mode).toBe("production");
  });

  it("keeps the first panel registered with a name, like Foxglove", () => {
    const extension = createExtensionContext();
    const first = { name: "a", initPanel: () => undefined };

    extension.context.registerPanel(first);
    extension.context.registerPanel({ name: "a", initPanel: () => undefined });

    expect(extension.panels.get("a")).toBe(first);
    expect(extension.warnings).toEqual([
      'Panel "a" is already registered. Foxglove keeps the first registration and ignores this one.',
    ]);
  });

  it("rejects what Foxglove rejects", () => {
    const extension = createExtensionContext<Experimental.ExtensionContext>();

    expect(() => {
      extension.context.registerUserScriptUtility({ name: "my util.ts", source: "" });
    }).toThrow('User script utility name "my util.ts" is invalid');
    expect(() => {
      extension.context.registerUserScriptUtility({ name: "time.ts", source: "" });
    }).toThrow("taken by a utility that Foxglove provides");
    extension.context.registerUserScriptUtility({ name: "add.ts", source: "" });
    expect(() => {
      extension.context.registerUserScriptUtility({ name: "Add.ts", source: "" });
    }).toThrow('already registered as "add.ts"');
    expect(() => {
      extension.context.registerMessageConverter({
        type: "topic",
        inputTopics: ["/in"],
        outputTopic: "/out",
        outputSchemaName: "foxglove.Log",
        outputSchemaDescription: { message: "string" },
        create: () => () => undefined,
      });
    }).toThrow("foxglove.Log is a well-known schema");
    expect(() => {
      (extension.context as unknown as ExtensionContext).registerMessageConverter({
        type: "other",
      } as never);
    }).toThrow("Unknown message converter type: other");
  });

  it("records registration methods it does not know about", () => {
    const extension = createExtensionContext();
    const context = extension.context as unknown as Record<string, (...args: unknown[]) => void>;

    expect("registerSomethingNew" in context).toBe(true);
    context.registerSomethingNew!({ id: 1 });

    expect(extension.otherRegistrations.get("registerSomethingNew")).toEqual([[{ id: 1 }]]);
  });
});

describe("makeMessageEvent", () => {
  it("builds an event to call a converter with", () => {
    const extension = createExtensionContext();
    extension.context.registerMessageConverter({
      type: "schema",
      fromSchemaName: "GpsFix",
      toSchemaName: "foxglove.LocationFix",
      converter: (message: { lat: number }) => ({ latitude: message.lat }),
    });
    const event = makeMessageEvent({ topic: "/gps", schemaName: "GpsFix", message: { lat: 1 } });

    expect(event).toMatchObject({
      topic: "/gps",
      schemaName: "GpsFix",
      receiveTime: { sec: 0, nsec: 0 },
      message: { lat: 1 },
    });
    expect(extension.schemaConverters[0]?.converter(event.message, event)).toEqual({
      latitude: 1,
    });
  });
});

describe("video decoders", () => {
  it("registers a second decoder with the same id, with a warning, like Foxglove", () => {
    const extension = createExtensionContext<Experimental.ExtensionContext>();
    const decoder = { id: "h265", displayName: "H.265", decoderBuilderSource: "" };

    extension.context.registerVideoDecoder(decoder);
    extension.context.registerVideoDecoder(decoder);

    expect(extension.videoDecoders).toHaveLength(2);
    expect(extension.warnings).toEqual(['A video decoder with id "h265" is already registered']);
  });
});
