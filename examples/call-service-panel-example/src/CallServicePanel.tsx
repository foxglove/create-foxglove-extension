import { PanelExtensionContext, RenderState } from "@lichtblick/suite";
import { useCallback, useEffect, useLayoutEffect, useState, ReactElement } from "react";
import { createRoot } from "react-dom/client";
import ReactJson from "react-json-view";

type State = {
  serviceName: string;
  request: string;
  response?: unknown;
  error?: Error | undefined;
  colorScheme?: RenderState["colorScheme"];
};

function CallServicePanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [state, setState] = useState<State>({ serviceName: "", request: "{}" });

  useLayoutEffect(() => {
    context.watch("colorScheme");

    context.onRender = (renderState, done) => {
      setState((oldState) => ({ ...oldState, colorScheme: renderState.colorScheme }));
      setRenderDone(() => done);
    };
  }, [context]);

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
          src={state.error ? { error: state.error.message } : (state.response ?? {})}
          indentWidth={2}
          enableClipboard={false}
          theme={state.colorScheme === "dark" ? "monokai" : "rjv-default"}
          displayDataTypes={false}
        />
      </div>
    </div>
  );
}

export function initCallServicePanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);

  root.render(<CallServicePanel context={context} />);

  // Return a function to run when the panel is removed
  return () => {
    root.unmount();
  };
}
