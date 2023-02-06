import { PanelExtensionContext, RenderState } from "@foxglove/studio";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import ReactDOM from "react-dom";
import ReactJson from "react-json-view";

type State = {
  serviceName: string;
  request: string;
  response?: unknown;
  error?: Error | undefined;
  colorScheme?: RenderState["colorScheme"];
};

function CallServicePanel({ context }: { context: PanelExtensionContext }): JSX.Element {
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [state, setState] = useState<State>({ serviceName: "", request: "{}" });

  useLayoutEffect(() => {
    context.onRender = (renderState: RenderState, done) => {
      setState((oldState) => ({ ...oldState, colorScheme: renderState.colorScheme }));
      setRenderDone(() => done);
    };
  }, [context]);

  context.watch("colorScheme");

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  const callService = useCallback(
    async (serviceName: string, request: string) => {
      if (!context.callService) {
        return;
      }

      try {
        const response = await context.callService(serviceName, JSON.parse(request));
        JSON.stringify(response); // Attempt serializing the response, to throw an error on failure
        setState((oldState) => ({
          ...oldState,
          response,
          error: undefined,
        }));
      } catch (error) {
        setState((oldState) => ({ ...oldState, error: error as Error }));
        console.error(error);
      }
    },
    [context.callService],
  );

  return (
    <div style={{ padding: "1rem" }}>
      <h2>Call service</h2>
      {context.callService == undefined && (
        <p style={{ color: "red" }}>Calling services is not supported by this connection</p>
      )}

      <h4>Service name</h4>
      <div>
        <input
          type="text"
          placeholder="Enter service name"
          style={{ width: "100%" }}
          value={state.serviceName}
          onChange={(event) => {
            setState({ ...state, serviceName: event.target.value });
          }}
        />
      </div>
      <h4>Request</h4>
      <div>
        <textarea
          style={{ width: "100%", minHeight: "3rem" }}
          value={state.request}
          onChange={(event) => {
            setState({ ...state, request: event.target.value });
          }}
        />
      </div>
      <div>
        <button
          disabled={context.callService == undefined || state.serviceName === ""}
          style={{ width: "100%", minHeight: "2rem" }}
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          onClick={async () => {
            await callService(state.serviceName, state.request);
          }}
        >
          {`Call ${state.serviceName}`}
        </button>
      </div>

      <div>
        <h4>Response</h4>
        <ReactJson
          name={null}
          src={state.error ? { error: state.error.message } : state.response ?? {}}
          indentWidth={2}
          enableClipboard={false}
          theme={state.colorScheme === "dark" ? "monokai" : "rjv-default"}
          displayDataTypes={false}
        />
      </div>
    </div>
  );
}

export function initCallServicePanel(context: PanelExtensionContext): void {
  ReactDOM.render(<CallServicePanel context={context} />, context.panelElement);
}
