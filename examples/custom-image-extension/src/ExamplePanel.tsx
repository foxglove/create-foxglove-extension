import { PanelExtensionContext, Topic, MessageEvent } from "@lichtblick/suite";
import { CompressedImage } from "@foxglove/schemas";
import { useLayoutEffect, useEffect, useState, useRef, useMemo } from "react";
import { createRoot } from "react-dom/client";

import DynamicIconComponent from "./DynamicIconComponent";
import PngIcon from "./icon.png";
import SvgIcon from "./icon.svg";

type ImageMessage = MessageEvent<CompressedImage>;

type PanelState = {
  topic?: string;
};

// Draws the compressed image data into our canvas.
async function drawImageOnCanvas(imgData: Uint8Array, canvas: HTMLCanvasElement, format: string) {
  const ctx = canvas.getContext("2d");
  if (ctx == undefined) {
    return;
  }

  // Create a bitmap from our raw compressed image data.
  const blob = new Blob([imgData], { type: `image/${format}` });
  const bitmap = await createImageBitmap(blob);

  // Adjust for aspect ratio.
  canvas.width = Math.round((canvas.height * bitmap.width) / bitmap.height);

  // Draw the image.
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  ctx.resetTransform();
}

function ExamplePanel({ context }: { context: PanelExtensionContext }): JSX.Element {
  const [topics, setTopics] = useState<readonly Topic[] | undefined>();
  const [message, setMessage] = useState<ImageMessage>();

  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Restore our state from the layout via the context.initialState property.
  const [state, setState] = useState<PanelState>(() => {
    return context.initialState as PanelState;
  });

  // Filter all of our topics to find the ones with a CompresssedImage message.
  const imageTopics = useMemo(
    () => (topics ?? []).filter((topic) => topic.schemaName === "sensor_msgs/CompressedImage"),
    [topics],
  );

  useEffect(() => {
    // Save our state to the layout when the topic changes.
    context.saveState({ topic: state.topic });

    if (state.topic) {
      // Subscribe to the new image topic when a new topic is chosen.
      context.subscribe([{ topic: state.topic }]);
    }
  }, [context, state.topic]);

  // Choose our first available image topic as a default once we have a list of topics available.
  useEffect(() => {
    if (state.topic == undefined) {
      setState({ topic: imageTopics[0]?.name });
    }
  }, [state.topic, imageTopics]);

  // Every time we get a new image message draw it to the canvas.
  useEffect(() => {
    if (message) {
      drawImageOnCanvas(message.message.data, canvasRef.current!, message.message.format).catch(
        (error) => {
          console.log(error);
        },
      );
    }
  }, [message]);

  // Setup our onRender function and start watching topics and currentFrame for messages.
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setTopics(renderState.topics);

      // Save the most recent message on our image topic.
      if (renderState.currentFrame && renderState.currentFrame.length > 0) {
        setMessage(renderState.currentFrame[renderState.currentFrame.length - 1] as ImageMessage);
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
  }, [context]);

  // Call our done function at the end of each render.
  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  return (
    <div style={{ height: "100%", padding: "1rem" }}>
      <div style={{ paddingBottom: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <label>Choose a topic to render:</label>
        <select
          value={state.topic}
          onChange={(event) => {
            setState({ topic: event.target.value });
          }}
          style={{ flex: 1 }}
        >
          {imageTopics.map((topic) => (
            <option key={topic.name} value={topic.name}>
              {topic.name}
            </option>
          ))}
        </select>
        <img src={PngIcon} style={{ width: "1.5rem", height: "1.5rem" }} />
        <img src={SvgIcon} style={{ width: "1.5rem", height: "1.5rem" }} />
        <DynamicIconComponent fill="red" width="1rem" height="1rem" />
        <DynamicIconComponent fill="green" />
        <DynamicIconComponent fill="blue" width="2rem" height="2rem" />
      </div>
      <canvas width={480} height={480} ref={canvasRef} />
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
