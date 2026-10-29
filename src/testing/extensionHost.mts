import type {
  Experimental,
  ExtensionContext,
  ExtensionPanelRegistration,
  RegisterMessageConverterArgs,
  RegisterMessageConverterArgsSchema,
  RegisterMessageConverterArgsTopic,
  TopicAliasFunction,
} from "@foxglove/extension";

/**
 * Arguments of `registerDataLoader` in `Experimental.ExtensionContext`. Declared here, rather than
 * imported, so that the harness works with versions of `@foxglove/extension` that predate it.
 */
export interface DataLoaderRegistration {
  readonly type: string;
  readonly wasmUrl: string;
  readonly supportedFileType: string;
  readonly supportsMultiFile?: boolean;
}

/** Arguments of `registerUserScriptUtility` in `Experimental.ExtensionContext` */
export interface UserScriptUtilityRegistration {
  readonly name: string;
  readonly source: string;
}

/** Arguments of `registerVideoDecoder` in `Experimental.ExtensionContext` */
export interface VideoDecoderRegistration {
  readonly id: string;
  readonly displayName: string;
  readonly decoderBuilderSource: string;
}

/** What an extension registered in its `activate` function. */
export interface ExtensionRegistrations {
  /** Registered panels, keyed by name. */
  readonly panels: ReadonlyMap<string, ExtensionPanelRegistration>;
  /** Every message converter, in registration order, as the extension passed it. */
  readonly messageConverters: readonly RegisterMessageConverterArgs[];
  /**
   * Schema converters, in registration order. Converters registered without a `type`, which is
   * deprecated, are schema converters and appear here with `type: "schema"`.
   */
  readonly schemaConverters: readonly RegisterMessageConverterArgsSchema[];
  /** Topic converters, in registration order. */
  readonly topicConverters: readonly RegisterMessageConverterArgsTopic[];
  /** Topic alias functions, in registration order. */
  readonly topicAliasFunctions: readonly TopicAliasFunction[];
  /** Data loaders, in registration order. */
  readonly dataLoaders: readonly DataLoaderRegistration[];
  /** User script utilities, in registration order. */
  readonly userScriptUtilities: readonly UserScriptUtilityRegistration[];
  /** Video decoders, in registration order. */
  readonly videoDecoders: readonly VideoDecoderRegistration[];
  /**
   * Calls to `register*` methods that this version of the harness does not know about, such as
   * methods added to `@foxglove/extension` later, keyed by method name.
   */
  readonly otherRegistrations: ReadonlyMap<string, readonly (readonly unknown[])[]>;
  /**
   * Registrations that Foxglove ignores with a warning, such as a second panel with the same name.
   */
  readonly warnings: readonly string[];
}

/** An `ExtensionContext` created by {@link createExtensionContext} and what was registered on it. */
export interface ExtensionHarness<
  Context extends ExtensionContext = ExtensionContext,
> extends ExtensionRegistrations {
  /**
   * The context to pass to the extension's `activate` function. It also implements
   * `Experimental.ExtensionContext`. To pass it to an `activate` function that takes that type,
   * call `createExtensionContext<Experimental.ExtensionContext>()`.
   */
  readonly context: Context;
}

/** Options for {@link createExtensionContext}. */
export interface ExtensionContextOptions {
  /** Value of `context.mode`. Defaults to `"production"`, which is what Foxglove passes. */
  readonly mode?: ExtensionContext["mode"];
}

/**
 * Returns `mock` unchanged. It fails to compile unless `mock` defines every member of `T`,
 * including optional ones, so that the harness is updated whenever the extension API grows.
 */
export function mockEveryMember<T>(mock: T & Record<keyof T, unknown>): T {
  return mock;
}

/** The schema of a topic converter's output, including from the deprecated `schemaName` */
export function outputSchemaName(converter: RegisterMessageConverterArgsTopic): string {
  // Extensions written before outputSchemaName existed set only schemaName
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-deprecated
  return converter.outputSchemaName ?? converter.schemaName ?? "";
}

/** Names of the utilities that Foxglove provides to user scripts, which extensions cannot reuse */
const BUILT_IN_USER_SCRIPT_UTILITIES = new Set([
  "pointclouds.ts",
  "quaternions.ts",
  "readers.ts",
  "time.ts",
  "types.ts",
  "vectors.ts",
  "markers.ts",
  "generatedtypes.ts",
]);

/**
 * Create an `ExtensionContext` that records what an extension registers, for testing its
 * `activate` function. Registrations follow Foxglove's rules: for example, a second panel with
 * the same name is ignored with a warning, and an invalid user script utility name throws.
 *
 * {@link simulateFoxglove} uses the same context, and also runs the extension's panels,
 * converters, and topic aliases against a simulated data source.
 *
 * @example
 * ```ts
 * const extension = createExtensionContext();
 * activate(extension.context);
 * expect([...extension.panels.keys()]).toEqual(["example-panel"]);
 * ```
 *
 * For an extension whose `activate` takes `Experimental.ExtensionContext`, such as a data loader:
 *
 * ```ts
 * const extension = createExtensionContext<Experimental.ExtensionContext>();
 * activate(extension.context);
 * expect(extension.dataLoaders).toHaveLength(1);
 * ```
 */
export function createExtensionContext<Context extends ExtensionContext = ExtensionContext>(
  options: ExtensionContextOptions = {},
): ExtensionHarness<Context> {
  const panels = new Map<string, ExtensionPanelRegistration>();
  const messageConverters: RegisterMessageConverterArgs[] = [];
  const schemaConverters: RegisterMessageConverterArgsSchema[] = [];
  const topicConverters: RegisterMessageConverterArgsTopic[] = [];
  const topicAliasFunctions: TopicAliasFunction[] = [];
  const dataLoaders: DataLoaderRegistration[] = [];
  const userScriptUtilities: UserScriptUtilityRegistration[] = [];
  const videoDecoders: VideoDecoderRegistration[] = [];
  const otherRegistrations = new Map<string, unknown[][]>();
  const warnings: string[] = [];

  const knownMembers = mockEveryMember<Experimental.ExtensionContext>({
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    mode: options.mode ?? "production",
    registerPanel: (registration: ExtensionPanelRegistration) => {
      if (panels.has(registration.name)) {
        warnings.push(
          `Panel "${registration.name}" is already registered. Foxglove keeps the first registration and ignores this one.`,
        );
        return;
      }
      panels.set(registration.name, registration);
    },
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    registerMessageConverter: (args: RegisterMessageConverterArgs) => {
      if (!("type" in args) || args.type === "schema") {
        messageConverters.push(args);
        schemaConverters.push({ ...args, type: "schema" });
        return;
      }
      // Guards against JavaScript callers, which the types do not cover
      const type: string = args.type;
      if (type !== "topic") {
        throw new Error(`Unknown message converter type: ${type}`);
      }
      const schemaName = outputSchemaName(args);
      if (args.outputSchemaDescription != undefined && schemaName.startsWith("foxglove.")) {
        throw new Error(
          `The topic converter for ${args.outputTopic} sets outputSchemaDescription, but ${schemaName} is a well-known schema that Foxglove already describes.`,
        );
      }
      messageConverters.push(args);
      topicConverters.push(args);
    },
    registerTopicAliases: (aliasFunction: TopicAliasFunction) => {
      topicAliasFunctions.push(aliasFunction);
    },
    registerDataLoader: (args: Experimental.RegisterDataLoaderArgs) => {
      dataLoaders.push(args);
    },
    registerUserScriptUtility: (args: Experimental.RegisterUserScriptUtilityArgs) => {
      if (!/^[a-zA-Z0-9_-]+\.ts$/.test(args.name)) {
        throw new Error(
          `User script utility name "${args.name}" is invalid. Use letters, numbers, dashes, and underscores, ending in .ts, like "my_utility.ts".`,
        );
      }
      const lowerName = args.name.toLowerCase();
      if (BUILT_IN_USER_SCRIPT_UTILITIES.has(lowerName)) {
        throw new Error(
          `User script utility name "${args.name}" is taken by a utility that Foxglove provides.`,
        );
      }
      const existing = userScriptUtilities.find(
        (utility) => utility.name.toLowerCase() === lowerName,
      );
      if (existing != undefined) {
        throw new Error(
          `User script utility name "${args.name}" is already registered as "${existing.name}". Names are compared without regard to case.`,
        );
      }
      userScriptUtilities.push(args);
    },
    registerVideoDecoder: (args: Experimental.RegisterVideoDecoderArgs) => {
      if (videoDecoders.some((decoder) => decoder.id === args.id)) {
        // Foxglove warns and registers it anyway
        warnings.push(`A video decoder with id "${args.id}" is already registered`);
      }
      videoDecoders.push(args);
    },
  });

  // Extensions built against a newer @foxglove/extension can call registration methods that this
  // harness predates. Record those instead of failing with "is not a function".
  const isUnknownRegistration = (target: object, property: string | symbol): property is string =>
    typeof property === "string" && property.startsWith("register") && !(property in target);
  const context = new Proxy(knownMembers, {
    get(target, property, receiver) {
      if (isUnknownRegistration(target, property)) {
        return (...args: unknown[]) => {
          const calls = otherRegistrations.get(property) ?? [];
          calls.push(args);
          otherRegistrations.set(property, calls);
          warnings.push(`${property} is not supported by this version of the test harness`);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
    has(target, property) {
      return isUnknownRegistration(target, property) || Reflect.has(target, property);
    },
  });

  return {
    // The context implements every member of Experimental.ExtensionContext, plus a recorder for
    // newer registration methods, so it satisfies any ExtensionContext type the caller asks for
    context: context as unknown as Context,
    panels,
    messageConverters,
    schemaConverters,
    topicConverters,
    topicAliasFunctions,
    dataLoaders,
    userScriptUtilities,
    videoDecoders,
    otherRegistrations,
    warnings,
  };
}

/** An extension's `activate` function, taking either the stable or the experimental context */
export type ExtensionActivate =
  | ((context: ExtensionContext) => void | Promise<void>)
  | ((context: Experimental.ExtensionContext) => void | Promise<void>);

/**
 * The extension that {@link simulateFoxglove} loads:
 *
 * - Its `activate` function, or the module that exports it, such as
 *   `import * as extension from "./index"`. This runs your source directly, which is fastest.
 * - `{ source }`, the contents of the built `dist/extension.js`. Foxglove loads this file, so it
 *   also tests the bundle: inlined assets and styles, workers, and anything the build changes.
 */
export type ExtensionInput =
  | ExtensionActivate
  | { readonly activate: ExtensionActivate }
  | {
      readonly source: string;
      /**
       * Modules that the bundle's `require` returns, by name. Foxglove provides `react` and
       * `react-dom`. Bundles built by create-foxglove-extension include their own React, so this is
       * only needed for a bundle that leaves React out.
       */
      readonly modules?: Readonly<Record<string, unknown>>;
    };

/**
 * Evaluate a built extension bundle the way Foxglove does: as a CommonJS script with only `module`
 * and `require` in scope.
 */
function loadBundle(
  source: string,
  modules: Readonly<Record<string, unknown>> = {},
): ExtensionActivate {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  const require = (name: string): unknown => modules[name];
  // This is how Foxglove evaluates extension bundles
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
  const evaluate = new Function("module", "require", source) as (
    module: unknown,
    require: unknown,
  ) => void;
  evaluate(module, require);
  // Foxglove calls module.exports.activate, so a bundle without it fails to load there too
  const activate = (module.exports as { activate?: unknown }).activate;
  if (typeof activate !== "function") {
    throw new Error("The extension bundle does not export an activate function");
  }
  return activate as ExtensionActivate;
}

export function resolveActivate(extension: ExtensionInput): ExtensionActivate {
  if (typeof extension === "function") {
    return extension;
  }
  if ("source" in extension) {
    return loadBundle(extension.source, extension.modules);
  }
  return extension.activate;
}

/** Run `activate` against a recording context, as Foxglove does when it loads an extension. */
export async function activateExtension(
  extension: ExtensionInput,
): Promise<ExtensionHarness<Experimental.ExtensionContext>> {
  const harness = createExtensionContext<Experimental.ExtensionContext>();
  await resolveActivate(extension)(harness.context);
  return harness;
}
