import { ExtensionContext } from "@foxglove/studio";

export function activate(extensionContext: ExtensionContext): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
  (extensionContext as any).registerTopicMapper(
    ({
      topics: _,
      globalVariables,
    }: {
      topics: string[];
      globalVariables: Record<string, string>;
    }) => {
      console.log({ globalVariables });
      const varVal = globalVariables["foo"] ?? "back";
      return new Map([
        ["/CAM_FRONT/image_rect_compressed", ["/remapped_cam_front/image_rect_compressed"]],
        ["/CAM_FRONT/camera_info", ["/remapped_cam_front/camera_info"]],
        ["/CAM_BACK/image_rect_compressed", [`/remapped_cam_${varVal}/image_rect_compressed`]],
        ["/CAM_BACK/camera_info", [`/remapped_cam_${varVal}/camera_info`]],
      ]);
    },
  );
}
