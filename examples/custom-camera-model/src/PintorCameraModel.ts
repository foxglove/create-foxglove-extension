// SPDX-FileCopyrightText: Copyright (C) 2023-2025 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { CustomCameraInfo, CameraModel, Vec2, Vec3 } from "@lichtblick/suite";

/**
 * A pinhole camera model that can be used to rectify, unrectify, and project pixel coordinates.
 * Based on `ROSPinholeCameraModel` from the ROS `image_geometry` package. See
 * <http://docs.ros.org/diamondback/api/image_geometry/html/c++/pinhole__camera__model_8cpp_source.html>
 *
 * See also <http://wiki.ros.org/image_pipeline/CameraInfo>
 */
export class PintorCameraModel implements CameraModel {
  // Mostly copied from `fromCameraInfo`
  // <http://docs.ros.org/diamondback/api/image_geometry/html/c++/pinhole__camera__model_8cpp_source.html#l00064>
  public name: string;
  public fx: number;
  public fy: number;
  public cx: number;
  public cy: number;
  public D: number[];
  public K: number[];
  public P: number[];
  public R: number[];
  public width: number;
  public height: number;

  public constructor(customCameraInfo: CustomCameraInfo) {
    this.name = "pintor_camera_model";
    const { binning_x, binning_y, roi, distortion_model, D, K, P, R, width, height } =
      customCameraInfo;
    const fx = K[0];
    const fy = K[4];
    this.fx = K[0] ?? 0;
    this.fy = K[4] ?? 0;
    this.cx = K[2] ?? 0;
    this.cy = K[5] ?? 0;
    if (width <= 0 || height <= 0) {
      throw new Error(`Invalid image size ${width}x${height}`);
    }
    if (distortion_model.length > 0 && distortion_model !== this.name) {
      throw new Error(`Unrecognized distortion_model "${distortion_model}"`);
    }
    if (K.length !== 0 && K.length !== 9) {
      throw new Error(`K.length=${K.length}, expected 9`);
    }
    if (fx === 0 || fy === 0) {
      throw new Error(`Invalid focal length (fx=${fx}, fy=${fy})`);
    }
    const D8 = [...D];
    while (D8.length < 8) {
      D8.push(0);
    }
    this.D = D8;
    this.K = K.length === 9 ? K : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.P = P;
    this.R = R.length === 9 ? R : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.width = width;
    this.height = height;
    // Binning = 0 is considered the same as binning = 1 (no binning).
    const binningX = binning_x !== 0 ? binning_x : 1;
    const binningY = binning_y !== 0 ? binning_y : 1;
    const adjustBinning = binningX > 1 || binningY > 1;
    const adjustRoi = roi.x_offset !== 0 || roi.y_offset !== 0;
    if (adjustBinning || adjustRoi) {
      throw new Error(
        "Failed to initialize camera model: unable to handle adjusted binning and adjusted roi camera models.",
      );
    }
  }

  /**
   * Projects a 2D image pixel onto a 3D point on the unit cylinder.
   *
   * This function first removes the effect of the intrinsic parameters to obtain normalized
   * coordinates. It then maps the horizontal coordinate to an angle (in radians) around the
   * cylinder and computes the corresponding 3D point on a cylindrical surface at unit distance.
   *
   * @param out - The output vector to receive the 3D point coordinates.
   * @param pixel - The 2D image pixel coordinate.
   * @returns The 3D point on the unit cylinder corresponding to the input pixel.
   */
  public projectPixelTo3dPlane(out: Vec3, pixel: Vec2): Vec3 {
    const { K } = this;
    const fx = K[0]!;
    const fy = K[4]!;
    const cx = K[2]!;
    const cy = K[5]!;
    // Undo K to get normalized coordinates
    out.x = (pixel.x - cx) / fx;
    out.y = (pixel.y - cy) / fy;
    out.z = 1.0;
    const theta = out.x;
    out.x = Math.sin(theta);
    out.z = Math.cos(theta);
    return out;
  }

  /**
   * Projects a 2D image pixel into a normalized 3D ray direction for the cylindrical camera model.
   *
   * This function first maps the pixel to a point on the unit cylinder using the intrinsic
   * parameters and cylindrical geometry, then normalizes the resulting vector to yield a
   * unit-length direction.
   *
   * @param out - The output vector to receive the 3D ray direction.
   * @param pixel - The 2D image pixel coordinate.
   * @returns The normalized 3D ray direction corresponding to the input pixel.
   */
  public projectPixelTo3dRay(out: Vec3, pixel: Vec2): Vec3 {
    this.projectPixelTo3dPlane(out, pixel);
    // Normalize the ray direction
    const invNorm = 1.0 / Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
    out.x *= invNorm;
    out.y *= invNorm;
    out.z *= invNorm;
    return out;
  }
}
