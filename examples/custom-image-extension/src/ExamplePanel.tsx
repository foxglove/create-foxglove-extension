import { PanelExtensionContext, RenderState, Topic, MessageEvent } from "@foxglove/studio";
import { useLayoutEffect, useEffect, useState, useRef, useMemo } from "react";
import ReactDOM from "react-dom";
import { CompressedImage } from "@foxglove/schemas/schemas/typescript";
import PngIcon from "./icon.png";
import SvgIcon from "./icon.svg";
import DynamicIconComponent from "./DynamicIconComponent";

type ImageMessage = MessageEvent<CompressedImage>;

// Draws the compressed image data into our canvas.
async function drawImageOnCanvas(imgData: Uint8Array, canvas: HTMLCanvasElement, format: string) {
  const ctx = canvas.getContext("2d");
  if (ctx == undefined) return;

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

  const [imageTopic, setImageTopic] = useState<undefined | string>();

  // Filter all of our topics to find the ones with a CompresssedImage message.
  const imageTopics = useMemo(
    () => (topics ?? []).filter((topic) => topic.datatype === "sensor_msgs/CompressedImage"),
    [topics],
  );

  // Subscribe to the new image topic when a new topic is chosen.
  useEffect(() => {
    if (imageTopic) {
      context.subscribe([imageTopic]);
    }
  }, [imageTopic]);

  // Choose our first available image topic as a default once we have a list of topics available.
  useEffect(() => {
    if (imageTopic == undefined) {
      setImageTopic(imageTopics[0]?.name);
    }
  }, [imageTopic, imageTopics]);

  // Every time we get a new image message draw it to the canvas.
  useEffect(() => {
    if (message) {
      drawImageOnCanvas(message.message.data, canvasRef.current!, message.message.format).catch(
        (error) => console.log(error),
      );
    }
  }, [message]);

  // Setup our onRender function and start watching topics and currentFrame for messages.
  useLayoutEffect(() => {
    context.onRender = (renderState: RenderState, done) => {
      setRenderDone(() => done);
      setTopics(renderState.topics);

      // Save the most recent message on our image topic.
      if (renderState.currentFrame && renderState.currentFrame.length > 0) {
        setMessage(renderState.currentFrame[renderState.currentFrame.length - 1] as ImageMessage);
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
  }, []);

  // Call our done function at the end of each render.
  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  return (
    <div style={{ height: "100%", padding: "1rem" }}>
      <div style={{ paddingBottom: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <label>Choose a topic to render:</label>
        <select
          value={imageTopic}
          onChange={(event) => setImageTopic(event.target.value)}
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

export function initExamplePanel(context: PanelExtensionContext) {
  ReactDOM.render(<ExamplePanel context={context} />, context.panelElement);
}
