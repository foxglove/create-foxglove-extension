import type { MessageEvent, ParameterValue } from "@foxglove/extension";

import {
  compareStored,
  fromNanoseconds,
  toNanoseconds,
  type Nanoseconds,
  type TimeInput,
} from "./time.mjs";

/** A topic in a simulated data source. */
export interface TopicDefinition {
  readonly name: string;
  readonly schemaName: string;
}

/** A message in a simulated data source. */
export interface RecordedMessage<T = unknown> {
  readonly topic: string;
  /** When the message was received. Numbers are seconds. */
  readonly receiveTime: TimeInput;
  readonly message: T;
  /** When the message was published, for data sources that know it. Numbers are seconds. */
  readonly publishTime?: TimeInput;
  /**
   * Defaults to the schema name of the topic. Required for a message on a topic that is not
   * listed in `topics`, which then adds the topic.
   */
  readonly schemaName?: string;
  /** Defaults to an estimate based on the size of the message as JSON. */
  readonly sizeInBytes?: number;
}

/**
 * A recording, like an MCAP file opened in Foxglove. Panels can seek, play, and load message
 * ranges. Recordings cannot publish, call services, or set parameters.
 */
export interface RecordingDataSource {
  readonly type: "recording";
  /** Topics in the recording. Topics of `messages` that set a `schemaName` are added. */
  readonly topics?: readonly TopicDefinition[];
  /** Messages in the recording, in any order. */
  readonly messages?: readonly RecordedMessage[];
  /** Start of the recording. Defaults to the time of the first message, or 0. */
  readonly startTime?: TimeInput;
  /** End of the recording. Defaults to the time of the last message, or the start time. */
  readonly endTime?: TimeInput;
  /** Value of `context.dataSourceProfile`, such as `"ros1"` or `"ros2"`. */
  readonly profile?: string;
  /** Metadata records, for the experimental `metadata` render state field. */
  readonly metadata?: readonly {
    readonly name: string;
    readonly metadata: Readonly<Record<string, string>>;
  }[];
  /**
   * Attachments, for the experimental `attachments` render state field and
   * `context.fetchAttachment`.
   */
  readonly attachments?: readonly RecordedAttachment[];
}

/** An attachment in a simulated recording, like an attachment in an MCAP file. */
export interface RecordedAttachment {
  readonly name: string;
  readonly mediaType: string;
  /** Numbers are seconds. */
  readonly logTime: TimeInput;
  /** Defaults to the log time. Numbers are seconds. */
  readonly createTime?: TimeInput;
  readonly data: Uint8Array;
}

/** A message for {@link SimulatedRobot.receive}. The receive time defaults to now. */
export type LiveMessage<T = unknown> = Omit<RecordedMessage<T>, "receiveTime"> & {
  readonly receiveTime?: TimeInput;
};

/**
 * The robot side of a live connection, passed to service handlers and `onPublish` so they can
 * answer panels. Unlike the same methods on the simulated Foxglove, these do not wait for panels
 * to settle, so they are safe to call from inside a handler.
 */
export interface SimulatedRobot {
  /** Send messages to panels that subscribe to their topics. */
  receive(messages: LiveMessage | readonly LiveMessage[]): Promise<void>;
  /** Replace the topics the connection advertises. */
  setTopics(topics: readonly TopicDefinition[]): void;
  /** Set a parameter on the connection. */
  setParameter(name: string, value: ParameterValue): void;
}

/**
 * Handles a service call. Return the response, or a promise of it, and throw to make the call
 * fail. `robot` can send messages back, for a service that also publishes.
 */
export type ServiceHandler = (request: unknown, robot: SimulatedRobot) => unknown;

/** A message published by a panel with `context.publish`. */
export interface PublishedMessage {
  readonly topic: string;
  readonly message: unknown;
}

/**
 * A live connection, like Foxglove WebSocket or a ROS bridge. Tests push messages to panels with
 * `foxglove.receive()`. Panels can publish, call services, and set parameters, unless
 * `capabilities` turns those off. Live connections cannot seek.
 */
export interface LiveDataSource {
  readonly type: "live";
  /** Topics the connection advertises. Topics of received messages that set a schema are added. */
  readonly topics?: readonly TopicDefinition[];
  /** The time at which the connection starts. Defaults to 0. */
  readonly startTime?: TimeInput;
  /** Value of `context.dataSourceProfile`, such as `"ros1"` or `"ros2"`. */
  readonly profile?: string;
  /** The connection URL, such as `"ws://localhost:8765"`. */
  readonly url?: string;
  /**
   * What the connection supports. Each defaults to true. When `publish` is false, the panel
   * context has no `advertise`, `unadvertise`, or `publish`. When `services` is false, it has no
   * `callService`.
   */
  readonly capabilities?: {
    readonly publish?: boolean;
    readonly services?: boolean;
    readonly parameters?: boolean;
  };
  /**
   * Mocked service responses, keyed by service name. Calls to a service without a handler fail,
   * like a call to a service the robot does not offer.
   */
  readonly services?: Readonly<Record<string, ServiceHandler>>;
  /** Parameters on the connection, such as ROS parameters. */
  readonly parameters?: Readonly<Record<string, ParameterValue>>;
  /**
   * Called when a panel publishes a message, to simulate the robot's response. Send messages back
   * with `robot.receive()`. If it returns a promise, `settle()` waits for it, and a rejection is
   * added to `problems`.
   */
  readonly onPublish?: (message: PublishedMessage, robot: SimulatedRobot) => unknown;
}

/** The data source that panels read from, as if it were opened in Foxglove. */
export type DataSource = RecordingDataSource | LiveDataSource;

/** A message event with its receive time in nanoseconds, for ordering */
export interface StoredMessage {
  readonly event: MessageEvent;
  readonly ns: Nanoseconds;
}

/**
 * A rough size of a deserialized message in bytes. Binary data counts its byte length, so that
 * images and point clouds are cheap to measure.
 */
export function estimateSize(message: unknown): number {
  let size = 0;
  const seen = new Set<object>();
  const stack: unknown[] = [message];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      size += value.length * 2;
    } else if (typeof value === "number" || typeof value === "bigint") {
      size += 8;
    } else if (typeof value === "boolean" || value == undefined) {
      size += 4;
    } else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      size += value.byteLength;
    } else if (typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      for (const [key, item] of Object.entries(value)) {
        size += key.length * 2;
        stack.push(item);
      }
    }
  }
  return size;
}

/** Topics by name, in the order they were first seen */
export type TopicSchemas = Map<string, string>;

export function addTopics(topics: TopicSchemas, definitions: readonly TopicDefinition[]): void {
  for (const topic of definitions) {
    topics.set(topic.name, topic.schemaName);
  }
}

export function toStoredMessage(input: RecordedMessage, topics: TopicSchemas): StoredMessage {
  const schemaName = input.schemaName ?? topics.get(input.topic);
  if (schemaName == undefined) {
    throw new Error(
      `A message on "${input.topic}" has no schemaName, and "${input.topic}" is not in the data source's topics. Add the topic to topics, or set schemaName on the message.`,
    );
  }
  if (!topics.has(input.topic)) {
    topics.set(input.topic, schemaName);
  }
  const ns = toNanoseconds(input.receiveTime);
  const event: MessageEvent = {
    topic: input.topic,
    schemaName,
    receiveTime: fromNanoseconds(ns),
    message: input.message,
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    sizeInBytes: input.sizeInBytes ?? estimateSize(input.message),
  };
  if (input.publishTime != undefined) {
    event.publishTime = fromNanoseconds(toNanoseconds(input.publishTime));
  }
  return { event, ns };
}

/**
 * Build a `MessageEvent`, for calling a message converter or another function that takes one
 * directly. The receive time defaults to 0, and the size to an estimate.
 *
 * @example
 * ```ts
 * const event = makeMessageEvent({ topic: "/gps", schemaName: "GpsFix", message: { lat: 1 } });
 * expect(converter.converter(event.message, event)).toEqual({ latitude: 1 });
 * ```
 */
export function makeMessageEvent<T>(
  input: Omit<RecordedMessage<T>, "receiveTime" | "schemaName"> & {
    readonly schemaName: string;
    readonly receiveTime?: TimeInput;
  },
): MessageEvent<T> {
  const { event } = toStoredMessage({ ...input, receiveTime: input.receiveTime ?? 0 }, new Map());
  return event as MessageEvent<T>;
}

function minNs(a: Nanoseconds, b: Nanoseconds): Nanoseconds {
  return a < b ? a : b;
}

function maxNs(a: Nanoseconds, b: Nanoseconds): Nanoseconds {
  return a > b ? a : b;
}

/** Index of the first message after `ns`, in messages sorted by time */
function upperBound(messages: readonly StoredMessage[], ns: Nanoseconds): number {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (messages[mid]!.ns <= ns) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** The messages of a recording, indexed for playback */
export class Recording {
  public readonly topics: TopicSchemas = new Map();
  public readonly startNs: Nanoseconds;
  public readonly endNs: Nanoseconds;
  readonly #messages: StoredMessage[];
  readonly #messagesByTopic = new Map<string, StoredMessage[]>();

  public constructor(source: RecordingDataSource) {
    addTopics(this.topics, source.topics ?? []);
    // Sorting is stable, so messages at the same time keep the order they were given in
    this.#messages = (source.messages ?? [])
      .map((message) => toStoredMessage(message, this.topics))
      .sort(compareStored);
    for (const message of this.#messages) {
      const forTopic = this.#messagesByTopic.get(message.event.topic) ?? [];
      forTopic.push(message);
      this.#messagesByTopic.set(message.event.topic, forTopic);
    }
    // A bound that is not given covers the messages, and the other bound
    const firstNs = this.#messages[0]?.ns;
    const lastNs = this.#messages[this.#messages.length - 1]?.ns;
    const givenStart = source.startTime == undefined ? undefined : toNanoseconds(source.startTime);
    const givenEnd = source.endTime == undefined ? undefined : toNanoseconds(source.endTime);
    this.startNs = givenStart ?? minNs(firstNs ?? givenEnd ?? 0n, givenEnd ?? firstNs ?? 0n);
    this.endNs = givenEnd ?? maxNs(lastNs ?? this.startNs, this.startNs);
    if (this.endNs < this.startNs) {
      throw new Error("The recording's endTime is before its startTime");
    }
  }

  /** Messages on `topics` received after `fromNs` and at or before `toNs`, in time order */
  public messagesBetween(
    fromNs: Nanoseconds,
    toNs: Nanoseconds,
    topics: ReadonlySet<string>,
  ): StoredMessage[] {
    const result: StoredMessage[] = [];
    const end = upperBound(this.#messages, toNs);
    for (let index = upperBound(this.#messages, fromNs); index < end; index++) {
      const message = this.#messages[index]!;
      if (topics.has(message.event.topic)) {
        result.push(message);
      }
    }
    return result;
  }

  /** The last message on `topic` at or before `ns` */
  public lastMessageAtOrBefore(topic: string, ns: Nanoseconds): StoredMessage | undefined {
    const forTopic = this.#messagesByTopic.get(topic) ?? [];
    return forTopic[upperBound(forTopic, ns) - 1];
  }

  /** Every message on `topic`, in time order */
  public messagesOnTopic(topic: string): readonly StoredMessage[] {
    return this.#messagesByTopic.get(topic) ?? [];
  }
}
