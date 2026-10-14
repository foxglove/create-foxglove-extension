import type {
  ExtensionContext,
  ExtensionPanelRegistration,
  Immutable,
  LayoutActions,
  LegacyRegisterMessageConverterArgs,
  MessageEvent,
  PanelExtensionContext,
  ParameterValue,
  RegisterMessageConverterArgs,
  RegisterMessageConverterArgsSchema,
  RegisterMessageConverterArgsTopic,
  RenderState,
  SettingsTree,
  SettingsTreeAction,
  SubscribeMessageRangeArgs,
  Subscription,
  Time,
  TopicAliasFunction,
  VariableValue,
} from "@foxglove/extension";

/** Options for {@link renderPanel}. */
export interface RenderPanelOptions {
  /**
   * Value of `context.initialState`, as if the panel was restored from a saved layout. Defaults to
   * an empty object, which is what Foxglove passes to a panel that was just added to a layout.
   */
  readonly initialState?: unknown;
  /** Value of `context.dataSourceProfile`, such as `"ros1"` or `"ros2"`. */
  readonly dataSourceProfile?: string;
  /** Width of the panel element in CSS pixels. Defaults to 400. */
  readonly width?: number;
  /** Height of the panel element in CSS pixels. Defaults to 300. */
  readonly height?: number;
  /**
   * How long {@link PanelHarness.render} waits for the panel to call `done`, in milliseconds.
   * Defaults to 1000.
   */
  readonly renderTimeoutMs?: number;
  /**
   * Handlers for `context.callService`, keyed by service name. Calls to a service without a
   * handler reject.
   */
  readonly services?: Readonly<Record<string, (request: unknown) => unknown>>;
}

/** A message published by the panel with `context.publish`. */
export interface PublishedMessage {
  readonly topic: string;
  readonly message: unknown;
}

/** A topic advertised by the panel with `context.advertise`. */
export interface Advertisement {
  readonly schemaName: string;
  readonly options?: Record<string, unknown>;
}

/**
 * A panel mounted by {@link renderPanel}, with a mock Foxglove host behind its context.
 *
 * The harness records every call the panel makes to its context so tests can assert on them, and
 * lets tests drive the panel by delivering render state.
 */
export interface PanelHarness {
  /** The element the panel renders into. It is attached to the document. */
  readonly element: HTMLDivElement;
  /** The context passed to the panel's `initPanel` function. */
  readonly context: PanelExtensionContext;
  /** Render state fields the panel has asked to watch with `context.watch`. */
  readonly watchedFields: ReadonlySet<keyof RenderState>;
  /** The panel's current subscriptions. Each call to `context.subscribe` replaces the list. */
  readonly subscriptions: readonly Subscription[];
  /** App settings the panel has subscribed to with `context.subscribeAppSettings`. */
  readonly appSettingsSubscriptions: readonly string[];
  /** The most recent value passed to `context.saveState`. */
  readonly savedState: unknown;
  /** The most recent settings tree passed to `context.updatePanelSettingsEditor`. */
  readonly settingsTree: Immutable<SettingsTree> | undefined;
  /** The most recent title passed to `context.setDefaultPanelTitle`. */
  readonly defaultTitle: string | undefined;
  /** Parameters set with `context.setParameter`. */
  readonly parameters: ReadonlyMap<string, ParameterValue>;
  /** Variables set with `context.setVariable`. */
  readonly variables: ReadonlyMap<string, VariableValue>;
  /** The most recent value passed to `context.setSharedPanelState`. */
  readonly sharedPanelState: Immutable<Record<string, unknown>> | undefined;
  /** The most recent value passed to `context.setPreviewTime`. */
  readonly previewTime: number | undefined;
  /** Times passed to `context.seekPlayback`, in call order. */
  readonly seeks: readonly (number | Time)[];
  /** Topics currently advertised with `context.advertise`. */
  readonly advertisements: ReadonlyMap<string, Advertisement>;
  /** Messages published with `context.publish`, in call order. */
  readonly published: readonly PublishedMessage[];
  /** Panels added with `context.layout.addPanel`, in call order. */
  readonly addedPanels: readonly Parameters<LayoutActions["addPanel"]>[0][];

  /**
   * Deliver render state to the panel the way Foxglove does, and resolve once the panel calls
   * `done`.
   *
   * Like Foxglove, the panel receives the same render state object on every render. Fields from
   * earlier renders keep their values, except `currentFrame`, which only holds the messages given
   * to the latest render. Fields the panel does not watch are dropped.
   *
   * The promise rejects if the panel has not set `context.onRender`, if none of the given fields
   * are watched, or if the panel does not call `done` within the render timeout.
   */
  render(state?: RenderState): Promise<void>;

  /**
   * Send an action to the panel's settings tree, as if the user edited a field in the settings
   * editor. Throws if the panel has not called `context.updatePanelSettingsEditor`.
   */
  performSettingsAction(action: SettingsTreeAction): void;

  /** Run the cleanup function returned by `initPanel` and remove the panel element. */
  unmount(): void;
}

const mountedPanels = new Set<PanelHarness>();

/**
 * Returns `mock` unchanged. It fails to compile unless `mock` defines every member of `T`,
 * including optional ones, so that the harness is updated whenever the extension API grows.
 */
function mockEveryMember<T>(mock: T & Record<keyof T, unknown>): T {
  return mock;
}

/**
 * Mount a panel the way Foxglove does: create a panel element, build a `PanelExtensionContext`,
 * and call `initPanel` with it.
 *
 * Resolves once the panel has set `context.onRender`. Panels built with React typically set it in
 * an effect, which runs after `initPanel` returns. If the panel does not set `onRender` within the
 * render timeout, the promise still resolves so that panels which never render can be tested.
 *
 * Call {@link cleanup} after each test to unmount the panels a test created.
 *
 * @example
 * ```ts
 * const panel = await renderPanel(initExamplePanel);
 * await panel.render({ topics: [{ name: "/imu", schemaName: "sensor_msgs/Imu", datatype: "sensor_msgs/Imu" }] });
 * await expect.element(page.getByText("/imu")).toBeVisible();
 * ```
 */
export async function renderPanel(
  initPanel: ExtensionPanelRegistration["initPanel"],
  options: RenderPanelOptions = {},
): Promise<PanelHarness> {
  const element = document.createElement("div");
  element.style.width = `${options.width ?? 400}px`;
  element.style.height = `${options.height ?? 300}px`;
  element.style.position = "relative";
  element.style.overflow = "hidden";
  document.body.appendChild(element);

  const renderTimeoutMs = options.renderTimeoutMs ?? 1000;
  const watchedFields = new Set<keyof RenderState>();
  const parameters = new Map<string, ParameterValue>();
  const variables = new Map<string, VariableValue>();
  const advertisements = new Map<string, Advertisement>();
  const published: PublishedMessage[] = [];
  const seeks: (number | Time)[] = [];
  const addedPanels: Parameters<LayoutActions["addPanel"]>[0][] = [];
  let subscriptions: readonly Subscription[] = [];
  let appSettingsSubscriptions: readonly string[] = [];
  let savedState: unknown = undefined;
  let settingsTree: Immutable<SettingsTree> | undefined;
  let defaultTitle: string | undefined;
  let sharedPanelState: Immutable<Record<string, unknown>> | undefined;
  let previewTime: number | undefined;
  // Foxglove updates one render state object in place across renders
  const renderState: RenderState = {};

  const context = mockEveryMember<PanelExtensionContext>({
    panelElement: element,
    initialState: options.initialState ?? {},
    dataSourceProfile: options.dataSourceProfile,
    layout: {
      addPanel: (params) => {
        addedPanels.push(params);
      },
    },
    onRender: undefined,
    watch: (field: keyof RenderState) => {
      watchedFields.add(field);
    },
    saveState: (state) => {
      savedState = state;
    },
    setParameter: (name, value) => {
      parameters.set(name, value);
    },
    setSharedPanelState: (state) => {
      sharedPanelState = typeof state === "function" ? state(sharedPanelState) : state;
    },
    setVariable: (name, value) => {
      variables.set(name, value);
    },
    setPreviewTime: (time) => {
      previewTime = time;
    },
    seekPlayback: (time) => {
      seeks.push(time);
    },
    subscribe: (topics: readonly Subscription[] | readonly string[]) => {
      subscriptions = topics.map((topic) => (typeof topic === "string" ? { topic } : topic));
    },
    unsubscribeAll: () => {
      subscriptions = [];
    },
    subscribeAppSettings: (settings) => {
      appSettingsSubscriptions = settings;
    },
    advertise: (topic, schemaName, advertiseOptions) => {
      advertisements.set(topic, { schemaName, options: advertiseOptions });
    },
    unadvertise: (topic) => {
      advertisements.delete(topic);
    },
    publish: (topic, message) => {
      if (!advertisements.has(topic)) {
        throw new Error(`Panel published to "${topic}" without advertising it first`);
      }
      published.push({ topic, message });
    },
    callService: async (service, request) => {
      const handler = options.services?.[service];
      if (handler == undefined) {
        throw new Error(`No handler for service "${service}". Pass one in the services option.`);
      }
      return await Promise.resolve(handler(request));
    },
    updatePanelSettingsEditor: (settings) => {
      settingsTree = settings;
    },
    setDefaultPanelTitle: (title) => {
      defaultTitle = title;
    },
    subscribeMessageRange: (_args: SubscribeMessageRangeArgs) => {
      throw new Error("subscribeMessageRange is not supported by the test harness");
    },
    UNSTABLE_subscribeMessageRange: (_args: SubscribeMessageRangeArgs) => {
      throw new Error("UNSTABLE_subscribeMessageRange is not supported by the test harness");
    },
  });

  const cleanupPanel = initPanel(context);
  let mounted = true;

  const harness: PanelHarness = {
    element,
    context,
    watchedFields,
    get subscriptions() {
      return subscriptions;
    },
    get appSettingsSubscriptions() {
      return appSettingsSubscriptions;
    },
    get savedState() {
      return savedState;
    },
    get settingsTree() {
      return settingsTree;
    },
    get defaultTitle() {
      return defaultTitle;
    },
    parameters,
    variables,
    get sharedPanelState() {
      return sharedPanelState;
    },
    get previewTime() {
      return previewTime;
    },
    seeks,
    advertisements,
    published,
    addedPanels,

    async render(state: RenderState = {}) {
      const onRender = context.onRender;
      if (onRender == undefined) {
        throw new Error(
          "The panel has not set context.onRender, so Foxglove would never render it",
        );
      }
      const fields = Object.keys(state) as (keyof RenderState)[];
      const watchedGivenFields = fields.filter((field) => watchedFields.has(field));
      if (fields.length > 0 && watchedGivenFields.length === 0) {
        throw new Error(
          `The panel does not watch any of [${fields.join(", ")}], so Foxglove would not render it. Watched fields: [${[...watchedFields].join(", ")}]`,
        );
      }
      if (watchedFields.has("currentFrame")) {
        renderState.currentFrame = undefined;
      }
      for (const field of watchedGivenFields) {
        Object.assign(renderState, { [field]: state[field] });
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `The panel did not call done() within ${renderTimeoutMs}ms of a render. Foxglove shows a delayed panel warning and stops rendering it until done() is called.`,
            ),
          );
        }, renderTimeoutMs);
        onRender(renderState, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },

    performSettingsAction(action: SettingsTreeAction) {
      if (settingsTree == undefined) {
        throw new Error("The panel has not called context.updatePanelSettingsEditor");
      }
      settingsTree.actionHandler(action);
    },

    unmount() {
      if (!mounted) {
        return;
      }
      mounted = false;
      mountedPanels.delete(harness);
      if (typeof cleanupPanel === "function") {
        cleanupPanel();
      }
      element.remove();
    },
  };

  mountedPanels.add(harness);

  const deadline = performance.now() + renderTimeoutMs;
  while (context.onRender == undefined && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return harness;
}

/** Unmount every panel created by {@link renderPanel} that is still mounted. */
export function cleanup(): void {
  // Deleting the visited entry while iterating a Set is safe; unmount removes each panel.
  for (const panel of mountedPanels) {
    panel.unmount();
  }
}

type AnyRegisterMessageConverterArgs =
  | RegisterMessageConverterArgs
  | LegacyRegisterMessageConverterArgs
  | RegisterMessageConverterArgsSchema
  | RegisterMessageConverterArgsTopic;

/** An `ExtensionContext` created by {@link createExtensionContext} and what was registered on it. */
export interface ExtensionHarness {
  /** The context to pass to the extension's `activate` function. */
  readonly context: ExtensionContext;
  /** Registered panels, keyed by name. */
  readonly panels: ReadonlyMap<string, ExtensionPanelRegistration>;
  /** Registered message converters, in registration order. */
  readonly messageConverters: readonly AnyRegisterMessageConverterArgs[];
  /** Registered topic alias functions, in registration order. */
  readonly topicAliasFunctions: readonly TopicAliasFunction[];
}

/**
 * Create an `ExtensionContext` that records what an extension registers, for testing its
 * `activate` function.
 *
 * @example
 * ```ts
 * const extension = createExtensionContext();
 * activate(extension.context);
 * expect([...extension.panels.keys()]).toEqual(["example-panel"]);
 * ```
 */
export function createExtensionContext(
  options: { readonly mode?: ExtensionContext["mode"] } = {},
): ExtensionHarness {
  const panels = new Map<string, ExtensionPanelRegistration>();
  const messageConverters: AnyRegisterMessageConverterArgs[] = [];
  const topicAliasFunctions: TopicAliasFunction[] = [];

  const context = mockEveryMember<ExtensionContext>({
    mode: options.mode ?? "test",
    registerPanel: (registration: ExtensionPanelRegistration) => {
      if (panels.has(registration.name)) {
        throw new Error(`A panel named "${registration.name}" is already registered`);
      }
      panels.set(registration.name, registration);
    },
    registerMessageConverter: (args: AnyRegisterMessageConverterArgs) => {
      messageConverters.push(args);
    },
    registerTopicAliases: (aliasFunction: TopicAliasFunction) => {
      topicAliasFunctions.push(aliasFunction);
    },
  });

  return { context, panels, messageConverters, topicAliasFunctions };
}

/**
 * Build a `MessageEvent` for render state such as `currentFrame`, filling in fields that tests
 * rarely care about.
 */
export function makeMessageEvent<T>(
  topic: string,
  message: T,
  fields: Partial<Omit<MessageEvent<T>, "topic" | "message">> = {},
): MessageEvent<T> {
  return {
    topic,
    message,
    schemaName: fields.schemaName ?? "",
    receiveTime: fields.receiveTime ?? { sec: 0, nsec: 0 },
    publishTime: fields.publishTime,
    sizeInBytes: fields.sizeInBytes ?? 0,
    originalMessageEvent: fields.originalMessageEvent,
  };
}
