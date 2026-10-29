/** A mocked response for requests that an extension makes with `fetch` or `XMLHttpRequest`. */
export interface NetworkRoute {
  /** The method to match, such as `"POST"`. Matches every method when left out. */
  readonly method?: string;
  /** The full URL to match, or a pattern to test the full URL against. */
  readonly url: string | RegExp;
  /**
   * Returns the response. Return a `Response`, or any other value to send it as JSON, or nothing
   * for an empty 204 response. It may return a promise, and throw to make the request fail like a
   * network error.
   */
  readonly respond: (request: Request) => unknown;
}

/**
 * Network options for {@link simulateFoxglove}.
 *
 * Requests the page makes with `fetch` and `XMLHttpRequest` get responses from `routes`. Requests
 * to other servers that no route answers fail, and so do WebSocket and EventSource connections to
 * other servers. Requests to the test server itself, and `data:` and `blob:` URLs, go through.
 *
 * Images, stylesheets, and fonts that the page loads from other servers, and requests from inside a
 * Web Worker, are not intercepted.
 */
export interface NetworkOptions {
  /** Mocked responses. The first route that matches a request answers it. */
  readonly routes?: readonly NetworkRoute[];
  /**
   * Let requests and connections that no route answers through to the real network. Defaults to
   * false, so a test fails instead of depending on a real server.
   */
  readonly allowUnmocked?: boolean;
}

/**
 * A request to another server that the page made with `fetch` or `XMLHttpRequest` while Foxglove
 * was simulated. Requests to the test server, and `data:` and `blob:` URLs, are not recorded.
 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /** A copy of the request, so tests can read its body. */
  readonly request: Request;
  /** True if a route answered it, false if it went to the network or was blocked. */
  readonly mocked: boolean;
}

export interface NetworkInterceptor {
  readonly options: NetworkOptions;
  readonly requests: RecordedRequest[];
  /** Lets the simulation wait for responses that are still on their way */
  track?: (promise: Promise<unknown>) => void;
  /** Tells the simulation about a request that was blocked */
  blocked?: (message: string) => void;
}

/** Functions this module installs, so that it never saves its own patches as originals */
const ourFunctions = new WeakSet();

// Saved when the first simulation starts and put back when the last one closes, so that the
// page gets back exactly what it had, including spies a test installed first
let originals:
  | { fetch: typeof fetch; WebSocket: typeof WebSocket; EventSource: typeof EventSource }
  | undefined;
let lastOriginals: typeof originals;
ourFunctions.add(interceptedFetch);

async function realFetch(request: Request): Promise<Response> {
  return await (originals?.fetch ?? fetch).call(globalThis, request);
}
/** The XMLHttpRequest methods the page had when the first simulation started */
interface XhrMethods {
  open: XMLHttpRequest["open"];
  send: XMLHttpRequest["send"];
  setRequestHeader: XMLHttpRequest["setRequestHeader"];
  abort: XMLHttpRequest["abort"];
}

// Read when the first simulation starts rather than when this module loads, so that the module
// can be imported where there is no XMLHttpRequest, such as in Node
let realXhr: XhrMethods | undefined;

function savedXhrMethods(): XhrMethods {
  // Called with an XMLHttpRequest as `this`, through `call`
  /* eslint-disable @typescript-eslint/unbound-method */
  const prototype = XMLHttpRequest.prototype;
  const current = {
    open: prototype.open,
    send: prototype.send,
    setRequestHeader: prototype.setRequestHeader,
    abort: prototype.abort,
  };
  /* eslint-enable @typescript-eslint/unbound-method */
  // Left in place by a spy that restored them after a simulation closed
  return ourFunctions.has(current.open) && realXhr != undefined ? realXhr : current;
}

function xhrMethods(): XhrMethods {
  if (realXhr == undefined) {
    throw new Error("XMLHttpRequest is not intercepted");
  }
  return realXhr;
}
const interceptors: NetworkInterceptor[] = [];

function matches(route: NetworkRoute, request: Request): boolean {
  // fetch keeps the case of methods other than the standard ones, such as PATCH
  if (route.method != undefined && route.method.toUpperCase() !== request.method.toUpperCase()) {
    return false;
  }
  if (typeof route.url === "string") {
    return URL.canParse(route.url, location.href)
      ? new URL(route.url, location.href).href === request.url
      : false;
  }
  // A pattern with the g or y flag remembers where it last matched
  route.url.lastIndex = 0;
  return route.url.test(request.url);
}

async function toResponse(value: unknown): Promise<Response> {
  const resolved = await Promise.resolve(value);
  if (resolved instanceof Response) {
    return resolved;
  }
  return resolved === undefined ? new Response(null, { status: 204 }) : Response.json(resolved);
}

/** The test server, and data and blob URLs such as inlined assets, never reach a backend */
function isLocal(url: URL): boolean {
  return url.host === location.host || url.protocol === "data:" || url.protocol === "blob:";
}

type Decision =
  | { kind: "mock"; respond: () => Promise<Response> }
  | { kind: "pass" }
  | { kind: "block"; message: string };

/** Decide how to answer a request, and record it with the simulation that answers it */
function decide(request: Request, transport: string): Decision {
  // The most recently started simulation takes precedence
  for (const interceptor of [...interceptors].reverse()) {
    const route = interceptor.options.routes?.find((candidate) => matches(candidate, request));
    if (route != undefined) {
      interceptor.requests.push({
        method: request.method,
        url: request.url,
        request: request.clone(),
        mocked: true,
      });
      // A route that throws, even synchronously, fails the request like a network error
      const response = Promise.resolve()
        .then(() => route.respond(request))
        .then(toResponse);
      interceptor.track?.(response.catch(() => undefined));
      return { kind: "mock", respond: async () => await response };
    }
  }
  const interceptor = interceptors[interceptors.length - 1];
  // Requests that stay local, such as for the extension's assets, are not recorded
  if (isLocal(new URL(request.url)) || interceptor == undefined) {
    return { kind: "pass" };
  }
  interceptor.requests.push({
    method: request.method,
    url: request.url,
    request: request.clone(),
    mocked: false,
  });
  if (interceptor.options.allowUnmocked === true) {
    return { kind: "pass" };
  }
  const message = `No mocked response for ${request.method} ${request.url} (${transport}). Add a route to the network option of simulateFoxglove(), or set network.allowUnmocked to reach the real server.`;
  interceptor.blocked?.(message);
  return { kind: "block", message };
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The operation was aborted.", "AbortError");
}

async function interceptedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  if (request.signal.aborted) {
    throw abortError(request.signal);
  }
  const decision = decide(request, "fetch");
  switch (decision.kind) {
    case "mock":
      // Like a real request, a mocked one stops when its signal aborts
      return await new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          reject(abortError(request.signal));
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        decision
          .respond()
          .then(resolve, (caught: unknown) => {
            reject(
              new TypeError(
                `The mocked response for ${request.method} ${request.url} failed: ${caught instanceof Error ? caught.message : String(caught)}`,
                { cause: caught },
              ),
            );
          })
          .finally(() => {
            request.signal.removeEventListener("abort", onAbort);
          });
      });
    case "block":
      throw new TypeError(decision.message);
    case "pass": {
      const response = realFetch(request);
      interceptors[interceptors.length - 1]?.track?.(response.catch(() => undefined));
      return await response;
    }
  }
}

interface XhrState {
  method: string;
  url: string;
  async: boolean;
  headers: Headers;
  aborted: boolean;
  /** True while the simulation answers the request, rather than the real network */
  inFlight: boolean;
}

/** Properties set on an XMLHttpRequest the simulation answered, in place of the real ones */
const XHR_RESULT_KEYS = [
  "readyState",
  "status",
  "statusText",
  "response",
  "responseText",
  "responseURL",
  "getResponseHeader",
  "getAllResponseHeaders",
];

const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();

function defineValues(target: object, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(target, key, { value, configurable: true });
  }
}

function dispatchXhrEvents(xhr: XMLHttpRequest, names: readonly string[]): void {
  for (const name of names) {
    xhr.dispatchEvent(
      name === "readystatechange"
        ? new Event(name)
        : new ProgressEvent(name, { lengthComputable: false }),
    );
  }
}

/** Finish a request that a route answered, as if the response came from the network */
async function completeXhr(
  xhr: XMLHttpRequest,
  state: XhrState,
  response: Response,
): Promise<void> {
  let body: unknown;
  let text = "";
  switch (xhr.responseType) {
    case "":
    case "text":
      text = await response.text();
      body = text;
      break;
    case "json":
      text = await response.text();
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
      break;
    case "arraybuffer":
      body = await response.arrayBuffer();
      break;
    case "blob":
      body = await response.blob();
      break;
    case "document":
      body = null;
      break;
  }
  if (state.aborted) {
    return;
  }
  const headers = response.headers;
  defineValues(xhr, {
    readyState: XMLHttpRequest.DONE,
    status: response.status,
    statusText: response.statusText,
    response: body,
    responseText: text,
    responseURL: state.url,
    getResponseHeader: (name: string) => headers.get(name),
    getAllResponseHeaders: () =>
      [...headers.entries()].map(([name, value]) => `${name}: ${value}\r\n`).join(""),
  });
  dispatchXhrEvents(xhr, ["readystatechange", "load", "loadend"]);
}

function failXhr(xhr: XMLHttpRequest, state: XhrState): void {
  if (state.aborted) {
    return;
  }
  defineValues(xhr, { readyState: XMLHttpRequest.DONE, status: 0, statusText: "" });
  dispatchXhrEvents(xhr, ["readystatechange", "error", "loadend"]);
}

function interceptXhr(): void {
  realXhr = savedXhrMethods();
  XMLHttpRequest.prototype.open = function open(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    // A reused request shows the real properties again until the simulation answers it
    for (const key of XHR_RESULT_KEYS) {
      Reflect.deleteProperty(this, key);
    }
    xhrStates.set(this, {
      method: method.toUpperCase(),
      url: new URL(url, location.href).href,
      async: async ?? true,
      headers: new Headers(),
      aborted: false,
      inFlight: false,
    });
    xhrMethods().open.call(this, method, url, async ?? true, username, password);
  };
  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    xhrStates.get(this)?.headers.append(name, value);
    xhrMethods().setRequestHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.abort = function abort(this: XMLHttpRequest): void {
    const state = xhrStates.get(this);
    xhrMethods().abort.call(this);
    // Aborting a request that the simulation is not answering changes nothing here
    if (state?.inFlight !== true) {
      return;
    }
    state.aborted = true;
    state.inFlight = false;
    // Like a real request, it moves to DONE and fires its events, then resets to UNSENT
    defineValues(this, { readyState: XMLHttpRequest.DONE, status: 0, statusText: "" });
    dispatchXhrEvents(this, ["readystatechange", "abort", "loadend"]);
    defineValues(this, { readyState: XMLHttpRequest.UNSENT });
  };
  XMLHttpRequest.prototype.send = function send(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const state = xhrStates.get(this);
    if (state == undefined) {
      xhrMethods().send.call(this, body);
      return;
    }
    const hasBody = state.method !== "GET" && state.method !== "HEAD" && body != undefined;
    const request = new Request(state.url, {
      method: state.method,
      headers: state.headers,
      body: hasBody && !(body instanceof Document) ? body : undefined,
    });
    const decision = decide(request, "XMLHttpRequest");
    if (decision.kind === "pass") {
      xhrMethods().send.call(this, body);
      return;
    }
    if (!state.async) {
      throw new DOMException(
        `The simulated Foxglove cannot answer the synchronous XMLHttpRequest to ${state.url}`,
        "NetworkError",
      );
    }
    state.aborted = false;
    state.inFlight = true;
    const finish = (
      decision.kind === "mock"
        ? decision
            .respond()
            .then(async (response) => {
              await completeXhr(this, state, response);
            })
            .catch(() => {
              failXhr(this, state);
            })
        : Promise.resolve().then(() => {
            failXhr(this, state);
          })
    ).finally(() => {
      state.inFlight = false;
    });
    interceptors[interceptors.length - 1]?.track?.(finish);
  };
  /* eslint-disable @typescript-eslint/unbound-method */
  for (const method of [
    XMLHttpRequest.prototype.open,
    XMLHttpRequest.prototype.send,
    XMLHttpRequest.prototype.setRequestHeader,
    XMLHttpRequest.prototype.abort,
  ]) {
    ourFunctions.add(method);
  }
  /* eslint-enable @typescript-eslint/unbound-method */
}

function restoreXhr(): void {
  if (realXhr != undefined) {
    Object.assign(XMLHttpRequest.prototype, realXhr);
  }
}

/** Refuse connections to other servers, which the simulation cannot answer */
function guardConnection<T extends abstract new (...args: never[]) => object>(
  Real: T,
  transport: string,
): T {
  const guarded = new Proxy(Real, {
    construct(target, args: unknown[], newTarget) {
      const url = new URL(String(args[0]), location.href);
      const interceptor = interceptors[interceptors.length - 1];
      if (!isLocal(url) && interceptor != undefined && interceptor.options.allowUnmocked !== true) {
        const message = `The simulated Foxglove blocked a ${transport} connection to ${url.href}. Tests cannot reach other servers, so mock the code that opens it, or set network.allowUnmocked.`;
        interceptor.blocked?.(message);
        throw new Error(message);
      }
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  ourFunctions.add(guarded);
  return guarded;
}

/** Route network requests through the given options until the returned function is called */
export function interceptNetwork(options: NetworkOptions): {
  interceptor: NetworkInterceptor;
  restore: () => void;
} {
  for (const route of options.routes ?? []) {
    if (typeof route.url === "string" && !URL.canParse(route.url, location.href)) {
      throw new Error(`The network route URL "${route.url}" is not a valid URL`);
    }
  }
  const interceptor: NetworkInterceptor = { options, requests: [] };
  if (interceptors.length === 0) {
    // A spy restored after a simulation closed can leave this module's functions in place
    const previous = originals ?? lastOriginals;
    originals = {
      fetch: ourFunctions.has(globalThis.fetch) && previous ? previous.fetch : globalThis.fetch,
      WebSocket:
        ourFunctions.has(globalThis.WebSocket) && previous
          ? previous.WebSocket
          : globalThis.WebSocket,
      EventSource:
        ourFunctions.has(globalThis.EventSource) && previous
          ? previous.EventSource
          : globalThis.EventSource,
    };
    lastOriginals = originals;
    globalThis.fetch = interceptedFetch;
    interceptXhr();
    globalThis.WebSocket = guardConnection(originals.WebSocket, "WebSocket");
    globalThis.EventSource = guardConnection(originals.EventSource, "EventSource");
  }
  interceptors.push(interceptor);
  return {
    interceptor,
    restore: () => {
      const index = interceptors.indexOf(interceptor);
      if (index !== -1) {
        interceptors.splice(index, 1);
      }
      if (interceptors.length === 0 && originals != undefined) {
        globalThis.fetch = originals.fetch;
        restoreXhr();
        globalThis.WebSocket = originals.WebSocket;
        globalThis.EventSource = originals.EventSource;
        originals = undefined;
      }
    },
  };
}
