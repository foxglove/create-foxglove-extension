import type {
  AppSettingValue,
  Experimental,
  ExtensionContext,
  ExtensionPanelRegistration,
  Immutable,
  LayoutActions,
  MessageEvent,
  ParameterValue,
  PanelExtensionContext,
  RegisterMessageConverterArgsTopic,
  RenderState,
  Subscription,
  Time,
  Topic,
  VariableValue,
} from "@foxglove/extension";

import {
  Recording,
  addTopics,
  estimateSize,
  toStoredMessage,
  type DataSource,
  type LiveDataSource,
  type LiveMessage,
  type SimulatedRobot,
  type PublishedMessage,
  type StoredMessage,
  type TopicDefinition,
  type TopicSchemas,
} from "./dataSource.mjs";
import {
  activateExtension,
  outputSchemaName,
  type ExtensionHarness,
  type ExtensionInput,
  type ExtensionRegistrations,
} from "./extensionHost.mjs";
import {
  interceptNetwork,
  type NetworkInterceptor,
  type NetworkOptions,
  type RecordedRequest,
} from "./network.mjs";
import {
  EMPTY_VARIABLES,
  PanelHost,
  type Advertisement,
  type OpenPanelOptions,
  type PanelEnvironment,
  type PanelSettings,
  type PlayerFrame,
  type SharedRenderInputs,
} from "./panelHost.mjs";
import {
  formatTime,
  fromNanoseconds,
  nanosecondsToSeconds,
  secondsToNanoseconds,
  toNanoseconds,
  compareStored,
  type Nanoseconds,
  type TimeInput,
} from "./time.mjs";
import { delay, now } from "./timers.mjs";

/** Options for {@link simulateFoxglove}. */
export interface SimulateFoxgloveOptions {
  /** The extension to load. See {@link ExtensionInput}. */
  readonly extension: ExtensionInput;
  /**
   * The data source to open, with mocked messages and responses. Defaults to none, as when no data
   * source is open in Foxglove: panels see no topics and no times.
   */
  readonly dataSource?: DataSource;
  /** The app's color scheme. Defaults to `"light"`. */
  readonly colorScheme?: "light" | "dark";
  /** The layout's variables. */
  readonly variables?: Readonly<Record<string, VariableValue>>;
  /** App settings that panels can subscribe to with `context.subscribeAppSettings`. */
  readonly appSettings?: Readonly<Record<string, AppSettingValue>>;
  /**
   * Mocked responses for `fetch`. Requests to other servers fail unless a route answers them, so
   * tests never depend on a real backend.
   */
  readonly network?: NetworkOptions;
  /**
   * How long to wait for a panel to call `done()` after a render, and for panels to settle, in
   * milliseconds. Defaults to 2000.
   */
  readonly renderTimeoutMs?: number;
  /**
   * Length of one frame of playback, in seconds, when advancing time. Foxglove renders about 60
   * frames per second of playback, which is the default. Each frame waits for every panel to
   * render, so a long recording takes many frames. Use a longer frame to step through it faster.
   */
  readonly frameDuration?: number;
}

/** A service call that a panel made with `context.callService`. */
export interface ServiceCall {
  readonly service: string;
  readonly request: unknown;
  /** The handler's response, once the call succeeded. */
  readonly response?: unknown;
  /** Why the call failed, if it did. */
  readonly error?: Error;
}

/** A panel that a panel asked to add with `context.layout.addPanel`. */
export interface AddedPanel {
  /** The type it asked for, such as `"my-extension.details"` or a built-in panel's type. */
  readonly type: string;
  /** What `getState` returned. */
  readonly initialState: unknown;
  /** The panel, if the type is one the extension registered and it was opened. */
  readonly panel: SimulatedPanel | undefined;
}

/** A panel open in a {@link SimulatedFoxglove}. */
export interface SimulatedPanel {
  /** The name the panel was registered with. */
  readonly name: string;
  /** The simulated Foxglove the panel is open in. */
  readonly foxglove: SimulatedFoxglove;
  /** The element the panel renders into, `context.panelElement`. */
  readonly element: HTMLDivElement;
  /** The panel's frame in the layout, including its title bar and toolbar. */
  readonly frame: HTMLElement;
  /**
   * The `data-testid` of the panel's frame. Find elements in one panel with
   * `page.getByTestId(panel.testId).getByText(...)`.
   */
  readonly testId: string;
  /** The context passed to the panel's `initPanel` function. */
  readonly context: PanelExtensionContext;
  /** The title in the panel's title bar: the default title the panel set, or its name. */
  readonly title: string;
  /** The value of `context.initialState` the panel was opened with. */
  readonly initialState: unknown;
  /** The most recent value passed to `context.saveState`. */
  readonly savedState: unknown;
  /** Render state fields the panel watches. */
  readonly watchedFields: ReadonlySet<keyof RenderState>;
  /** The panel's current subscriptions. A topic name alone subscribes with `preload: true`. */
  readonly subscriptions: readonly Subscription[];
  /** App settings the panel subscribed to. */
  readonly appSettingsSubscriptions: readonly string[];
  /** Topics the panel currently advertises. */
  readonly advertisements: ReadonlyMap<string, Advertisement>;
  /** The panel's settings, and helpers to edit them as a user would. */
  readonly settings: PanelSettings;
  /** Items the panel put in its toolbar with the experimental `setPanelToolbarItems`. */
  readonly toolbarItems: Immutable<Experimental.PanelToolbarItem[]>;
  /**
   * URLs of toolbar links that were clicked. The simulation records them rather than navigate the
   * test's page away.
   */
  readonly followedLinks: readonly string[];
  /** How many renders the panel finished by calling `done()`. */
  readonly renderCount: number;
  /** A copy of the render state of the panel's latest finished render. */
  readonly lastRenderState: Immutable<RenderState> | undefined;
  /** The error the panel threw while rendering, which Foxglove shows in place of the panel. */
  readonly error: Error | undefined;
  /** False once the panel is unmounted. */
  readonly mounted: boolean;
  /** Show this panel's settings in the settings sidebar, as clicking the panel does. */
  select(): void;
  /** Remove the panel from the layout, running its cleanup function. */
  unmount(): void;
  /**
   * Unmount the panel and open it again with its saved state as its initial state, as Foxglove
   * does when the layout is reloaded.
   */
  reload(): Promise<SimulatedPanel>;
}

/**
 * Foxglove, simulated in the test's browser page, with an extension loaded and a mocked data
 * source open. Created by {@link simulateFoxglove}.
 */
export interface SimulatedFoxglove {
  /** The root element of the simulated app, which contains the layout and settings sidebar. */
  readonly element: HTMLElement;
  /** What the extension registered when it was activated. */
  readonly extension: ExtensionRegistrations;
  /** Panels open in the layout, in the order they were opened. */
  readonly panels: readonly SimulatedPanel[];

  /** Open a panel the extension registered, as a user adding it to the layout. */
  openPanel(name: string, options?: OpenPanelOptions): Promise<SimulatedPanel>;

  /** The current playback time, or the time of the latest live message. */
  readonly currentTime: Time | undefined;
  readonly startTime: Time | undefined;
  readonly endTime: Time | undefined;
  /** True while {@link SimulatedFoxglove.play} is playing in real time. */
  readonly isPlaying: boolean;
  /**
   * Seek a recording to `time`, as if the user clicked the playback bar. Panels get the latest
   * message on each subscribed topic, and `didSeek`. Numbers are seconds since the epoch, like
   * `Time`; use {@link SimulatedFoxglove.seekFromStart} for seconds from the start.
   */
  seek(time: TimeInput): Promise<void>;
  /** Seek to `seconds` after the start of the recording. */
  seekFromStart(seconds: number): Promise<void>;
  /**
   * Play forward to `time`, one frame at a time, waiting for panels to call `done()` after each
   * frame. A recording stops at its end. A live connection only moves its clock.
   */
  advanceTo(time: TimeInput): Promise<void>;
  /** Play forward by `seconds`. */
  advance(seconds: number): Promise<void>;
  /**
   * Play in real time, like the play button, until the end of the recording or until
   * {@link SimulatedFoxglove.pause} is called. Prefer `advance` in tests, which does not depend on
   * how fast the test runs.
   */
  play(options?: { readonly speed?: number }): void;
  /** Stop real-time playback, and wait for the current frame to finish. */
  pause(): Promise<void>;
  /** Hover the playback bar at `time`, which sets `previewTime`. Pass undefined to stop hovering. */
  hover(time: TimeInput | undefined): Promise<void>;

  /** Send messages from a live connection to panels that subscribe to their topics. */
  receive(messages: LiveMessage | readonly LiveMessage[]): Promise<void>;
  /** Replace the topics a live connection advertises. */
  setTopics(topics: readonly TopicDefinition[]): Promise<void>;
  /** Set a parameter on a live connection, as the robot would. */
  setParameter(name: string, value: ParameterValue): Promise<void>;
  /** Parameters on the live connection. */
  readonly parameters: ReadonlyMap<string, ParameterValue>;
  /** Messages panels published, in order. */
  readonly published: readonly PublishedMessage[];
  /** Service calls panels made, in order. */
  readonly serviceCalls: readonly ServiceCall[];
  /**
   * Panels that panels asked to add with `context.layout.addPanel`, in order. Panels the extension
   * registered open in the layout. Others, such as built-in panels, are only recorded here.
   */
  readonly addedPanels: readonly AddedPanel[];
  /** Requests the extension made with `fetch`, in order. */
  readonly requests: readonly RecordedRequest[];

  /** The layout's variables. */
  readonly variables: ReadonlyMap<string, VariableValue>;
  /** Set a layout variable, as a user editing it in the variables sidebar would. */
  setVariable(name: string, value: VariableValue): Promise<void>;
  readonly colorScheme: "light" | "dark";
  /** Switch the app between light and dark. */
  setColorScheme(colorScheme: "light" | "dark"): Promise<void>;
  /** Change an app setting. */
  setAppSetting(key: string, value: AppSettingValue): Promise<void>;

  /**
   * Things Foxglove would report or warn about, such as a converter that threw or a panel that
   * called `done()` twice. A test can assert that this is empty.
   */
  readonly problems: readonly string[];
  /**
   * Wait until panels have finished rendering and stopped calling their context, and until
   * service calls, mocked network responses, `onPublish`, and range loading have finished. Call
   * this after interacting with a panel, before checking what it recorded. While playing in real
   * time, it waits only for the current frame.
   */
  settle(): Promise<void>;
  /** Unmount every panel and remove the simulated app from the page. */
  close(): void;
}

type TopicConvert = ReturnType<RegisterMessageConverterArgsTopic["create"]>;

const simulations = new Set<FoxgloveSimulation>();

const THEMES = {
  light: {
    background: "#ececf0",
    panel: "#ffffff",
    text: "#1d1d24",
    border: "#cfcfd8",
    error: "#c42b1c",
  },
  dark: {
    background: "#101014",
    panel: "#1a1a21",
    text: "#e6e6ec",
    border: "#34343f",
    error: "#ff8a80",
  },
};

function parseConnection(url: string | undefined): SharedRenderInputs["connection"] {
  if (url == undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || parsed.hostname === "") {
      return undefined;
    }
    const port = parsed.port === "" ? (parsed.protocol === "wss:" ? 443 : 80) : Number(parsed.port);
    return { host: parsed.hostname, port };
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class FoxgloveSimulation implements PanelEnvironment {
  public readonly element = document.createElement("div");
  public readonly renderTimeoutMs: number;
  public readonly dataSourceProfile: string | undefined;
  public readonly canSeek: boolean;
  public readonly canPublish: boolean;
  public readonly canCallServices: boolean;
  public readonly inputs: { -readonly [K in keyof SharedRenderInputs]: SharedRenderInputs[K] };
  public readonly problems: string[] = [];
  public readonly published: PublishedMessage[] = [];
  public readonly serviceCalls: ServiceCall[] = [];
  public readonly addedPanels: AddedPanel[] = [];

  readonly #registrations: ExtensionHarness<Experimental.ExtensionContext>;
  readonly #dataSource: DataSource | undefined;
  readonly #recording: Recording | undefined;
  readonly #liveTopics: TopicSchemas = new Map();
  readonly #frameNs: Nanoseconds;
  readonly #layout = document.createElement("main");
  readonly #sidebar = document.createElement("aside");
  readonly #playbackBar = document.createElement("div");
  readonly #playButton = document.createElement("button");
  readonly #slider = document.createElement("input");
  readonly #timeOutput = document.createElement("output");
  readonly #hosts: PanelHost[] = [];
  readonly #panels = new Map<PanelHost, SimulatedPanel>();
  readonly #sharedPanelState = new Map<string, Immutable<Record<string, unknown>> | undefined>();
  readonly #tracked = new Set<Promise<unknown>>();
  readonly #failures: Error[] = [];
  readonly #converterInstances = new Map<string, { convert: TopicConvert; key: string }>();
  readonly #restoreNetwork: () => void;
  readonly #network: NetworkInterceptor;
  #queue: Promise<unknown> = Promise.resolve();
  #queueDepth = 0;
  #activity = 0;
  #seekToken = 0;
  #currentNs: Nanoseconds | undefined;
  #startNs: Nanoseconds | undefined;
  #endNs: Nanoseconds | undefined;
  #hoverSeconds: number | undefined;
  #playing = false;
  #playGeneration = 0;
  #speed = 1;
  readonly #lastMessageByTopic = new Map<string, MessageEvent>();
  #topicProblems = new Set<string>();
  #subscriptionKey = "";
  #aliases = new Map<string, string>();
  #topicConverters = new Map<string, RegisterMessageConverterArgsTopic>();
  #closed = false;
  readonly #focusedPaths = new WeakMap<PanelHost, readonly string[] | undefined>();
  readonly #attachments:
    | readonly { readonly info: Experimental.AttachmentInfo; readonly data: Uint8Array }[]
    | undefined;
  public readonly fetchAttachment: ((id: string) => Promise<Uint8Array>) | undefined;
  readonly #robot: SimulatedRobot = {
    // Delivered in the background, since a panel may be waiting on the handler that calls this
    receive: async (messages) => {
      if (this.#dataSource?.type !== "live") {
        throw new Error("The data source is not live");
      }
      this.#prepareLive(Array.isArray(messages) ? messages : [messages as LiveMessage]);
      this.#background(async () => {
        await this.#receive(messages);
      });
      await Promise.resolve();
    },
    setTopics: (topics) => {
      this.#setTopics(topics);
    },
    setParameter: (name, value) => {
      this.#setRobotParameter(name, value);
    },
  };

  public constructor(
    registrations: ExtensionHarness<Experimental.ExtensionContext>,
    options: SimulateFoxgloveOptions,
    network: { interceptor: NetworkInterceptor; restore: () => void },
  ) {
    this.#registrations = registrations;
    this.#network = network.interceptor;
    this.#network.track = (promise) => {
      this.track(promise);
    };
    this.#network.blocked = (message) => {
      this.reportProblem(message);
    };
    this.#restoreNetwork = network.restore;
    this.#dataSource = options.dataSource;
    this.renderTimeoutMs = options.renderTimeoutMs ?? 2000;
    this.#frameNs = secondsToNanoseconds(options.frameDuration ?? 1 / 60);
    if (this.#frameNs <= 0n) {
      throw new Error("frameDuration must be positive");
    }
    const live: LiveDataSource | undefined =
      this.#dataSource?.type === "live" ? this.#dataSource : undefined;
    const recordingSource = this.#dataSource?.type === "recording" ? this.#dataSource : undefined;
    this.#attachments = recordingSource?.attachments?.map((attachment, index) => ({
      info: {
        id: String(index),
        name: attachment.name,
        mediaType: attachment.mediaType,
        logTime: fromNanoseconds(toNanoseconds(attachment.logTime)),
        createTime: fromNanoseconds(toNanoseconds(attachment.createTime ?? attachment.logTime)),
        sizeBytes: attachment.data.byteLength,
      },
      data: attachment.data,
    }));
    this.fetchAttachment =
      this.#attachments == undefined
        ? undefined
        : async (id: string) => {
            const attachment = this.#attachments?.find(({ info }) => info.id === id);
            if (attachment == undefined) {
              throw new Error(`There is no attachment with id "${id}"`);
            }
            await Promise.resolve();
            return attachment.data.slice();
          };
    this.dataSourceProfile = this.#dataSource?.profile;
    this.canSeek = this.#dataSource?.type === "recording";
    this.canPublish = live != undefined && live.capabilities?.publish !== false;
    this.canCallServices = live != undefined && live.capabilities?.services !== false;

    if (this.#dataSource?.type === "recording") {
      this.#recording = new Recording(this.#dataSource);
      this.#startNs = this.#recording.startNs;
      this.#endNs = this.#recording.endNs;
      this.#currentNs = this.#startNs;
    } else if (live != undefined) {
      addTopics(this.#liveTopics, live.topics ?? []);
      this.#startNs = live.startTime == undefined ? 0n : toNanoseconds(live.startTime);
      this.#currentNs = this.#startNs;
      this.#endNs = this.#startNs;
    }

    this.inputs = {
      topics: [],
      topicSchemas: new Map(),
      variables:
        // Like a layout without variables, which panels see no variables for until one is set
        options.variables == undefined ? EMPTY_VARIABLES : { ...options.variables },
      frame: undefined,
      seekToken: this.#dataSource == undefined ? undefined : this.#seekToken,
      currentTime: undefined,
      startTime: undefined,
      endTime: undefined,
      previewTime: undefined,
      colorScheme: options.colorScheme ?? "light",
      appSettings: new Map(Object.entries(options.appSettings ?? {})),
      parameters: new Map(live?.parameters == undefined ? [] : Object.entries(live.parameters)),
      connection: parseConnection(live?.url),
      metadata: recordingSource?.metadata?.map((record) => ({
        name: record.name,
        metadata: { ...record.metadata },
      })),
      attachments: this.#attachments?.map(({ info }) => info),
    };
    this.#updateTimes();
    this.#updateTopics();

    this.#buildPage();
    simulations.add(this);
  }

  // PanelEnvironment

  public get schemaConverters(): ExtensionRegistrations["schemaConverters"] {
    return this.#registrations.schemaConverters;
  }

  public sharedPanelState(type: string): Immutable<Record<string, unknown>> | undefined {
    return this.#sharedPanelState.get(type);
  }

  public noteActivity(): void {
    this.#activity += 1;
  }

  public track(promise: Promise<unknown>): void {
    this.#tracked.add(promise);
    void promise.finally(() => {
      this.#tracked.delete(promise);
      this.noteActivity();
    });
  }

  public reportProblem(message: string, error?: unknown): void {
    const text = error == undefined ? message : `${message}: ${errorMessage(error)}`;
    this.problems.push(text);
    console.warn(`[simulated Foxglove] ${text}`, ...(error == undefined ? [] : [error]));
  }

  public selectPanel(panel: PanelHost): void {
    this.#sidebar.replaceChildren(panel.settingsEditor.element);
  }

  public panelUnmounted(panel: PanelHost): void {
    if (panel.settingsEditor.element.parentElement === this.#sidebar) {
      const next = this.#hosts.filter((host) => host.mounted).pop();
      this.#sidebar.replaceChildren(...(next == undefined ? [] : [next.settingsEditor.element]));
    }
    this.subscriptionsChanged();
  }

  public subscriptionsChanged(panel?: PanelHost, previousTopics?: ReadonlySet<string>): void {
    if (this.#closed) {
      return;
    }
    this.noteActivity();
    const topics = this.#subscribedTopics();
    // Includes where each topic's data comes from, so that an alias that now points at another
    // topic counts as a change
    const key = [...topics]
      .sort()
      .map((topic) => `${topic} ${this.#resolution(topic)}`)
      .join("\n");
    const unchanged = key === this.#subscriptionKey;
    // Like Foxglove's message pipeline, a panel that joins a topic other panels already subscribe
    // to gets the latest message on it. A recording backfills every topic when the set changes.
    if (panel != undefined && (unchanged || this.#recording == undefined)) {
      panel.deliver(
        panel.subscriptions
          .filter(({ topic }) => previousTopics?.has(topic) !== true)
          .map(({ topic }) => this.#lastMessageByTopic.get(topic))
          .filter((event): event is MessageEvent => event != undefined),
      );
    }
    if (unchanged) {
      return;
    }
    this.#subscriptionKey = key;
    for (const output of [...this.#converterInstances.keys()]) {
      if (!topics.has(output)) {
        this.#converterInstances.delete(output);
      }
    }
    // Like Foxglove's player, a change of subscriptions backfills the latest message on each
    // subscribed topic, which panels see as a seek
    if (this.#recording != undefined && this.#hosts.some((host) => host.mounted)) {
      this.#background(async () => {
        await this.#enqueue(async () => {
          await this.#emit(this.#backfillAt(this.#currentNs!), { seek: true });
        });
      });
    }
  }

  public setVariable(name: string, value: VariableValue): void {
    this.inputs.variables = { ...this.inputs.variables, [name]: value };
    this.#updateTopics();
    this.#dispatchAll();
  }

  public setSharedPanelState(
    type: string,
    state: Parameters<Experimental.PanelExtensionContext["setSharedPanelState"]>[0],
  ): void {
    const previous = this.#sharedPanelState.get(type);
    this.#sharedPanelState.set(type, typeof state === "function" ? state(previous) : state);
    this.#dispatchAll();
  }

  public setPreviewTime(seconds: number | undefined): void {
    if (seconds == undefined) {
      this.#hoverSeconds = undefined;
    } else if (this.#startNs != undefined) {
      // Foxglove stores the preview time relative to the start, and ignores it without a start
      this.#hoverSeconds = seconds - nanosecondsToSeconds(this.#startNs);
    }
    this.#updateTimes();
    this.#dispatchAll();
  }

  public seek(time: number | Time): void {
    this.#background(async () => {
      await this.#seek(time);
    });
  }

  public publish(topic: string, message: unknown): void {
    const published = { topic, message };
    this.published.push(published);
    const live = this.#dataSource?.type === "live" ? this.#dataSource : undefined;
    if (live?.onPublish == undefined) {
      return;
    }
    const onPublish = live.onPublish;
    this.track(
      Promise.resolve()
        .then(async () => {
          await onPublish(published, this.#robot);
        })
        .catch((caught: unknown) => {
          this.reportProblem(`onPublish failed for a message on "${topic}"`, caught);
        }),
    );
  }

  public async callService(service: string, request: unknown): Promise<unknown> {
    const live = this.#dataSource?.type === "live" ? this.#dataSource : undefined;
    const services = live?.services;
    const handler =
      services != undefined && Object.hasOwn(services, service) ? services[service] : undefined;
    const call: { -readonly [K in keyof ServiceCall]: ServiceCall[K] } = { service, request };
    this.serviceCalls.push(call);
    const result = (async () => {
      try {
        if (handler == undefined) {
          throw new Error(
            `Service "${service}" is not available. Add a handler for it to the services of the live data source.`,
          );
        }
        call.response = await Promise.resolve(handler(request, this.#robot));
        return call.response;
      } catch (caught) {
        call.error = caught instanceof Error ? caught : new Error(String(caught));
        throw call.error;
      }
    })();
    // settle() waits for the response, so a test can check what the panel did with it
    this.track(result.catch(() => undefined));
    return await result;
  }

  public setParameter(name: string, value: ParameterValue): void {
    const live = this.#dataSource?.type === "live" ? this.#dataSource : undefined;
    if (live == undefined || live.capabilities?.parameters === false) {
      this.reportProblem(
        `A panel set the parameter "${name}", but the data source has no parameters`,
      );
      return;
    }
    this.#setParameterValue(name, value);
  }

  /** Change a parameter from the robot's side */
  #setRobotParameter(name: string, value: ParameterValue): void {
    if (this.#dataSource?.type !== "live") {
      throw new Error("setParameter() is for live data sources. Recordings have no parameters.");
    }
    this.#setParameterValue(name, value);
  }

  #setParameterValue(name: string, value: ParameterValue): void {
    const parameters = new Map(this.inputs.parameters);
    parameters.set(name, value);
    this.inputs.parameters = parameters;
    this.#dispatchAll();
  }

  public addPanel(params: Parameters<LayoutActions["addPanel"]>[0]): void {
    const registration = this.#findPanel(params.type);
    const request: { -readonly [K in keyof AddedPanel]: AddedPanel[K] } = {
      type: params.type,
      initialState: params.getState(undefined),
      panel: undefined,
    };
    this.addedPanels.push(request);
    // Panels of other types, such as Foxglove's built-in panels, are recorded but not opened
    if (registration != undefined) {
      this.#background(async () => {
        request.panel = this.#open(registration.name, { initialState: request.initialState });
        await Promise.resolve();
      });
    }
  }

  public panelChanged(panel: PanelHost): void {
    panel.refreshChrome();
    // Foxglove opens the settings sidebar when a panel asks to focus a new path
    const focusedPath = panel.settingsTree?.focusedPath;
    if (focusedPath != undefined && focusedPath !== this.#focusedPaths.get(panel)) {
      this.selectPanel(panel);
    }
    this.#focusedPaths.set(panel, focusedPath);
  }

  public messagesOnTopic(topic: string): readonly MessageEvent[] | undefined {
    const recording = this.#recording;
    if (recording == undefined) {
      return undefined;
    }
    const converter = this.#topicConverters.get(topic);
    if (converter != undefined) {
      const sources = new Set(converter.inputTopics.map((input) => this.#sourceOf(input)));
      const inputs = [...sources].flatMap((source) => recording.messagesOnTopic(source));
      inputs.sort(compareStored);
      // Range loading reads the whole recording, so it gets a converter of its own
      const convert = this.#createConverter(converter);
      return convert == undefined
        ? []
        : inputs.flatMap(({ event }) =>
            this.#runTopicConverter(
              converter,
              convert,
              event,
              this.#inputTopicsFor(converter, event),
            ),
          );
    }
    const source = this.#aliases.get(topic) ?? topic;
    return recording
      .messagesOnTopic(source)
      .map(({ event }) => (source === topic ? event : { ...event, topic }));
  }

  // Public API

  public get extension(): ExtensionRegistrations {
    return this.#registrations;
  }

  public get panels(): readonly SimulatedPanel[] {
    return this.#hosts.filter((host) => host.mounted).map((host) => this.#panels.get(host)!);
  }

  public get currentTime(): Time | undefined {
    return this.inputs.currentTime;
  }

  public get startTime(): Time | undefined {
    return this.inputs.startTime;
  }

  public get endTime(): Time | undefined {
    return this.inputs.endTime;
  }

  public get isPlaying(): boolean {
    return this.#playing;
  }

  public get parameters(): ReadonlyMap<string, ParameterValue> {
    return this.inputs.parameters;
  }

  public get requests(): readonly RecordedRequest[] {
    return this.#network.requests;
  }

  public get variables(): ReadonlyMap<string, VariableValue> {
    return new Map(Object.entries(this.inputs.variables));
  }

  public get colorScheme(): "light" | "dark" {
    return this.inputs.colorScheme;
  }

  public async openPanel(name: string, options: OpenPanelOptions = {}): Promise<SimulatedPanel> {
    const panel = this.#open(name, options);
    await this.settle();
    return panel;
  }

  /** Mount a panel without waiting for it, so background operations can open panels */
  #open(name: string, options: OpenPanelOptions): SimulatedPanel {
    const registration = this.#findPanel(name);
    if (registration == undefined) {
      const names = [...this.#registrations.panels.keys()].map((key) => `"${key}"`).join(", ");
      throw new Error(
        `The extension did not register a panel named "${name}". Registered panels: ${names === "" ? "none" : names}`,
      );
    }
    const host = new PanelHost(this, registration, options.initialState ?? {}, options);
    this.#hosts.push(host);
    this.#layout.append(host.frame);
    this.selectPanel(host);
    const panel = this.#wrapPanel(host);
    this.#panels.set(host, panel);
    try {
      host.init();
    } catch (caught) {
      try {
        host.unmount();
      } catch {
        // The panel failed to initialize, so its cleanup is not expected to work
      }
      throw new Error(`initPanel of panel "${name}" threw: ${errorMessage(caught)}`, {
        cause: caught,
      });
    }
    return panel;
  }

  public async seekTo(time: TimeInput): Promise<void> {
    await this.#seek(time);
    await this.settle();
  }

  public async seekFromStart(seconds: number): Promise<void> {
    if (this.#startNs == undefined) {
      throw new Error("There is no recording to seek in");
    }
    // Seeking before the start goes to the start, like seek()
    const target = this.#startNs + secondsToNanoseconds(Math.max(seconds, 0));
    await this.seekTo(fromNanoseconds(target));
  }

  /** Seek without waiting for panels to settle, so background operations can seek */
  async #seek(time: TimeInput): Promise<void> {
    if (this.#recording == undefined) {
      throw new Error("Only recordings can seek. Live connections and no data source cannot.");
    }
    await this.#enqueue(async () => {
      const target = this.#clamp(toNanoseconds(time));
      this.#currentNs = target;
      await this.#emit(this.#backfillAt(target), { seek: true });
    });
  }

  public async advanceTo(time: TimeInput): Promise<void> {
    if (this.#currentNs == undefined) {
      throw new Error("There is no data source to play");
    }
    const target =
      this.#recording == undefined ? toNanoseconds(time) : this.#clamp(toNanoseconds(time));
    if (target < this.#currentNs) {
      throw new Error(
        `advanceTo(${formatTime(target)}) is before the current time ${formatTime(this.#currentNs)}. Use seek() to go back.`,
      );
    }
    // A live connection has no recorded messages to play, so its clock moves in one step
    const step = this.#recording == undefined ? target - this.#currentNs : this.#frameNs;
    while (this.#currentNs < target) {
      await this.#enqueue(async () => {
        const next = this.#currentNs! + step < target ? this.#currentNs! + step : target;
        await this.#tick(next);
      });
    }
    await this.settle();
  }

  public async advance(seconds: number): Promise<void> {
    if (this.#currentNs == undefined) {
      throw new Error("There is no data source to play");
    }
    if (!(seconds >= 0)) {
      throw new Error(
        `advance(${seconds}) needs a number of seconds that is 0 or more. Use seek() to go back.`,
      );
    }
    await this.advanceTo(fromNanoseconds(this.#currentNs + secondsToNanoseconds(seconds)));
  }

  public play(options: { readonly speed?: number } = {}): void {
    const speed = options.speed ?? 1;
    if (!(speed > 0) || !Number.isFinite(speed)) {
      throw new Error(`play() needs a speed greater than 0, not ${speed}`);
    }
    if (this.#currentNs == undefined || this.#playing) {
      return;
    }
    this.#playing = true;
    this.#speed = speed;
    this.#playGeneration += 1;
    const generation = this.#playGeneration;
    this.#updatePlaybackBar();
    // Not tracked like other background work, so that settle() can return while playing
    void this.#playLoop(generation)
      .catch((caught: unknown) => {
        this.#fail(caught);
      })
      .finally(() => {
        if (generation === this.#playGeneration) {
          this.#playing = false;
        }
        this.#updatePlaybackBar();
      });
  }

  async #playLoop(generation: number): Promise<void> {
    const active = () => this.#playing && !this.#closed && generation === this.#playGeneration;
    let last = now();
    while (active()) {
      await delay(16);
      const elapsed = now() - last;
      last = now();
      await this.#enqueue(async () => {
        if (!active()) {
          return;
        }
        const next = this.#currentNs! + secondsToNanoseconds((elapsed / 1000) * this.#speed);
        await this.#tick(this.#recording == undefined ? next : this.#clamp(next));
        if (this.#recording != undefined && this.#currentNs! >= this.#endNs!) {
          this.#playing = false;
        }
      });
    }
  }

  public async pause(): Promise<void> {
    this.#stopPlaying();
    await this.settle();
  }

  #stopPlaying(): void {
    this.#playing = false;
    this.#playGeneration += 1;
    this.#updatePlaybackBar();
  }

  public async hover(time: TimeInput | undefined): Promise<void> {
    this.setPreviewTime(time == undefined ? undefined : nanosecondsToSeconds(toNanoseconds(time)));
    await this.settle();
  }

  public async receive(messages: LiveMessage | readonly LiveMessage[]): Promise<void> {
    await this.#receive(messages);
    await this.settle();
  }

  /** Deliver live messages without waiting for panels to settle */
  async #receive(messages: LiveMessage | readonly LiveMessage[]): Promise<void> {
    if (this.#dataSource?.type !== "live") {
      throw new Error(
        "receive() is for live data sources. Recordings play their messages with advanceTo(), play(), and seek().",
      );
    }
    const list: readonly LiveMessage[] = Array.isArray(messages)
      ? (messages as readonly LiveMessage[])
      : [messages as LiveMessage];
    // The operation checks every message before it changes anything, so a bad message leaves
    // the topics as they were
    await this.#enqueue(async () => {
      const topics = new Map(this.#liveTopics);
      const stored = this.#prepareLive(list, topics);
      if (topics.size !== this.#liveTopics.size) {
        addTopics(
          this.#liveTopics,
          [...topics].map(([name, schemaName]) => ({ name, schemaName })),
        );
        this.#updateTopics();
      }
      const latest = stored[stored.length - 1]?.ns;
      if (latest != undefined && latest > this.#currentNs!) {
        this.#currentNs = latest;
        this.#endNs = latest;
      }
      const subscribed = this.#subscribedSources();
      await this.#emit(stored.filter((message) => subscribed.has(message.event.topic)));
    });
  }

  /** Turn live messages into stored messages, adding new topics to `topics` */
  #prepareLive(
    list: readonly LiveMessage[],
    topics: TopicSchemas = new Map(this.#liveTopics),
  ): StoredMessage[] {
    return list
      .map((message) =>
        toStoredMessage(
          { ...message, receiveTime: message.receiveTime ?? fromNanoseconds(this.#currentNs!) },
          topics,
        ),
      )
      .sort(compareStored);
  }

  public async setTopics(topics: readonly TopicDefinition[]): Promise<void> {
    this.#setTopics(topics);
    await this.settle();
  }

  #setTopics(topics: readonly TopicDefinition[]): void {
    if (this.#dataSource?.type !== "live") {
      throw new Error("setTopics() is for live data sources. A recording's topics are fixed.");
    }
    this.#liveTopics.clear();
    addTopics(this.#liveTopics, topics);
    this.#updateTopics();
    this.#dispatchAll();
  }

  public async setLiveParameter(name: string, value: ParameterValue): Promise<void> {
    this.#setRobotParameter(name, value);
    await this.settle();
  }

  public async setLayoutVariable(name: string, value: VariableValue): Promise<void> {
    this.setVariable(name, value);
    await this.settle();
  }

  public async setColorScheme(colorScheme: "light" | "dark"): Promise<void> {
    this.inputs.colorScheme = colorScheme;
    this.#applyTheme();
    this.#dispatchAll();
    await this.settle();
  }

  public async setAppSetting(key: string, value: AppSettingValue): Promise<void> {
    const appSettings = new Map(this.inputs.appSettings);
    appSettings.set(key, value);
    this.inputs.appSettings = appSettings;
    this.#dispatchAll();
    await this.settle();
  }

  public async settle(): Promise<void> {
    // Settling takes a few checks 16ms apart, even when nothing is running
    const timeoutMs = Math.max(this.renderTimeoutMs, 100);
    const deadline = now() + timeoutMs;
    // While playing, frames keep arriving, so wait only for a moment between frames when every
    // panel has finished rendering
    const needed = this.#playing ? 1 : 2;
    let quietChecks = 0;
    let seenActivity = this.#activity;
    while (quietChecks < needed) {
      this.#throwFailure();
      await delay(16);
      const busy =
        this.#queueDepth > 0 ||
        this.#tracked.size > 0 ||
        this.#hosts.some((host) => host.mounted && !host.idle);
      if (busy || (!this.#playing && this.#activity !== seenActivity)) {
        quietChecks = 0;
        seenActivity = this.#activity;
      } else {
        quietChecks += 1;
      }
      if (now() > deadline && quietChecks < needed) {
        this.#throwFailure();
        throw new Error(
          `The simulated Foxglove did not settle within ${timeoutMs}ms. ${this.#describeBusy()}`,
        );
      }
    }
    this.#throwFailure();
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#playing = false;
    const errors: unknown[] = [];
    for (const host of this.#hosts) {
      try {
        host.unmount();
      } catch (caught) {
        errors.push(caught);
      }
    }
    this.element.remove();
    this.#restoreNetwork();
    simulations.delete(this);
    if (errors.length > 0) {
      throw new AggregateError(errors, "A panel's cleanup function threw while closing");
    }
  }

  // Internals

  #findPanel(name: string): ExtensionPanelRegistration | undefined {
    const panels = this.#registrations.panels;
    // Layouts refer to extension panels as "extensionName.panelName", and panel names can contain
    // dots, so prefer the longest registered name that the type ends with
    const exact = panels.get(name);
    if (exact != undefined) {
      return exact;
    }
    const matches = [...panels.keys()].filter((key) => name.endsWith(`.${key}`));
    const longest = matches.sort((a, b) => b.length - a.length)[0];
    return longest == undefined ? undefined : panels.get(longest);
  }

  #wrapPanel(host: PanelHost): SimulatedPanel {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const simulation = this;
    return {
      name: host.registration.name,
      get foxglove() {
        return simulation.handle;
      },
      element: host.panelElement,
      frame: host.frame,
      testId: host.testId,
      context: host.context,
      get title() {
        return host.title;
      },
      initialState: host.initialState,
      get savedState() {
        return host.savedState;
      },
      watchedFields: host.watchedFields,
      get subscriptions() {
        return host.subscriptions;
      },
      get appSettingsSubscriptions() {
        return host.appSettingsSubscriptions;
      },
      advertisements: host.advertisements,
      get settings() {
        return host.settings;
      },
      get toolbarItems() {
        return host.toolbarItems;
      },
      followedLinks: host.followedLinks,
      get renderCount() {
        return host.renderCount;
      },
      get lastRenderState() {
        return host.lastRenderState;
      },
      get error() {
        return host.error;
      },
      get mounted() {
        return host.mounted;
      },
      select: () => {
        this.selectPanel(host);
      },
      unmount: () => {
        host.unmount();
      },
      reload: async () => {
        const state = host.savedState ?? host.initialState;
        host.unmount();
        return await this.openPanel(host.registration.name, {
          ...host.options,
          initialState: state,
        });
      },
    };
  }

  /** The public face of this simulation */
  public get handle(): SimulatedFoxglove {
    return publicHandles.get(this)!;
  }

  #fail(caught: unknown): void {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    this.#failures.push(error);
    this.reportProblem("A background operation failed", error);
  }

  #background(task: () => Promise<void>): void {
    this.track(
      task().catch((caught: unknown) => {
        this.#fail(caught);
      }),
    );
  }

  #throwFailure(): void {
    const failure = this.#failures.shift();
    if (failure != undefined) {
      throw failure;
    }
  }

  /** Runs player operations one at a time, in the order they were requested */
  async #enqueue(operation: () => Promise<void>): Promise<void> {
    this.#queueDepth += 1;
    const result = this.#queue.then(async () => {
      if (this.#closed) {
        throw new Error("The simulated Foxglove was closed");
      }
      await operation();
    });
    this.#queue = result.catch(() => undefined);
    try {
      await result;
    } finally {
      this.#queueDepth -= 1;
      this.noteActivity();
    }
  }

  #clamp(ns: Nanoseconds): Nanoseconds {
    if (this.#startNs != undefined && ns < this.#startNs) {
      return this.#startNs;
    }
    if (this.#endNs != undefined && this.#recording != undefined && ns > this.#endNs) {
      return this.#endNs;
    }
    return ns;
  }

  /** Data source topics that panels need, through their subscriptions, aliases, and converters */
  #subscribedSources(): Set<string> {
    const sources = new Set<string>();
    for (const host of this.#hosts) {
      for (const { topic } of host.subscriptions) {
        const converter = this.#topicConverters.get(topic);
        for (const input of converter?.inputTopics ?? [topic]) {
          sources.add(this.#aliases.get(input) ?? input);
        }
      }
    }
    return sources;
  }

  #subscribedTopics(): Set<string> {
    return new Set(this.#hosts.flatMap((host) => host.subscriptions.map(({ topic }) => topic)));
  }

  /** The latest message at or before `ns` on each subscribed topic, in time order */
  #backfillAt(ns: Nanoseconds): StoredMessage[] {
    const recording = this.#recording!;
    return [...this.#subscribedSources()]
      .map((topic) => recording.lastMessageAtOrBefore(topic, ns))
      .filter((message): message is StoredMessage => message != undefined)
      .sort(compareStored);
  }

  /** Play from the current time to `next`, delivering the messages in between */
  async #tick(next: Nanoseconds): Promise<void> {
    const messages =
      this.#recording == undefined
        ? []
        : this.#recording.messagesBetween(this.#currentNs!, next, this.#subscribedSources());
    this.#currentNs = next;
    if (this.#recording == undefined && next > this.#endNs!) {
      this.#endNs = next;
    }
    await this.#emit(messages);
  }

  /** Deliver one frame of messages to every panel, and wait for them to render it */
  async #emit(messages: readonly StoredMessage[], options: { seek?: boolean } = {}): Promise<void> {
    if (options.seek === true) {
      this.#seekToken += 1;
      this.inputs.seekToken = this.#seekToken;
      // Foxglove creates topic converters again after a seek, which drops their state
      this.#converterInstances.clear();
      this.#lastMessageByTopic.clear();
    }
    const frame: PlayerFrame = { events: this.#virtualize(messages) };
    for (const event of frame.events) {
      this.#lastMessageByTopic.set(event.topic, event);
    }
    this.inputs.frame = frame;
    this.#updateTimes();
    this.#updatePlaybackBar();
    const hosts = this.#hosts.filter((host) => host.mounted);
    for (const host of hosts) {
      host.scheduleDispatch();
    }
    await Promise.all(
      hosts.map(async (host) => {
        await host.whenIdle();
      }),
    );
  }

  /** Turn data source messages into events on the topics panels subscribed to */
  #virtualize(messages: readonly StoredMessage[]): MessageEvent[] {
    const subscribed = this.#subscribedTopics();
    const events: MessageEvent[] = [];
    for (const { event } of messages) {
      if (subscribed.has(event.topic)) {
        events.push(event);
      }
      for (const [alias, source] of this.#aliases) {
        if (source === event.topic && subscribed.has(alias)) {
          events.push({ ...event, topic: alias });
        }
      }
      for (const [output, converter] of this.#topicConverters) {
        if (!subscribed.has(output)) {
          continue;
        }
        const inputTopics = this.#inputTopicsFor(converter, event);
        const convert = inputTopics.length === 0 ? undefined : this.#converterFor(converter);
        if (convert != undefined) {
          events.push(...this.#runTopicConverter(converter, convert, event, inputTopics));
        }
      }
    }
    return events;
  }

  /** The converter function for a subscribed output topic, created again when its variables change */
  #converterFor(converter: RegisterMessageConverterArgsTopic): TopicConvert | undefined {
    const variables = this.inputs.variables;
    const key = JSON.stringify((converter.watchVariables ?? []).map((name) => variables[name]));
    const existing = this.#converterInstances.get(converter.outputTopic);
    if (existing?.key === key) {
      return existing.convert;
    }
    const convert = this.#createConverter(converter);
    if (convert != undefined) {
      this.#converterInstances.set(converter.outputTopic, { convert, key });
    }
    return convert;
  }

  #createConverter(converter: RegisterMessageConverterArgsTopic): TopicConvert | undefined {
    try {
      return converter.create(this.inputs.variables);
    } catch (caught) {
      this.reportProblem(
        `create() of the topic converter for "${converter.outputTopic}" threw`,
        caught,
      );
      return undefined;
    }
  }

  /** The input topics of `converter` that `event` arrives on, through aliases */
  #inputTopicsFor(converter: RegisterMessageConverterArgsTopic, event: MessageEvent): string[] {
    return converter.inputTopics.filter((input) => this.#sourceOf(input) === event.topic);
  }

  #sourceOf(topic: string): string {
    return this.#aliases.get(topic) ?? topic;
  }

  /** Where a topic's messages come from: itself, an alias's source, or a converter's inputs */
  #resolution(topic: string): string {
    const converter = this.#topicConverters.get(topic);
    if (converter != undefined) {
      return converter.inputTopics.map((input) => this.#sourceOf(input)).join(",");
    }
    return this.#sourceOf(topic);
  }

  #runTopicConverter(
    converter: RegisterMessageConverterArgsTopic,
    convert: TopicConvert,
    event: MessageEvent,
    inputTopics: readonly string[],
  ): MessageEvent[] {
    const schemaName = outputSchemaName(converter);
    const events: MessageEvent[] = [];
    for (const inputTopic of inputTopics) {
      let output: ReturnType<typeof convert>;
      try {
        output = convert(inputTopic === event.topic ? event : { ...event, topic: inputTopic });
      } catch (caught) {
        this.reportProblem(
          `The topic converter for "${converter.outputTopic}" threw on a message on "${inputTopic}"`,
          caught,
        );
        continue;
      }
      const messages: readonly unknown[] =
        output == undefined ? [] : Array.isArray(output) ? output : [output];
      for (const message of messages) {
        if (message == undefined) {
          continue;
        }
        events.push({
          topic: converter.outputTopic,
          schemaName,
          receiveTime: event.receiveTime,
          message,
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          sizeInBytes: estimateSize(message),
        });
      }
    }
    return events;
  }

  /** Recompute topics, with aliases and converter outputs, after topics or variables change */
  #updateTopics(): void {
    const sources: TopicSchemas = this.#recording?.topics ?? this.#liveTopics;
    const schemas = new Map(sources);
    // Reported once, since topics are computed again whenever topics or variables change
    const problems: string[] = [];

    const aliases = new Map<string, string>();
    const baseTopics = [...sources].map(([name, schemaName]) => ({ name, schemaName }));
    for (const aliasFunction of this.#registrations.topicAliasFunctions) {
      let results: unknown;
      try {
        results = aliasFunction({ topics: baseTopics, globalVariables: this.inputs.variables });
      } catch (caught) {
        problems.push(`A topic alias function threw: ${errorMessage(caught)}`);
        continue;
      }
      const isAlias = (item: unknown): item is { name: string; sourceTopicName: string } =>
        typeof item === "object" &&
        item != undefined &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { sourceTopicName?: unknown }).sourceTopicName === "string";
      if (!Array.isArray(results) || !results.every(isAlias)) {
        problems.push(
          "A topic alias function returned something other than a list of { name, sourceTopicName }",
        );
        continue;
      }
      for (const alias of results) {
        const schemaName = sources.get(alias.sourceTopicName);
        if (schemas.has(alias.name)) {
          problems.push(
            `The topic alias "${alias.name}" is ignored because a topic with that name already exists`,
          );
        } else if (schemaName == undefined) {
          problems.push(
            `The topic alias "${alias.name}" is ignored because its source topic "${alias.sourceTopicName}" does not exist`,
          );
        } else {
          aliases.set(alias.name, alias.sourceTopicName);
          schemas.set(alias.name, schemaName);
        }
      }
    }

    const topicConverters = new Map<string, RegisterMessageConverterArgsTopic>();
    const inputsExist = (converter: RegisterMessageConverterArgsTopic) =>
      converter.inputTopics.some((input) => schemas.has(input));
    for (const converter of this.#registrations.topicConverters) {
      // Like Foxglove, a converter's output is listed only once one of its inputs exists
      if (!inputsExist(converter)) {
        continue;
      }
      if (schemas.has(converter.outputTopic)) {
        problems.push(
          `The topic converter output "${converter.outputTopic}" is ignored because a topic with that name already exists`,
        );
        continue;
      }
      topicConverters.set(converter.outputTopic, converter);
      schemas.set(converter.outputTopic, outputSchemaName(converter));
    }

    const convertibleTo = new Map<string, string[]>();
    for (const converter of this.#registrations.schemaConverters) {
      const list = convertibleTo.get(converter.fromSchemaName) ?? [];
      if (!list.includes(converter.toSchemaName)) {
        list.push(converter.toSchemaName);
      }
      convertibleTo.set(converter.fromSchemaName, list);
    }

    const topics: Topic[] = [...schemas]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, schemaName]) => {
        const targets = convertibleTo.get(schemaName);
        return {
          name,
          schemaName,
          datatype: schemaName,
          ...(targets == undefined ? {} : { convertibleTo: targets }),
        };
      });

    const unchanged =
      JSON.stringify(topics) === JSON.stringify(this.inputs.topics) &&
      JSON.stringify([...aliases]) === JSON.stringify([...this.#aliases]);
    const changed = new Set<string>();
    for (const name of new Set([...aliases.keys(), ...this.#aliases.keys()])) {
      if (aliases.get(name) !== this.#aliases.get(name)) {
        changed.add(name);
      }
    }
    for (const name of new Set([...topicConverters.keys(), ...this.#topicConverters.keys()])) {
      if (topicConverters.get(name) !== this.#topicConverters.get(name)) {
        changed.add(name);
      }
    }
    this.#aliases = aliases;
    this.#topicConverters = topicConverters;
    if (!unchanged) {
      this.inputs.topics = topics;
      this.inputs.topicSchemas = schemas;
    }
    for (const problem of problems) {
      if (!this.#topicProblems.has(problem)) {
        this.reportProblem(problem);
      }
    }
    this.#topicProblems = new Set(problems);
    if (changed.size > 0) {
      // Like Foxglove, panels loading ranges on those topics start again, and a recording
      // backfills their new source
      for (const host of this.#hosts) {
        host.restartRanges(changed);
      }
      this.subscriptionsChanged();
    }
  }

  #updateTimes(): void {
    const update = (
      field: "currentTime" | "startTime" | "endTime",
      ns: Nanoseconds | undefined,
    ) => {
      const current = this.inputs[field];
      const same =
        current != undefined && ns != undefined
          ? toNanoseconds(current) === ns
          : current == undefined && ns == undefined;
      if (!same) {
        this.inputs[field] = ns == undefined ? undefined : fromNanoseconds(ns);
      }
    };
    update("currentTime", this.#currentNs);
    update("startTime", this.#startNs);
    update("endTime", this.#endNs);
    this.inputs.previewTime =
      this.#hoverSeconds == undefined || this.#startNs == undefined
        ? undefined
        : nanosecondsToSeconds(this.#startNs) + this.#hoverSeconds;
  }

  #dispatchAll(): void {
    this.noteActivity();
    for (const host of this.#hosts) {
      host.scheduleDispatch();
    }
  }

  #describeBusy(): string {
    const reasons: string[] = [];
    for (const host of this.#hosts) {
      if (host.mounted && !host.idle) {
        reasons.push(
          `Panel "${host.title}" did not call done() for its latest render. Foxglove waits for done() before it renders the panel again.`,
        );
      }
    }
    if (this.#queueDepth > 0) {
      reasons.push("Playback is still delivering a frame.");
    }
    if (this.#tracked.size > 0) {
      reasons.push(`${this.#tracked.size} operation(s), such as range loading, are still running.`);
    }
    if (reasons.length === 0) {
      reasons.push(
        "A panel kept calling its context, for example by setting state on every render.",
      );
    }
    return reasons.join(" ");
  }

  #buildPage(): void {
    const root = this.element;
    root.dataset.foxgloveSimulator = "";
    root.style.display = "grid";
    root.style.gap = "8px";
    root.style.padding = "8px";
    root.style.fontFamily = "system-ui, sans-serif";
    root.style.fontSize = "13px";

    this.#layout.setAttribute("aria-label", "Layout");
    this.#layout.style.display = "flex";
    this.#layout.style.flexWrap = "wrap";
    this.#layout.style.gap = "8px";

    this.#playbackBar.setAttribute("role", "toolbar");
    this.#playbackBar.setAttribute("aria-label", "Playback");
    this.#playbackBar.style.display = "flex";
    this.#playbackBar.style.alignItems = "center";
    this.#playbackBar.style.gap = "8px";
    this.#playButton.type = "button";
    this.#playButton.addEventListener("click", () => {
      if (this.#playing) {
        this.#stopPlaying();
      } else {
        this.play();
      }
    });
    this.#slider.type = "range";
    this.#slider.step = "any";
    this.#slider.setAttribute("aria-label", "Playback position");
    this.#slider.addEventListener("change", () => {
      this.#background(async () => {
        await this.#seek(
          fromNanoseconds(this.#startNs! + secondsToNanoseconds(this.#slider.valueAsNumber)),
        );
      });
    });
    this.#timeOutput.setAttribute("aria-label", "Current time");
    this.#playbackBar.append(this.#playButton, this.#slider, this.#timeOutput);

    this.#sidebar.setAttribute("aria-label", "Panel settings");

    root.append(this.#layout, this.#playbackBar, this.#sidebar);
    this.#applyTheme();
    this.#updatePlaybackBar();
    document.body.append(root);
  }

  #applyTheme(): void {
    const theme = THEMES[this.inputs.colorScheme];
    const style = this.element.style;
    style.colorScheme = this.inputs.colorScheme;
    style.background = theme.background;
    style.color = theme.text;
    style.setProperty("--foxglove-simulator-panel", theme.panel);
    style.setProperty("--foxglove-simulator-border", theme.border);
    style.setProperty("--foxglove-simulator-error", theme.error);
  }

  #updatePlaybackBar(): void {
    const hasTime = this.#currentNs != undefined;
    this.#playbackBar.hidden = !hasTime;
    const isRecording = this.#recording != undefined;
    this.#playButton.hidden = !isRecording;
    this.#slider.hidden = !isRecording;
    this.#playButton.textContent = this.#playing ? "Pause" : "Play";
    if (hasTime) {
      const start = nanosecondsToSeconds(this.#startNs!);
      this.#slider.min = "0";
      this.#slider.max = String(nanosecondsToSeconds(this.#endNs!) - start);
      this.#slider.value = String(nanosecondsToSeconds(this.#currentNs!) - start);
      this.#timeOutput.textContent = `${isRecording ? "" : "Live "}${formatTime(this.#currentNs!)}`;
    }
  }
}

const publicHandles = new WeakMap<FoxgloveSimulation, SimulatedFoxglove>();

function publicHandle(simulation: FoxgloveSimulation): SimulatedFoxglove {
  const handle: SimulatedFoxglove = {
    element: simulation.element,
    get extension() {
      return simulation.extension;
    },
    get panels() {
      return simulation.panels;
    },
    openPanel: async (name, options) => await simulation.openPanel(name, options),
    get currentTime() {
      return simulation.currentTime;
    },
    get startTime() {
      return simulation.startTime;
    },
    get endTime() {
      return simulation.endTime;
    },
    get isPlaying() {
      return simulation.isPlaying;
    },
    seek: async (time) => {
      await simulation.seekTo(time);
    },
    seekFromStart: async (seconds) => {
      await simulation.seekFromStart(seconds);
    },
    advanceTo: async (time) => {
      await simulation.advanceTo(time);
    },
    advance: async (seconds) => {
      await simulation.advance(seconds);
    },
    play: (options) => {
      simulation.play(options);
    },
    pause: async () => {
      await simulation.pause();
    },
    hover: async (time) => {
      await simulation.hover(time);
    },
    receive: async (messages) => {
      await simulation.receive(messages);
    },
    setTopics: async (topics) => {
      await simulation.setTopics(topics);
    },
    setParameter: async (name, value) => {
      await simulation.setLiveParameter(name, value);
    },
    get parameters() {
      return simulation.parameters;
    },
    published: simulation.published,
    serviceCalls: simulation.serviceCalls,
    addedPanels: simulation.addedPanels,
    get requests() {
      return simulation.requests;
    },
    get variables() {
      return simulation.variables;
    },
    setVariable: async (name, value) => {
      await simulation.setLayoutVariable(name, value);
    },
    get colorScheme() {
      return simulation.colorScheme;
    },
    setColorScheme: async (colorScheme) => {
      await simulation.setColorScheme(colorScheme);
    },
    setAppSetting: async (key, value) => {
      await simulation.setAppSetting(key, value);
    },
    problems: simulation.problems,
    settle: async () => {
      await simulation.settle();
    },
    close: () => {
      simulation.close();
    },
  };
  publicHandles.set(simulation, handle);
  return handle;
}

/**
 * Simulate Foxglove in the test's browser page, load an extension into it, and open a mocked data
 * source. Open the extension's panels with `openPanel`, then drive the simulation the way a user
 * and a robot would: play and seek, send live messages, change variables and settings. Panels get
 * the render state, messages, and context behavior they get in Foxglove.
 *
 * Nothing reaches a real backend. Messages, service responses, parameters, and `fetch` responses
 * all come from the options.
 *
 * Call {@link cleanup} after each test to close the simulations it created.
 *
 * @example
 * ```ts
 * const foxglove = await simulateFoxglove({
 *   extension: { activate },
 *   dataSource: {
 *     type: "recording",
 *     topics: [{ name: "/speed", schemaName: "Speed" }],
 *     messages: [{ topic: "/speed", receiveTime: 1, message: { value: 3 } }],
 *   },
 * });
 * await foxglove.openPanel("speed-panel");
 * await foxglove.advanceTo(1);
 * await expect.element(page.getByText("3 m/s")).toBeVisible();
 * ```
 */
export async function simulateFoxglove(
  options: SimulateFoxgloveOptions,
): Promise<SimulatedFoxglove> {
  // Installed first, so requests that activate or the bundle make are mocked too
  const network = interceptNetwork(options.network ?? {});
  const blockedDuringActivation: string[] = [];
  network.interceptor.blocked = (message) => {
    blockedDuringActivation.push(message);
  };
  let simulation: FoxgloveSimulation;
  try {
    const registrations = await activateExtension(options.extension);
    simulation = new FoxgloveSimulation(registrations, options, network);
  } catch (caught) {
    network.restore();
    throw caught;
  }
  for (const message of [...blockedDuringActivation, ...simulation.extension.warnings]) {
    simulation.reportProblem(message);
  }
  return publicHandle(simulation);
}

/** Options for {@link renderPanel}. */
export type RenderPanelOptions = Omit<SimulateFoxgloveOptions, "extension"> &
  OpenPanelOptions & {
    /** The name to register the panel with. Defaults to `"panel"`. */
    readonly name?: string;
  };

/**
 * Open a single panel in a simulated Foxglove, without an extension's `activate` function. This is
 * shorthand for {@link simulateFoxglove} with an extension that registers only this panel,
 * followed by `openPanel`. The simulation is available as `panel.foxglove`.
 *
 * @example
 * ```ts
 * const panel = await renderPanel(initExamplePanel, {
 *   dataSource: { type: "recording", topics: [{ name: "/imu", schemaName: "sensor_msgs/Imu" }] },
 * });
 * await expect.element(page.getByText("sensor_msgs/Imu")).toBeVisible();
 * ```
 */
export async function renderPanel(
  initPanel: ExtensionPanelRegistration["initPanel"],
  options: RenderPanelOptions = {},
): Promise<SimulatedPanel> {
  const name = options.name ?? "panel";
  const foxglove = await simulateFoxglove({
    ...options,
    extension: (context: ExtensionContext) => {
      context.registerPanel({ name, initPanel });
    },
  });
  return await foxglove.openPanel(name, options);
}

/**
 * Close every simulation that is still open, unmounting its panels. Call it after each test:
 * `afterEach(cleanup)`.
 */
export function cleanup(): void {
  const errors: unknown[] = [];
  for (const simulation of [...simulations]) {
    try {
      simulation.close();
    } catch (caught) {
      errors.push(caught);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Cleaning up a simulated Foxglove failed");
  }
}
