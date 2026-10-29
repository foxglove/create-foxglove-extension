import type {
  AppSettingValue,
  Experimental,
  ExtensionPanelRegistration,
  Immutable,
  LayoutActions,
  MessageEvent,
  ParameterValue,
  RegisterMessageConverterArgsSchema,
  RenderState,
  SettingsTree,
  SettingsTreeAction,
  SubscribeMessageRangeArgs,
  Subscription,
  Time,
  Topic,
  VariableValue,
} from "@foxglove/extension";

import { mockEveryMember } from "./extensionHost.mjs";
import { SettingsEditor, findNode, settingInput } from "./settingsEditor.mjs";
import { schedule, withTimeout } from "./timers.mjs";

/** A topic advertised by a panel with `context.advertise`. */
export interface Advertisement {
  readonly schemaName: string;
  readonly options?: Record<string, unknown>;
}

/** The messages that the simulated player delivers in one frame of playback */
export interface PlayerFrame {
  readonly events: readonly MessageEvent[];
}

/** Values shared by every panel, which feed each panel's render state */
export interface SharedRenderInputs {
  /** Replaced, not mutated, whenever the topics change */
  readonly topics: readonly Topic[];
  /** Schema name of every topic panels can subscribe to, including aliases and converter outputs */
  readonly topicSchemas: ReadonlyMap<string, string>;
  /** Replaced whenever a variable changes */
  readonly variables: Readonly<Record<string, VariableValue>>;
  /** Replaced for every frame of playback */
  readonly frame: PlayerFrame | undefined;
  /** Changes on every seek, including the backfill after a subscription change */
  /** Undefined without a data source, which never seeks */
  readonly seekToken: number | undefined;
  readonly currentTime: Time | undefined;
  readonly startTime: Time | undefined;
  readonly endTime: Time | undefined;
  readonly previewTime: number | undefined;
  readonly colorScheme: "light" | "dark";
  readonly appSettings: ReadonlyMap<string, AppSettingValue>;
  readonly parameters: ReadonlyMap<string, ParameterValue>;
  readonly connection: { readonly host: string; readonly port: number } | undefined;
  readonly metadata: readonly Experimental.MetadataRecord[] | undefined;
  readonly attachments: readonly Experimental.AttachmentInfo[] | undefined;
}

/** Render state fields the simulation provides */
const SIMULATED_FIELDS = new Set<string>([
  // Experimental fields for comparing data sources. Outside compare mode, which the simulation
  // does not have, Foxglove leaves them undefined too.
  "comparisonSources",
  "primaryComparisonSource",
  "comparisonSlotStates",
  "currentFrame",
  "didSeek",
  "allFrames",
  "parameters",
  "sharedPanelState",
  "variables",
  "topics",
  "currentTime",
  "startTime",
  "endTime",
  "previewTime",
  "colorScheme",
  "appSettings",
  "connection",
  "metadata",
  "attachments",
]);

/** What the simulated Foxglove provides to the panels it hosts */
export interface PanelEnvironment {
  readonly renderTimeoutMs: number;
  readonly dataSourceProfile: string | undefined;
  readonly canSeek: boolean;
  readonly canPublish: boolean;
  readonly canCallServices: boolean;
  readonly schemaConverters: readonly RegisterMessageConverterArgsSchema[];
  readonly inputs: SharedRenderInputs;
  sharedPanelState(type: string): Immutable<Record<string, unknown>> | undefined;
  noteActivity(): void;
  track(promise: Promise<unknown>): void;
  settle(): Promise<void>;
  reportProblem(message: string, error?: unknown): void;
  selectPanel(panel: PanelHost): void;
  panelUnmounted(panel: PanelHost): void;
  /**
   * Called when panels' subscriptions change. `panel` and `previousTopics` identify a panel that
   * changed its own subscriptions.
   */
  subscriptionsChanged(panel?: PanelHost, previousTopics?: ReadonlySet<string>): void;
  setVariable(name: string, value: VariableValue): void;
  setSharedPanelState(
    type: string,
    state: Parameters<Experimental.PanelExtensionContext["setSharedPanelState"]>[0],
  ): void;
  setPreviewTime(seconds: number | undefined): void;
  seek(time: number | Time): void;
  publish(topic: string, message: unknown): void;
  callService(service: string, request: unknown): Promise<unknown>;
  setParameter(name: string, value: ParameterValue): void;
  addPanel(params: Parameters<LayoutActions["addPanel"]>[0]): void;
  panelChanged(panel: PanelHost): void;
  /** Every message on a topic, for range loading, or undefined if the data source is live */
  messagesOnTopic(topic: string): readonly MessageEvent[] | undefined;
  /** Bytes of an attachment, or undefined if the data source has no attachments */
  readonly fetchAttachment: ((id: string) => Promise<Uint8Array>) | undefined;
}

/** Options for opening a panel. */
export interface OpenPanelOptions {
  /**
   * Value of `context.initialState`, as if the panel was restored from a saved layout. Defaults to
   * an empty object, which is what Foxglove passes to a panel that was just added to a layout.
   */
  readonly initialState?: unknown;
  /** Width of the panel in CSS pixels. Defaults to 400. */
  readonly width?: number;
  /** Height of the panel in CSS pixels, not counting its title bar. Defaults to 300. */
  readonly height?: number;
}

/** Edits a panel's settings the way a user would in the settings sidebar. */
export interface PanelSettings {
  /** The most recent settings tree passed to `context.updatePanelSettingsEditor`. */
  readonly tree: Immutable<SettingsTree> | undefined;
  /** The sidebar section that shows this panel's settings as form controls. */
  readonly element: HTMLElement;
  /** The `data-testid` of the settings section, for `page.getByTestId`. */
  readonly testId: string;
  /**
   * Set the field at `path` to `value`, as if the user edited it, and wait for the panel to
   * settle. The path ends with the field's key, or with `"label"` or `"visible"` for a node that
   * is renamable or has a visibility toggle. Throws if there is no such field, or if it is disabled
   * or read-only.
   */
  update(path: readonly string[], value: unknown): Promise<void>;
  /** Run the action `id` of the node at `path`, as if the user picked it, and wait. */
  performAction(path: readonly string[], id: string): Promise<void>;
  /** Send any settings action to the panel, and wait for the panel to settle. */
  dispatch(action: SettingsTreeAction): Promise<void>;
}

type ConverterMap = ReadonlyMap<string, readonly RegisterMessageConverterArgsSchema[]>;

interface Conversions {
  /** Every topic the panel subscribes to */
  readonly subscribed: ReadonlySet<string>;
  /** Topics delivered without conversion */
  readonly unconverted: ReadonlySet<string>;
  /** Converters to run, keyed by topic and schema name */
  readonly converters: ConverterMap;
  /** Topics whose subscriptions ask for every message, for `allFrames` */
  readonly preloadTopics: ReadonlySet<string>;
  readonly preloadConverters: ConverterMap;
}

/** Thrown when a message converter throws, to skip the render as Foxglove does */
class ConverterFailure extends Error {}

function compareReceiveTime(a: MessageEvent, b: MessageEvent): number {
  return a.receiveTime.sec === b.receiveTime.sec
    ? a.receiveTime.nsec - b.receiveTime.nsec
    : a.receiveTime.sec - b.receiveTime.sec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function converterKey(topic: string, schemaName: string): string {
  return `${topic}\n${schemaName}`;
}

function collateConversions(
  subscriptions: readonly Subscription[],
  topicSchemas: ReadonlyMap<string, string>,
  schemaConverters: readonly RegisterMessageConverterArgsSchema[],
): Conversions {
  const unconverted = new Set<string>();
  const converters = new Map<string, RegisterMessageConverterArgsSchema[]>();
  const preloadTopics = new Set<string>();
  const preloadConverters = new Map<string, RegisterMessageConverterArgsSchema[]>();
  const add = (
    map: Map<string, RegisterMessageConverterArgsSchema[]>,
    key: string,
    converter: RegisterMessageConverterArgsSchema,
  ) => {
    const list = map.get(key) ?? [];
    if (!list.some((existing) => existing.toSchemaName === converter.toSchemaName)) {
      list.push(converter);
    }
    map.set(key, list);
  };

  for (const subscription of subscriptions) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const preload = subscription.preload === true;
    if (preload) {
      preloadTopics.add(subscription.topic);
    }
    const schemaName = topicSchemas.get(subscription.topic);
    if (subscription.convertTo == undefined || subscription.convertTo === schemaName) {
      unconverted.add(subscription.topic);
      continue;
    }
    if (schemaName == undefined) {
      continue;
    }
    const key = converterKey(subscription.topic, schemaName);
    // Like Foxglove, one converter handles each topic and target schema: the first registered
    const converter = schemaConverters.find(
      (candidate) =>
        candidate.fromSchemaName === schemaName &&
        candidate.toSchemaName === subscription.convertTo,
    );
    if (converter != undefined) {
      add(converters, key, converter);
      if (preload) {
        add(preloadConverters, key, converter);
      }
    }
  }
  return {
    subscribed: new Set(subscriptions.map(({ topic }) => topic)),
    unconverted,
    converters,
    preloadTopics,
    preloadConverters,
  };
}

/** Converters in `next` that are not in `previous` */
function newConverters(next: ConverterMap, previous: ConverterMap | undefined): ConverterMap {
  const result = new Map<string, RegisterMessageConverterArgsSchema[]>();
  for (const [key, list] of next) {
    const added = list.filter((converter) => previous?.get(key)?.includes(converter) !== true);
    if (added.length > 0) {
      result.set(key, added);
    }
  }
  return result;
}

const UNSET = Symbol("unset");
export const EMPTY_VARIABLES: Readonly<Record<string, VariableValue>> = Object.freeze({});

/**
 * Builds a panel's render state the way Foxglove does: one object that is updated in place, with
 * only the watched fields, and a render only when one of them changed.
 */
class RenderStateBuilder {
  public readonly renderState: Record<string, unknown> = {};
  #prevSeekToken: number | undefined;
  #prevTopics: unknown = UNSET;
  #prevVariables: unknown = EMPTY_VARIABLES;
  #prevSharedPanelState: unknown = UNSET;
  #prevFrame: PlayerFrame | undefined;
  #hadMessages = false;
  #prevConversions: Conversions | undefined;
  #prevAllFrames: unknown = UNSET;
  #prevAppSettings: unknown = UNSET;
  #prevConnection: unknown = undefined;
  readonly #lastMessageByTopic = new Map<string, MessageEvent>();

  public constructor(
    private readonly convert: (
      event: MessageEvent,
      converters: ConverterMap,
      out: MessageEvent[],
    ) => void,
  ) {}

  /** Treat `frame` as delivered, for a panel that opens after it was played */
  public skipFrame(frame: PlayerFrame | undefined): void {
    this.#prevFrame = frame;
  }

  public build(args: {
    inputs: SharedRenderInputs;
    watched: ReadonlySet<string>;
    conversions: Conversions;
    sharedPanelState: unknown;
    appSettings: ReadonlyMap<string, AppSettingValue>;
    allMessages: (topic: string) => readonly MessageEvent[];
    /** Messages for this panel alone, such as the latest messages on a topic it just joined */
    privateEvents: readonly MessageEvent[];
  }): boolean {
    const { inputs, watched, conversions } = args;
    const state = this.renderState;
    let shouldRender = false;
    const set = (field: string, value: unknown) => {
      state[field] = value;
      shouldRender = true;
    };

    const didSeek = this.#prevSeekToken !== inputs.seekToken;
    if (didSeek) {
      this.#lastMessageByTopic.clear();
    }

    const conversionsChanged = conversions !== this.#prevConversions;
    if (watched.has("currentFrame")) {
      // Cleared so that a render for another field does not repeat the previous frame
      state.currentFrame = undefined;
      const frame = inputs.frame;
      // Processed before the other fields, so that a converter that throws skips the render
      // without consuming their changes. The frame is consumed, so it fails only once.
      const frameIsNew = frame != undefined && frame !== this.#prevFrame;
      try {
        if (frameIsNew || args.privateEvents.length > 0) {
          // Like Foxglove's message pipeline, each panel gets only the messages it subscribes to
          const frameEvents = frameIsNew
            ? frame.events.filter((event) => conversions.subscribed.has(event.topic))
            : [];
          // The panel's own catch-up messages are older than the frame, and may already be in it
          const events = [
            ...args.privateEvents.filter((event) => !frameEvents.includes(event)),
            ...frameEvents,
          ].sort(compareReceiveTime);
          const delivered: MessageEvent[] = [];
          for (const event of events) {
            if (conversions.unconverted.has(event.topic)) {
              delivered.push(event);
            }
            this.convert(event, conversions.converters, delivered);
            this.#lastMessageByTopic.set(event.topic, event);
          }
          if (delivered.length > 0) {
            set("currentFrame", delivered);
          } else if (events.length === 0 && this.#hadMessages) {
            // A frame without messages for the panel follows one with messages. Foxglove renders
            // that once, with no currentFrame.
            set("currentFrame", undefined);
          }
          this.#hadMessages = events.length > 0;
        } else if (conversionsChanged) {
          // A new conversion of a topic that already has messages converts the latest one
          const added = newConverters(conversions.converters, this.#prevConversions?.converters);
          const delivered: MessageEvent[] = [];
          for (const event of this.#lastMessageByTopic.values()) {
            this.convert(event, added, delivered);
          }
          if (delivered.length > 0) {
            set("currentFrame", delivered);
          }
        }
      } catch (caught) {
        if (caught instanceof ConverterFailure) {
          this.#prevFrame = frame;
          this.#prevConversions = conversions;
          this.#hadMessages = false;
        }
        throw caught;
      }
      this.#prevFrame = frame;
    }

    if (watched.has("didSeek") && state.didSeek !== didSeek) {
      set("didSeek", didSeek);
    }
    if (watched.has("parameters") && state.parameters !== inputs.parameters) {
      set("parameters", inputs.parameters);
    }
    if (watched.has("sharedPanelState") && args.sharedPanelState !== this.#prevSharedPanelState) {
      this.#prevSharedPanelState = args.sharedPanelState;
      set("sharedPanelState", args.sharedPanelState);
    }
    if (watched.has("variables") && inputs.variables !== this.#prevVariables) {
      this.#prevVariables = inputs.variables;
      set("variables", new Map(Object.entries(inputs.variables)));
    }
    if (watched.has("topics") && inputs.topics !== this.#prevTopics) {
      this.#prevTopics = inputs.topics;
      set("topics", inputs.topics);
    }

    if (watched.has("allFrames") && this.#prevAllFrames !== conversions) {
      this.#prevAllFrames = conversions;
      const allFrames: MessageEvent[] = [];
      const events = [...conversions.preloadTopics]
        .flatMap((topic) => [...args.allMessages(topic)])
        .sort(compareReceiveTime);
      for (const event of events) {
        if (conversions.unconverted.has(event.topic)) {
          allFrames.push(event);
        }
        try {
          this.convert(event, conversions.preloadConverters, allFrames);
        } catch (caught) {
          // The failure is reported. Like Foxglove's range loading, the rest is still delivered.
          if (!(caught instanceof ConverterFailure)) {
            throw caught;
          }
        }
      }
      set("allFrames", allFrames);
    }

    for (const field of ["currentTime", "startTime", "endTime"] as const) {
      if (watched.has(field) && state[field] !== inputs[field]) {
        set(field, inputs[field]);
      }
    }
    if (watched.has("previewTime") && state.previewTime !== inputs.previewTime) {
      set("previewTime", inputs.previewTime);
    }
    if (watched.has("colorScheme") && state.colorScheme !== inputs.colorScheme) {
      set("colorScheme", inputs.colorScheme);
    }
    if (watched.has("appSettings") && args.appSettings !== this.#prevAppSettings) {
      this.#prevAppSettings = args.appSettings;
      set("appSettings", args.appSettings);
    }
    if (watched.has("connection") && inputs.connection !== this.#prevConnection) {
      this.#prevConnection = inputs.connection;
      set("connection", inputs.connection);
    }
    for (const field of ["metadata", "attachments"] as const) {
      if (watched.has(field) && state[field] !== inputs[field]) {
        set(field, inputs[field]);
      }
    }

    this.#prevSeekToken = inputs.seekToken;
    this.#prevConversions = conversions;
    return shouldRender;
  }
}

/** A panel mounted in the simulated Foxglove */
export class PanelHost {
  static #panelCount = 0;
  public readonly frame = document.createElement("section");
  /** The `data-testid` of the panel's frame, for `page.getByTestId` */
  public readonly testId: string;
  public readonly panelElement = document.createElement("div");
  public readonly settingsEditor: SettingsEditor;
  public readonly context: Experimental.PanelExtensionContext;
  public readonly watchedFields = new Set<keyof RenderState>();
  public readonly advertisements = new Map<string, Advertisement>();
  public subscriptions: readonly Subscription[] = [];
  public appSettingsSubscriptions: readonly string[] = [];
  public savedState: unknown = undefined;
  public settingsTree: Immutable<SettingsTree> | undefined;
  public defaultTitle: string | undefined;
  public toolbarItems: Immutable<Experimental.PanelToolbarItem[]> = [];
  public renderCount = 0;
  public readonly followedLinks: string[] = [];
  public lastRenderState: Immutable<RenderState> | undefined;
  public error: Error | undefined;
  public mounted = true;

  readonly #titleElement = document.createElement("span");
  readonly #toolbarElement = document.createElement("div");
  readonly #errorElement = document.createElement("div");
  readonly #builder: RenderStateBuilder;
  readonly #rangeSubscriptions = new Map<() => void, { topic: string; restart: () => void }>();
  #onRender: ((renderState: Immutable<RenderState>, done: () => void) => void) | undefined;
  #rendering = false;
  #doneCalled = true;
  #pending = false;
  #scheduled = false;
  #idleWaiters: (() => void)[] = [];
  #conversions: Conversions | undefined;
  #conversionInputs: unknown[] = [];
  #appSettings: ReadonlyMap<string, AppSettingValue> = new Map();
  #appSettingsInputs: unknown[] = [];
  #privateEvents: MessageEvent[] = [];
  #cleanup: (() => void) | undefined;

  public constructor(
    private readonly env: PanelEnvironment,
    public readonly registration: ExtensionPanelRegistration,
    public readonly initialState: unknown,
    public readonly options: OpenPanelOptions,
  ) {
    this.#builder = new RenderStateBuilder((event, converters, out) => {
      this.#convert(event, converters, out);
    });
    this.settingsEditor = new SettingsEditor((action) => {
      this.#handleSettingsAction(action);
    });
    // A panel that opens now did not subscribe when the current frame played
    this.#builder.skipFrame(env.inputs.frame);
    PanelHost.#panelCount += 1;
    this.testId = `foxglove-panel-${PanelHost.#panelCount}`;
    this.frame.dataset.testid = this.testId;
    this.settingsEditor.element.dataset.testid = `${this.testId}-settings`;
    this.#buildFrame(options);
    this.context = this.#buildContext();
  }

  /** The title shown in the panel's title bar */
  public get title(): string {
    return this.defaultTitle ?? this.registration.name;
  }

  public get idle(): boolean {
    return !this.#scheduled && !this.#rendering;
  }

  public get settings(): PanelSettings {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    const dispatch = async (action: SettingsTreeAction) => {
      if (this.settingsTree == undefined) {
        throw new Error(
          `Panel "${this.title}" has not called context.updatePanelSettingsEditor, so it has no settings`,
        );
      }
      this.#handleSettingsAction(action);
      await this.env.settle();
    };
    return {
      get tree() {
        return host.settingsTree;
      },
      element: this.settingsEditor.element,
      testId: `${this.testId}-settings`,
      dispatch,
      update: async (path, value) => {
        const result =
          this.settingsTree == undefined
            ? { error: `Panel "${this.title}" has no settings` }
            : settingInput(this.settingsTree, path, value);
        if ("error" in result) {
          throw new Error(result.error);
        }
        await dispatch({
          action: "update",
          payload: { path, input: result.input, value: result.value },
        } as SettingsTreeAction);
      },
      performAction: async (path, id) => {
        const node = this.settingsTree == undefined ? undefined : findNode(this.settingsTree, path);
        const action = node?.actions?.find((item) => item.type === "action" && item.id === id);
        if (action?.type !== "action") {
          throw new Error(`There is no action "${id}" on the settings node [${path.join(", ")}]`);
        }
        if (action.disabled === true) {
          throw new Error(
            `The action "${id}" on the settings node [${path.join(", ")}] is disabled`,
          );
        }
        await dispatch({ action: "perform-node-action", payload: { id, path } });
      },
    };
  }

  /** Call the panel's `initPanel`. Throws what it throws. */
  public init(): void {
    const cleanup = this.registration.initPanel(this.context);
    this.#cleanup = typeof cleanup === "function" ? cleanup : undefined;
  }

  /** Render the panel soon, if any of its watched fields changed */
  public scheduleDispatch(): void {
    if (!this.mounted || this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    schedule(() => {
      this.#scheduled = false;
      this.#dispatch();
      this.#notifyIfIdle();
    });
  }

  /** Load ranges again on topics whose data changed, such as an alias that points elsewhere */
  public restartRanges(topics: ReadonlySet<string>): void {
    for (const subscription of this.#rangeSubscriptions.values()) {
      if (topics.has(subscription.topic)) {
        subscription.restart();
      }
    }
  }

  /** Deliver messages to this panel alone, in its next render */
  public deliver(events: readonly MessageEvent[]): void {
    if (events.length === 0) {
      return;
    }
    this.#privateEvents.push(...events);
    this.scheduleDispatch();
  }

  /** Resolves once the panel has finished rendering, and rejects if it does not call done() */
  public async whenIdle(): Promise<void> {
    if (this.idle) {
      return;
    }
    await withTimeout(
      new Promise<void>((resolve) => {
        this.#idleWaiters.push(resolve);
      }),
      this.env.renderTimeoutMs,
      () =>
        new Error(
          `Panel "${this.title}" did not call done() within ${this.env.renderTimeoutMs}ms of a render. Foxglove waits for done() before it renders the panel again, and shows a warning that the panel is delayed.`,
        ),
    );
  }

  public unmount(): void {
    this.#teardown({ keepFrame: false });
  }

  #teardown(options: { keepFrame: boolean }): void {
    if (!this.mounted) {
      if (!options.keepFrame) {
        this.frame.remove();
      }
      return;
    }
    this.mounted = false;
    this.#onRender = undefined;
    this.#pending = false;
    this.#rendering = false;
    for (const unsubscribe of [...this.#rangeSubscriptions.keys()]) {
      unsubscribe();
    }
    this.#rangeSubscriptions.clear();
    try {
      this.#cleanup?.();
    } finally {
      if (options.keepFrame) {
        this.panelElement.remove();
      } else {
        this.frame.remove();
      }
      this.subscriptions = [];
      this.advertisements.clear();
      this.#notifyIfIdle();
      this.env.panelUnmounted(this);
    }
  }

  /** Update the title bar and settings after the panel changed them */
  public refreshChrome(): void {
    this.frame.setAttribute("aria-label", this.title);
    this.#titleElement.textContent = this.title;
    this.settingsEditor.update(this.title, this.settingsTree);
    this.#renderToolbar();
  }

  #buildFrame(options: OpenPanelOptions): void {
    const width = options.width ?? 400;
    const height = options.height ?? 300;
    this.frame.dataset.foxglovePanel = this.registration.name;
    this.frame.style.display = "flex";
    this.frame.style.flexDirection = "column";
    this.frame.style.width = `${width}px`;
    this.frame.style.border = "1px solid var(--foxglove-simulator-border)";
    this.frame.style.background = "var(--foxglove-simulator-panel)";
    this.frame.addEventListener(
      "pointerdown",
      () => {
        this.env.selectPanel(this);
      },
      { capture: true },
    );

    const titleBar = document.createElement("div");
    titleBar.style.display = "flex";
    titleBar.style.alignItems = "center";
    titleBar.style.gap = "4px";
    titleBar.style.padding = "2px 6px";
    titleBar.style.minHeight = "24px";
    titleBar.style.borderBottom = "1px solid var(--foxglove-simulator-border)";
    this.#titleElement.style.flex = "1";
    this.#toolbarElement.style.display = "flex";
    this.#toolbarElement.style.gap = "2px";
    titleBar.append(this.#titleElement, this.#toolbarElement);

    const container = document.createElement("div");
    container.style.position = "relative";
    container.style.height = `${height}px`;
    container.style.overflow = "hidden";
    // Foxglove sizes the panel element to fill the panel
    this.panelElement.style.width = "100%";
    this.panelElement.style.height = "100%";
    this.panelElement.style.overflow = "hidden";
    container.append(this.panelElement);

    this.#errorElement.setAttribute("role", "alert");
    this.#errorElement.hidden = true;
    this.#errorElement.style.padding = "4px 6px";
    this.#errorElement.style.color = "var(--foxglove-simulator-error)";

    this.frame.append(titleBar, container, this.#errorElement);
    this.refreshChrome();
  }

  #renderToolbar(): void {
    const items = this.toolbarItems.map((item) => {
      if (item.type === "divider") {
        const divider = document.createElement("span");
        divider.setAttribute("role", "separator");
        divider.setAttribute("aria-orientation", "vertical");
        return divider;
      }
      const control =
        item.type === "link"
          ? this.#toolbarLink(item)
          : Object.assign(document.createElement("button"), {
              type: "button",
              disabled: item.disabled === true,
            });
      control.setAttribute("aria-label", item.tooltip ?? item.id);
      if (item.tooltip != undefined) {
        control.title = item.tooltip;
      }
      if (item.dataTestId != undefined) {
        control.dataset.testid = item.dataTestId;
      }
      // Newer versions of @foxglove/extension also accept the name of a built-in icon
      const icon: unknown = item.icon;
      control.append(icon instanceof Node ? icon.cloneNode(true) : String(icon));
      if (item.type === "button") {
        control.addEventListener("click", (event) => {
          item.onClick?.(event as MouseEvent);
        });
      }
      return control;
    });
    this.#toolbarElement.replaceChildren(...items);
  }

  #toolbarLink(item: Immutable<Experimental.PanelToolbarLink>): HTMLAnchorElement {
    const link = document.createElement("a");
    if (item.disabled === true) {
      link.setAttribute("aria-disabled", "true");
    } else {
      link.href = item.href;
      link.target = item.target ?? "_blank";
      link.rel = "noopener";
    }
    // Following a link would navigate the test's page away, so the click is recorded instead
    link.addEventListener("click", (event) => {
      event.preventDefault();
      if (item.disabled !== true) {
        this.followedLinks.push(item.href);
      }
    });
    return link;
  }

  #showError(error: Error | undefined): void {
    this.error = error;
    this.#errorElement.hidden = error == undefined;
    this.#errorElement.textContent = error == undefined ? "" : `Panel error: ${error.message}`;
  }

  #handleSettingsAction(action: SettingsTreeAction): void {
    const tree = this.settingsTree;
    if (!this.mounted || tree == undefined) {
      return;
    }
    this.env.noteActivity();
    try {
      tree.actionHandler(action);
    } catch (caught) {
      this.env.reportProblem(`The settings action handler of panel "${this.title}" threw`, caught);
    }
  }

  #convert(event: MessageEvent, converters: ConverterMap, out: MessageEvent[]): void {
    for (const converter of converters.get(converterKey(event.topic, event.schemaName)) ?? []) {
      let message: unknown;
      try {
        message = converter.converter(event.message, event);
      } catch (caught) {
        this.env.reportProblem(
          `The message converter from ${converter.fromSchemaName} to ${converter.toSchemaName} threw on a message on "${event.topic}"`,
          caught,
        );
        // Foxglove skips the render that hit the error
        throw new ConverterFailure();
      }
      // Returning undefined or null skips the message
      if (message == undefined) {
        continue;
      }
      out.push({
        topic: event.topic,
        schemaName: converter.toSchemaName,
        receiveTime: event.receiveTime,
        message,
        originalMessageEvent: event,
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        sizeInBytes: event.sizeInBytes,
      });
    }
  }

  /** Memoized, so the render state builder can tell when conversions changed */
  #currentConversions(): Conversions {
    const inputs = [this.subscriptions, this.env.inputs.topicSchemas];
    if (
      this.#conversions == undefined ||
      inputs.some((input, index) => input !== this.#conversionInputs[index])
    ) {
      this.#conversions = collateConversions(
        this.subscriptions,
        this.env.inputs.topicSchemas,
        this.env.schemaConverters,
      );
      this.#conversionInputs = inputs;
    }
    return this.#conversions;
  }

  /** Memoized map of the app settings this panel subscribed to */
  #currentAppSettings(): ReadonlyMap<string, AppSettingValue> {
    const inputs = [this.appSettingsSubscriptions, this.env.inputs.appSettings];
    if (inputs.some((input, index) => input !== this.#appSettingsInputs[index])) {
      const settings = new Map<string, AppSettingValue>();
      for (const key of this.appSettingsSubscriptions) {
        if (this.env.inputs.appSettings.has(key)) {
          settings.set(key, this.env.inputs.appSettings.get(key));
        }
      }
      this.#appSettings = settings;
      this.#appSettingsInputs = inputs;
    }
    return this.#appSettings;
  }

  #dispatch(): void {
    const onRender = this.#onRender;
    if (!this.mounted || onRender == undefined) {
      return;
    }
    if (this.#rendering) {
      this.#pending = true;
      return;
    }
    let shouldRender: boolean;
    try {
      shouldRender = this.#builder.build({
        inputs: this.env.inputs,
        watched: this.watchedFields,
        conversions: this.#currentConversions(),
        sharedPanelState: this.env.sharedPanelState(this.registration.name),
        appSettings: this.#currentAppSettings(),
        allMessages: (topic) => this.env.messagesOnTopic(topic) ?? [],
        privateEvents: this.#takePrivateEvents(),
      });
    } catch (caught) {
      if (caught instanceof ConverterFailure) {
        // The failed frame is skipped. Render again for anything else that changed.
        this.scheduleDispatch();
        return;
      }
      throw caught;
    }
    if (!shouldRender) {
      return;
    }
    this.#rendering = true;
    this.#doneCalled = false;
    this.env.noteActivity();
    const renderState = this.#builder.renderState as Immutable<RenderState>;
    try {
      onRender(renderState, () => {
        this.#done(renderState);
      });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      this.#showError(error);
      this.env.reportProblem(`Panel "${this.title}" threw while rendering`, error);
      // Foxglove replaces a panel that throws with an error message, which unmounts the panel
      try {
        this.#teardown({ keepFrame: true });
      } catch (cleanupError) {
        this.env.reportProblem(`The cleanup function of panel "${this.title}" threw`, cleanupError);
      }
    }
  }

  #done(renderState: Immutable<RenderState>): void {
    // A render that ended because the panel unmounted or threw is not finished by a late done()
    if (!this.mounted) {
      return;
    }
    // Like Foxglove, done() finishes the current render, even if it came from an earlier one
    if (this.#doneCalled) {
      this.env.reportProblem(`Panel "${this.title}" called done() more than once for one render`);
      return;
    }
    this.#doneCalled = true;
    this.#rendering = false;
    this.renderCount += 1;
    this.lastRenderState = { ...renderState };
    this.env.noteActivity();
    if (this.#pending) {
      this.#pending = false;
      this.scheduleDispatch();
    }
    this.#notifyIfIdle();
  }

  #takePrivateEvents(): MessageEvent[] {
    const events = this.#privateEvents;
    this.#privateEvents = [];
    return events;
  }

  #notifyIfIdle(): void {
    if (!this.idle && this.mounted) {
      return;
    }
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  #buildContext(): Experimental.PanelExtensionContext {
    const env = this.env;
    // Like Foxglove, calls after the panel unmounts are ignored, except calls that return a result
    const ifMounted =
      <Args extends unknown[]>(fn: (...args: Args) => void) =>
      (...args: Args): void => {
        if (this.mounted) {
          env.noteActivity();
          fn(...args);
        }
      };
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;

    const subscribeMessageRange = (args: SubscribeMessageRangeArgs): (() => void) => {
      if (!this.mounted) {
        return () => undefined;
      }
      let active = false;
      // Reads the topic's messages from the start. Foxglove starts again when the topic's data
      // changes, such as when an alias points at a different topic.
      const start = () => {
        active = false;
        const schemaName = env.inputs.topicSchemas.get(args.topic);
        let converters: ConverterMap | undefined;
        if (args.convertTo != undefined && args.convertTo !== schemaName) {
          const converter = env.schemaConverters.find(
            (candidate) =>
              candidate.fromSchemaName === schemaName && candidate.toSchemaName === args.convertTo,
          );
          if (schemaName == undefined || converter == undefined) {
            env.reportProblem(
              `No message converter from ${schemaName ?? "an unknown schema"} to ${args.convertTo} for "${args.topic}", so subscribeMessageRange delivers no messages`,
            );
            return;
          }
          converters = new Map([[converterKey(args.topic, schemaName), [converter]]]);
        }
        let iteratorActive = true;
        const isActive = () => iteratorActive && active && this.mounted;
        const events = env.messagesOnTopic(args.topic) ?? [];
        const batches = async function* (): AsyncGenerator<Immutable<MessageEvent[]>> {
          const batchSize = 1000;
          for (let index = 0; index < events.length && isActive(); index += batchSize) {
            const batch = events.slice(index, index + batchSize);
            if (converters == undefined) {
              yield batch;
              continue;
            }
            const converted: MessageEvent[] = [];
            for (const event of batch) {
              host.#convert(event, converters, converted);
            }
            yield converted;
          }
        };
        active = true;
        stopIterator = () => {
          iteratorActive = false;
        };
        schedule(() => {
          if (!isActive()) {
            return;
          }
          env.track(
            // Starting from a resolved promise turns a synchronous throw into a rejection
            Promise.resolve()
              .then(async () => {
                await args.onNewRangeIterator(batches());
              })
              .catch((caught: unknown) => {
                if (caught instanceof ConverterFailure) {
                  return;
                }
                env.reportProblem(
                  `onNewRangeIterator of panel "${this.title}" threw for "${args.topic}"`,
                  caught,
                );
              }),
          );
        });
      };
      let stopIterator = () => undefined as void;
      const subscription = {
        topic: args.topic,
        restart: () => {
          stopIterator();
          start();
        },
      };
      start();
      const unsubscribe = () => {
        active = false;
        stopIterator();
        this.#rangeSubscriptions.delete(unsubscribe);
      };
      this.#rangeSubscriptions.set(unsubscribe, subscription);
      return unsubscribe;
    };

    const context = mockEveryMember<Experimental.PanelExtensionContext>({
      panelElement: this.panelElement,
      initialState: this.initialState,
      dataSourceProfile: env.dataSourceProfile,
      layout: {
        addPanel: ifMounted((params) => {
          env.addPanel(params);
        }),
      },
      get onRender() {
        return host.#onRender;
      },
      set onRender(onRender) {
        const first = host.#onRender == undefined;
        host.#onRender = onRender;
        // Foxglove renders as soon as a panel first sets onRender
        if (first && onRender != undefined) {
          host.scheduleDispatch();
        }
      },
      watch: ifMounted((field: keyof RenderState) => {
        if (!this.watchedFields.has(field)) {
          if (!SIMULATED_FIELDS.has(field)) {
            env.reportProblem(
              `Panel "${this.title}" watches "${field}", which the simulated Foxglove does not provide`,
            );
          }
          this.watchedFields.add(field);
          this.scheduleDispatch();
        }
      }),
      saveState: ifMounted((state) => {
        // Like Foxglove, saved state is merged into the panel's existing state
        const current = this.savedState ?? this.initialState;
        this.savedState = isRecord(current) && isRecord(state) ? { ...current, ...state } : state;
      }),
      setParameter: ifMounted((name, value) => {
        env.setParameter(name, value);
      }),
      setSharedPanelState: ifMounted((state) => {
        env.setSharedPanelState(this.registration.name, state);
      }),
      setVariable: ifMounted((name, value) => {
        env.setVariable(name, value);
      }),
      setPreviewTime: ifMounted((time) => {
        env.setPreviewTime(time);
      }),
      seekPlayback: env.canSeek
        ? ifMounted((time) => {
            env.seek(time);
          })
        : undefined,
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      subscribe: ifMounted((topics: readonly Subscription[] | readonly string[]) => {
        // A topic name alone is a deprecated form that also asks for every message
        const previousTopics = new Set(this.subscriptions.map(({ topic }) => topic));
        this.subscriptions = topics.map((topic) =>
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          typeof topic === "string" ? { topic, preload: true } : topic,
        );
        env.subscriptionsChanged(this, previousTopics);
        this.scheduleDispatch();
      }),
      unsubscribeAll: ifMounted(() => {
        const previousTopics = new Set(this.subscriptions.map(({ topic }) => topic));
        this.subscriptions = [];
        env.subscriptionsChanged(this, previousTopics);
        this.scheduleDispatch();
      }),
      subscribeAppSettings: ifMounted((settings) => {
        this.appSettingsSubscriptions = settings;
        this.scheduleDispatch();
      }),
      advertise: env.canPublish
        ? ifMounted((topic, schemaName, options) => {
            this.advertisements.set(
              topic,
              options == undefined ? { schemaName } : { schemaName, options },
            );
          })
        : undefined,
      unadvertise: env.canPublish
        ? ifMounted((topic) => {
            this.advertisements.delete(topic);
          })
        : undefined,
      publish: env.canPublish
        ? ifMounted((topic, message) => {
            if (!this.advertisements.has(topic)) {
              throw new Error(
                `Panel "${this.title}" published on "${topic}" without advertising it. Call context.advertise first.`,
              );
            }
            env.publish(topic, message);
          })
        : undefined,
      callService: env.canCallServices
        ? async (service, request) => {
            if (!this.mounted) {
              throw new Error("Service call after panel was unmounted");
            }
            env.noteActivity();
            return await env.callService(service, request);
          }
        : undefined,
      updatePanelSettingsEditor: ifMounted((settings) => {
        this.settingsTree = settings;
        env.panelChanged(this);
      }),
      setDefaultPanelTitle: ifMounted((title) => {
        this.defaultTitle = title;
        env.panelChanged(this);
      }),
      subscribeMessageRange,
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      UNSTABLE_subscribeMessageRange: subscribeMessageRange,
      setPanelToolbarItems: ifMounted((items) => {
        this.toolbarItems = items;
        env.panelChanged(this);
      }),
      // Undefined when the data source has no attachments, as in Foxglove
      fetchAttachment:
        env.fetchAttachment == undefined
          ? undefined
          : async (id) => {
              if (!this.mounted) {
                throw new Error("fetchAttachment called after panel was unmounted");
              }
              return await env.fetchAttachment!(id);
            },
    });

    // Members that newer versions of @foxglove/extension add to the experimental context
    let frameTransformsEnabled = false;
    Object.assign(context, {
      frameTransforms: {
        lookupTransform: () => (frameTransformsEnabled ? "noTransforms" : "disabled"),
        frameIds: () => [],
        parentOf: () => undefined,
      },
      setFrameTransformsEnabled: (enabled: boolean) => {
        frameTransformsEnabled = enabled;
      },
    });
    return context;
  }
}
