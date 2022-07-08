import {
  PanelExtensionContext,
  RenderState,
  Topic,
  MessageEvent,
  SettingsTreeAction,
} from "@foxglove/studio";
import { useLayoutEffect, useEffect, useState, useCallback } from "react";
import ReactDOM from "react-dom";
import { set } from "lodash";
import produce from "immer";
import ReactJson, { ThemeKeys } from "react-json-view";

const ThemeOptions = [
  { value: "apathy", label: "apathy" },
  { value: "apathy:inverted", label: "apathy:inverted" },
  { value: "ashes", label: "ashes" },
  { value: "bespin", label: "bespin" },
  { value: "brewer", label: "brewer" },
  { value: "bright:inverted", label: "bright:inverted" },
  { value: "bright", label: "bright" },
  { value: "chalk", label: "chalk" },
  { value: "codeschool", label: "codeschool" },
  { value: "colors", label: "colors" },
  { value: "eighties", label: "eighties" },
  { value: "embers", label: "embers" },
  { value: "flat", label: "flat" },
  { value: "google", label: "google" },
  { value: "grayscale", label: "grayscale" },
  {
    value: "grayscale:inverted",
    label: "grayscale:inverted",
  },
  { value: "greenscreen", label: "greenscreen" },
  { value: "harmonic", label: "harmonic" },
  { value: "hopscotch", label: "hopscotch" },
  { value: "isotope", label: "isotope" },
  { value: "marrakesh", label: "marrakesh" },
  { value: "mocha", label: "mocha" },
  { value: "monokai", label: "monokai" },
  { value: "ocean", label: "ocean" },
  { value: "paraiso", label: "paraiso" },
  { value: "pop", label: "pop" },
  { value: "railscasts", label: "railscasts" },
  { value: "rjv-default", label: "rjv-default" },
  { value: "shapeshifter", label: "shapeshifter" },
  {
    value: "shapeshifter:inverted",
    label: "shapeshifter:inverted",
  },
  { value: "solarized", label: "solarized" },
  { value: "summerfruit", label: "summerfruit" },
  {
    value: "summerfruit:inverted",
    label: "summerfruit:inverted",
  },
  { value: "threezerotwofour", label: "threezerotwofour" },
  { value: "tomorrow", label: "tomorrow" },
  { value: "tube", label: "tube" },
  { value: "twilight", label: "twilight" },
];

// This is the type of state we will use to render the panel and also
// persist to the layout.
type State = {
  data: {
    topic?: string;
  };
  appearance: {
    displayDataTypes: boolean;
    indentWidth: string;
    theme: string;
  };
};

function ExamplePanel({ context }: { context: PanelExtensionContext }): JSX.Element {
  const [topics, setTopics] = useState<readonly Topic[] | undefined>();
  const [messages, setMessages] = useState<readonly MessageEvent<unknown>[] | undefined>();

  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  // Build our panel state from the context's initialState, filling in any possibly missing values.
  const [state, setState] = useState<State>(() => {
    const partialState = context.initialState as Partial<State>;
    return {
      data: {
        topic: partialState.data?.topic ?? "/pose",
      },
      appearance: {
        displayDataTypes: partialState.appearance?.displayDataTypes ?? true,
        theme: partialState.appearance?.theme ?? "rjv-default",
        indentWidth: partialState.appearance?.indentWidth ?? "2",
      },
    };
  });

  // Respond to actions from the settings editor to update our state.
  const actionHandler = useCallback((action: SettingsTreeAction) => {
    if (action.action === "update") {
      const { path, value } = action.payload;
      // We use a combination of immer and lodash to produce a new state object
      // so react will re-render our panel.
      setState(produce((draft) => set(draft, path, value)));

      // If the topic was changed update our subscriptions.
      if (path[1] === "topic") {
        context.subscribe([value as string]);
      }
    }
  }, []);

  // Update the settings editor every time our state or the list of available topics changes.
  useEffect(() => {
    context.saveState(state);

    const topicOptions = (topics ?? []).map((topic) => ({ value: topic.name, label: topic.name }));

    // We set up our settings tree to mirror the shape of our panel state so we
    // can use the paths to values from the settings tree to directly update our state.
    context.updatePanelSettingsEditor({
      actionHandler,
      nodes: {
        data: {
          label: "Data",
          icon: "Cube",
          fields: {
            topic: {
              label: "Topic",
              input: "select",
              options: topicOptions,
              value: state.data.topic,
            },
          },
        },
        appearance: {
          label: "Appearance",
          icon: "Shapes",
          fields: {
            theme: {
              label: "Theme",
              input: "select",
              value: state.appearance.theme,
              options: ThemeOptions,
            },
            indentWidth: {
              label: "Indent Width",
              input: "select",
              value: state.appearance.indentWidth,
              options: [
                { value: "2", label: "2" },
                { value: "4", label: "4" },
                { value: "8", label: "8" },
              ],
            },
            displayDataTypes: {
              label: "Display DataTypes",
              input: "boolean",
              value: state.appearance.displayDataTypes,
            },
          },
        },
      },
    });
  }, [actionHandler, state, topics]);

  // We use a layout effect to setup render handling for our panel. We also setup some topic subscriptions.
  useLayoutEffect(() => {
    // The render handler is run by the broader studio system during playback when your panel
    // needs to render because the fields it is watching have changed. How you handle rendering depends on your framework.
    // You can only setup one render handler - usually early on in setting up your panel.
    //
    // Without a render handler your panel will never receive updates.
    //
    // The render handler could be invoked as often as 60hz during playback if fields are changing often.
    context.onRender = (renderState: RenderState, done) => {
      // render functions receive a _done_ callback. You MUST call this callback to indicate your panel has finished rendering.
      // Your panel will not receive another render callback until _done_ is called from a prior render. If your panel is not done
      // rendering before the next render call, studio shows a notification to the user that your panel is delayed.
      //
      // Set the done callback into a state variable to trigger a re-render.
      setRenderDone(() => done);

      // We may have new topics - since we are also watching for messages in the current frame, topics may not have changed
      // It is up to you to determine the correct action when state has not changed.
      setTopics(renderState.topics);

      // currentFrame has messages on subscribed topics since the last render call
      if (renderState.currentFrame) {
        if (Array.isArray(renderState.currentFrame)) {
          setMessages(renderState.currentFrame[0]);
        } else {
          setMessages(renderState.currentFrame);
        }
      }
    };

    // After adding a render handler, you must indicate which fields from RenderState will trigger updates.
    // If you do not watch any fields then your panel will never render since the panel context will assume you do not want any updates.

    // tell the panel context that we care about any update to the _topic_ field of RenderState
    context.watch("topics");

    // tell the panel context we want messages for the current frame for topics we've subscribed to
    // This corresponds to the _currentFrame_ field of render state.
    context.watch("currentFrame");

    // Subscribe to our initial topic.
    if (state.data.topic) {
      context.subscribe([state.data.topic]);
    }
  }, []);

  // invoke the done callback once the render is complete
  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", maxHeight: "100%" }}>
      <h2>{state.data.topic ?? "Choose a topic in settings"}</h2>
      <div
        style={{
          overflowY: "auto",
          flex: 1,
        }}
      >
        <ReactJson
          src={messages ?? {}}
          displayDataTypes={state.appearance.displayDataTypes}
          theme={state.appearance.theme as ThemeKeys}
          indentWidth={Number(state.appearance.indentWidth)}
        />
      </div>
    </div>
  );
}

export function initExamplePanel(context: PanelExtensionContext) {
  ReactDOM.render(<ExamplePanel context={context} />, context.panelElement);
}
