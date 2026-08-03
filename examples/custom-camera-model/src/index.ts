import { ExtensionContext } from "@lichtblick/suite";

import { CylinderCameraModel } from "./CylinderCameraModel";
import { PintorCameraModel } from "./PintorCameraModel";

export function activate(ctx: ExtensionContext): void {
  const cameraModels = ["CylinderCameraModel", "pintor_camera_model"];
  ctx.registerCameraModel({
    name: cameraModels[0]!, // must match CameraInfo.distortion_model
    modelBuilder: (info) => new CylinderCameraModel(info, cameraModels[0]!),
  });
  ctx.registerCameraModel({
    name: cameraModels[1]!, // must match CameraInfo.distortion_model
    modelBuilder: (info) => new PintorCameraModel(info),
  });
}
