import {
  Immutable,
  MessageEvent,
  PanelExtensionContext,
  Topic as RosTopic,
  SettingsTreeAction,
  SettingsTreeNode,
} from "@foxglove/extension";
import ReactJson, { ThemeKeys } from "@microlink/react-json-view";
import { produce } from "immer";
import { set } from "lodash";
import { useEffect, useLayoutEffect, useState, useCallback, useMemo, ReactElement } from "react";
import { createRoot } from "react-dom/client";

const ThemeOptions = [
  "apathy",
  "apathy:inverted",
  "ashes",
  "bespin",
  "brewer",
  "bright:inverted",
  "bright",
  "chalk",
  "codeschool",
  "colors",
  "eighties",
  "embers",
  "flat",
  "google",
  "grayscale",
  "grayscale:inverted",
  "greenscreen",
  "harmonic",
  "hopscotch",
  "isotope",
  "marrakesh",
  "mocha",
  "monokai",
  "ocean",
  "paraiso",
  "pop",
  "railscasts",
  "rjv-default",
  "shapeshifter",
  "shapeshifter:inverted",
  "solarized",
  "summerfruit",
  "summerfruit:inverted",
  "threezerotwofour",
  "tomorrow",
  "tube",
  "twilight",
].map((key) => ({ value: key, label: key }));

type PanelTopic = {
  id: string;
  label: string;
  topic?: string;
  visible: boolean;
};

// This is the type of state we will use to render the panel and also
// persist to the layout.
type State = {
  topics: PanelTopic[];
  appearance: {
    displayDataTypes: boolean;
    indentWidth: string;
    theme: string;
  };
};

const generateTopicId = (): string =>
  `data-source-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const createTopic = (partial?: Partial<PanelTopic>, fallbackLabel?: string): PanelTopic => {
  const topicName = partial?.topic;
  const resolvedLabel =
    partial?.label ??
    (topicName && topicName.length > 0 ? topicName : undefined) ??
    fallbackLabel ??
    "Topic";

  return {
    id: partial?.id ?? generateTopicId(),
    label: resolvedLabel,
    topic: topicName ?? "/pose",
    visible: partial?.visible ?? true,
  };
};

const buildInitialTopics = (
  partialState: Partial<State> & { data?: Partial<PanelTopic> },
): PanelTopic[] => {
  if (partialState.topics && partialState.topics.length > 0) {
    return partialState.topics.map((topicEntry) => createTopic(topicEntry, topicEntry.label));
  }

  const data = partialState.data ?? {};
  return [createTopic(data, data.label ?? data.topic ?? "Topic 1")];
};

function ExamplePanel(props: { context: PanelExtensionContext }): ReactElement {
  const { context } = props;
  const [availableTopics, setAvailableTopics] = useState<undefined | Immutable<RosTopic[]>>();
  const [messages, setMessages] = useState<undefined | Immutable<MessageEvent[]>>();

  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  // Build our panel state from the context's initialState, filling in any possibly missing values.
  const [state, setState] = useState<State>(() => {
    const partialState = context.initialState as Partial<State> & { data?: Partial<PanelTopic> };
    return {
      topics: buildInitialTopics(partialState),
      appearance: {
        displayDataTypes: partialState.appearance?.displayDataTypes ?? true,
        theme: partialState.appearance?.theme ?? "rjv-default",
        indentWidth: partialState.appearance?.indentWidth ?? "2",
      },
    };
  });

  // Respond to actions from the settings editor to update our state.
  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      if (action.action === "update") {
        const { path, value } = action.payload;
        if (path[0] === "topics") {
          const topicId = path[1];
          const property = path[2] as keyof PanelTopic | undefined;
          if (!topicId || !property) {
            return;
          }

          setState((previousState) =>
            produce(previousState, (draft) => {
              const targetIndex = draft.topics.findIndex((entry) => entry.id === topicId);
              if (targetIndex === -1) {
                return;
              }
              (draft.topics[targetIndex] as Record<string, unknown>)[property] = value as never;
            }),
          );
        }

        // We use a combination of immer and lodash to produce a new state object so react will
        // re-render our panel for other settings.
        setState(produce((draft) => set(draft, path, value)));
      }

      if (action.action === "perform-node-action") {
        const { id: actionId, path } = action.payload;

        if (actionId === "add-topic") {
          setState((previousState) =>
            produce(previousState, (draft) => {
              const nextIndex = draft.topics.length + 1;
              const defaultTopicName = availableTopics?.[0]?.name ?? "/pose";
              draft.topics.push(
                createTopic(
                  {
                    topic: defaultTopicName,
                  },
                  `Topic ${nextIndex}`,
                ),
              );
            }),
          );
          return;
        }

        if (path[0] !== "topics") {
          return;
        }

        const targetId = path[1];
        if (!targetId) {
          return;
        }

        if (actionId === "remove-topic") {
          setState((previousState) =>
            produce(previousState, (draft) => {
              draft.topics = draft.topics.filter((entry) => entry.id !== targetId);
            }),
          );
          return;
        }

        if (actionId === "move-topic-up" || actionId === "move-topic-down") {
          const offset = actionId === "move-topic-up" ? -1 : 1;
          setState((previousState) =>
            produce(previousState, (draft) => {
              const currentIndex = draft.topics.findIndex((entry) => entry.id === targetId);
              if (currentIndex === -1) {
                return;
              }
              const nextIndex = currentIndex + offset;
              if (nextIndex < 0 || nextIndex >= draft.topics.length) {
                return;
              }
              const [movedEntry] = draft.topics.splice(currentIndex, 1);
              if (!movedEntry) {
                return;
              }
              draft.topics.splice(nextIndex, 0, movedEntry);
            }),
          );
        }
      }
    },
    [availableTopics],
  );

  // Update the settings editor every time our state or the list of available topics changes.
  useEffect(() => {
    context.saveState(state);

    const topicOptions = (availableTopics ?? []).map((topic) => ({
      value: topic.name,
      label: topic.name,
    }));

    // We set up our settings tree to mirror the shape of our panel state so we
    // can use the paths to values from the settings tree to directly update our state.
    context.updatePanelSettingsEditor({
      actionHandler,
      nodes: {
        topics: {
          label: "Topics",
          icon: "Folder",
          actions: [
            {
              type: "action",
              id: "add-topic",
              label: "Add topic",
              icon: "Add",
              display: "inline",
            },
          ],
          enableVisibilityFilter: true,
          children: state.topics.reduce<Record<string, SettingsTreeNode>>(
            (nodeMap, topicEntry, index) => {
              nodeMap[topicEntry.id] = {
                label: topicEntry.label,
                renamable: true,
                visible: topicEntry.visible,
                icon: "Cube",
                order: index,
                actions: [
                  {
                    type: "action",
                    id: "move-topic-up",
                    label: "Move up",
                    icon: "MoveUp",
                    disabled: index === 0,
                  },
                  {
                    type: "action",
                    id: "move-topic-down",
                    label: "Move down",
                    icon: "MoveDown",
                    disabled: index === state.topics.length - 1,
                  },
                  { type: "divider" },
                  {
                    type: "action",
                    id: "remove-topic",
                    label: "Remove",
                    icon: "Delete",
                  },
                ],
                fields: {
                  topic: {
                    label: "Topic",
                    input: "select",
                    options: topicOptions,
                    value: topicEntry.topic,
                  },
                },
              };
              return nodeMap;
            },
            {},
          ),
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
  }, [context, actionHandler, state, availableTopics]);

  // We use a layout effect to setup render handling for our panel. We also setup some topic
  // subscriptions.
  useLayoutEffect(() => {
    // The render handler is invoked by Foxglove during playback when your panel needs
    // to render because the fields it is watching have changed. How you handle rendering depends on
    // your framework. You can only setup one render handler - usually early on in setting up your
    // panel.  Without a render handler your panel will never receive updates.  The render handler
    // could be invoked as often as 60hz during playback if fields are changing often.
    context.onRender = (renderState, done) => {
      // render functions receive a _done_ callback. You MUST call this callback to indicate your
      // panel has finished rendering. Your panel will not receive another render callback until
      // _done_ is called from a prior render. If your panel is not done rendering before the next
      // render call, Foxglove shows a notification to the user that your panel is delayed.  Set the
      // done callback into a state variable to trigger a re-render.
      setRenderDone(() => done);

      // We may have new topics - since we are also watching for messages in the current frame,
      // topics may not have changed It is up to you to determine the correct action when state has
      // not changed.
      setAvailableTopics(renderState.topics);

      // currentFrame has messages on subscribed topics since the last render call
      if (renderState.currentFrame) {
        setMessages(renderState.currentFrame);
      }
    };

    // After adding a render handler, you must indicate which fields from RenderState will trigger
    // updates. If you do not watch any fields then your panel will never render since the panel
    // context will assume you do not want any updates.

    // tell the panel context that we care about any update to the _topic_ field of RenderState
    context.watch("topics");

    // tell the panel context we want messages for the current frame for topics we've subscribed to
    // This corresponds to the _currentFrame_ field of render state.
    context.watch("currentFrame");
  }, [context]);

  useEffect(() => {
    const uniqueTopics = Array.from(
      new Set(
        state.topics
          .map((topicEntry) => topicEntry.topic)
          .filter((topicName): topicName is string => Boolean(topicName)),
      ),
    );

    if (uniqueTopics.length > 0) {
      context.subscribe(uniqueTopics.map((topicName) => ({ topic: topicName })));
    }
  }, [context, state.topics]);

  // invoke the done callback once the render is complete
  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  const messagesByTopic = useMemo(() => {
    const groupedMessages: Record<string, MessageEvent[]> = {};
    if (!messages) {
      return groupedMessages;
    }

    for (const messageEvent of messages) {
      const existingMessages = groupedMessages[messageEvent.topic] ?? [];
      existingMessages.push(messageEvent);
      groupedMessages[messageEvent.topic] = existingMessages;
    }

    return groupedMessages;
  }, [messages]);

  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", maxHeight: "100%" }}>
      <h2>{state.topics.length > 0 ? "Topics" : "Add a topic in settings"}</h2>
      <div
        style={{
          overflowY: "auto",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        {state.topics.length === 0 ? (
          <p style={{ margin: 0 }}>Use the settings sidebar to add your first topic.</p>
        ) : (
          state.topics.map((topicEntry) => {
            const topicMessages = topicEntry.topic ? messagesByTopic[topicEntry.topic] : undefined;
            return (
              <div
                key={topicEntry.id}
                style={{
                  border: "1px solid #e0e0e0",
                  borderRadius: "0.5rem",
                  padding: "0.75rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                <h3 style={{ margin: 0 }}>{topicEntry.label}</h3>
                {!topicEntry.topic ? (
                  <p style={{ margin: 0 }}>Choose a topic in settings for this entry.</p>
                ) : topicMessages && topicMessages.length > 0 ? (
                  <ReactJson
                    src={topicMessages}
                    displayDataTypes={state.appearance.displayDataTypes}
                    theme={state.appearance.theme as ThemeKeys}
                    indentWidth={Number(state.appearance.indentWidth)}
                  />
                ) : (
                  <p style={{ margin: 0 }}>No messages received for {topicEntry.topic} yet.</p>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function initExamplePanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<ExamplePanel context={context} />);

  // Return a function to run when the panel is removed
  return () => {
    root.unmount();
  };
}
