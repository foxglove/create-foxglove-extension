import {
  Immutable,
  PanelExtensionContext,
  Topic,
  SettingsTreeAction,
  SettingsTreeNode,
} from "@foxglove/extension";
import { produce } from "immer";
import { useEffect, useLayoutEffect, useState, useCallback, ReactElement } from "react";
import { createRoot } from "react-dom/client";

type PanelTopic = {
  id: string;
  label: string;
  topic?: string;
  visible: boolean;
};

type State = {
  topics: PanelTopic[];
};

const generateTopicId = (): string =>
  `topic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
    topic: topicName,
    visible: partial?.visible ?? true,
  };
};

function ExamplePanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [availableTopics, setAvailableTopics] = useState<undefined | Immutable<Topic[]>>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  const [state, setState] = useState<State>(() => {
    const partialState = context.initialState as Partial<State>;
    return {
      topics:
        partialState.topics && partialState.topics.length > 0
          ? partialState.topics.map((entry) => createTopic(entry, entry.label))
          : [createTopic(undefined, "Topic 1")],
    };
  });

  // The action handler receives actions from the settings editor. We use immer's `produce` function
  // to update nested state immutably. Immer lets us write mutable-style code (like array.push or
  // direct property assignment) while producing a new immutable state object that React can detect
  // as changed.
  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      // "update" actions are dispatched when the user edits a field value, renames a node, or
      // toggles visibility. The path tells us which property changed (e.g. ["topics", "abc123", "topic"]).
      if (action.action === "update") {
        const { path, value } = action.payload;
        if (path[0] !== "topics") {
          return;
        }

        // path[1] is the topic's unique id, path[2] is the property name (label, visible, or topic)
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
            // With immer we can assign directly to the draft - it will produce a new state object
            (draft.topics[targetIndex] as Record<string, unknown>)[property] = value as never;
          }),
        );
      }

      // "perform-node-action" actions are dispatched when the user clicks an action button defined
      // in a node's `actions` array. The actionId identifies which action was clicked.
      if (action.action === "perform-node-action") {
        const { id: actionId, path } = action.payload;

        // "add-topic" is triggered from the parent "Topics" node's inline action button
        if (actionId === "add-topic") {
          setState((previousState) =>
            produce(previousState, (draft) => {
              const nextIndex = draft.topics.length + 1;
              const defaultTopicName = availableTopics?.[0]?.name;
              // With immer we can use push directly - it will produce a new array
              draft.topics.push(createTopic({ topic: defaultTopicName }, `Topic ${nextIndex}`));
            }),
          );
          return;
        }

        // Actions on individual topic nodes have a path like ["topics", "abc123"]
        if (path[0] !== "topics") {
          return;
        }

        const targetId = path[1];
        if (!targetId) {
          return;
        }

        // Remove the topic from the list
        if (actionId === "remove-topic") {
          setState((previousState) =>
            produce(previousState, (draft) => {
              draft.topics = draft.topics.filter((entry) => entry.id !== targetId);
            }),
          );
          return;
        }

        // Reorder topics by swapping with adjacent item
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
              // With immer we can use splice directly to reorder the array
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

    context.updatePanelSettingsEditor({
      actionHandler,
      nodes: {
        topics: {
          label: "Topics",
          icon: "Folder",
          // This inline action adds a new topic when clicked
          actions: [
            {
              type: "action",
              id: "add-topic",
              label: "Add topic",
              icon: "Add",
              display: "inline",
            },
          ],
          // enableVisibilityFilter allows showing/hiding individual topic nodes
          enableVisibilityFilter: true,
          children: state.topics.reduce<Record<string, SettingsTreeNode>>(
            (nodeMap, topicEntry, index) => {
              nodeMap[topicEntry.id] = {
                label: topicEntry.label,
                renamable: true,
                visible: topicEntry.visible,
                icon: "Cube",
                order: index,
                // These actions appear in the node's context menu
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
      },
    });
  }, [context, actionHandler, state, availableTopics]);

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setAvailableTopics(renderState.topics);
    };

    context.watch("topics");
  }, [context]);

  // Invoke the done callback once the render is complete
  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  const visibleTopics = state.topics.filter((entry) => entry.visible);

  return (
    <div
      style={{
        padding: "1.25rem",
        height: "100%",
        boxSizing: "border-box",
        fontFamily: "system-ui, -apple-system, sans-serif",
        overflow: "auto",
      }}
    >
      <h2
        style={{
          margin: "0 0 1rem 0",
          fontSize: "1.1rem",
          fontWeight: 600,
          opacity: 0.9,
        }}
      >
        Configured Topics
      </h2>
      {visibleTopics.length === 0 ? (
        <div
          style={{
            padding: "1.5rem",
            borderRadius: "8px",
            backgroundColor: "rgba(128, 128, 128, 0.1)",
            textAlign: "center",
            color: "rgba(128, 128, 128, 0.8)",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.9rem" }}>
            No visible topics. Add or show topics in the settings sidebar.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {visibleTopics.map((entry, index) => (
            <div
              key={entry.id}
              style={{
                padding: "0.75rem 1rem",
                borderRadius: "6px",
                backgroundColor: "rgba(128, 128, 128, 0.08)",
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <span
                style={{
                  width: "1.5rem",
                  height: "1.5rem",
                  borderRadius: "4px",
                  backgroundColor: "rgba(100, 149, 237, 0.2)",
                  color: "cornflowerblue",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {index + 1}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontWeight: 500,
                    fontSize: "0.9rem",
                    marginBottom: entry.topic ? "0.15rem" : 0,
                  }}
                >
                  {entry.label}
                </div>
                {entry.topic ? (
                  <div
                    style={{
                      fontSize: "0.8rem",
                      opacity: 0.6,
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.topic}
                  </div>
                ) : (
                  <div style={{ fontSize: "0.8rem", opacity: 0.5, fontStyle: "italic" }}>
                    No topic selected
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function initExamplePanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<ExamplePanel context={context} />);

  return () => {
    root.unmount();
  };
}
