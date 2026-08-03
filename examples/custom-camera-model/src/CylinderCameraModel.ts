import { CustomCameraInfo, CameraModel, Vec2, Vec3 } from "@lichtblick/suite";

/**
 * A cylindrical camera model that can be used to rectify, unrectify, and project pixel coordinates.
 *
 * In this model the image is assumed to be formed by projecting the scene onto a cylindrical surface.
 * The intrinsic matrix `K` represents the parameters of the raw (cylindrically distorted) image,
 * while the projection matrix `P` relates to the processed cylindrical projection.
 */
export class CylinderCameraModel implements CameraModel {
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

  public constructor(customCameraInfo: CustomCameraInfo, name: string) {
    console.log(`[${name}] 🔧 Constructor called`);
    this.name = name;
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
    console.log(`[${name}] ✅ Constructor completed successfully`);
  }

  /**
   * Undoes camera distortion to map a given coordinate from normalized raw image coordinates to
   * normalized undistorted coordinates.
   *
   * This method uses an iterative optimization algorithm to undo the distortion that was applied to
   * the original image and yields an approximation of the undistorted point.
   *
   * @param out - The output vector to receive the undistorted 2D normalized coordinate.
   * @param point - The input distorted 2D normalized coordinate.
   * @param iterations - The number of iterations to use in the iterative optimization.
   * @returns The undistorted pixel, a reference to `out`.
   */
  public undistortNormalized(out: Vec2, point: Vec2, iterations = 5): Vec2 {
    const { D } = this;
    const [k1, k2, p1, p2, k3, k4, k5, k6] = D;
    let x = point.x;
    let y = point.y;
    const x0 = x;
    const y0 = y;
    const count = k1 !== 0 || k2 !== 0 || p1 !== 0 || p2 !== 0 || k3 !== 0 ? iterations : 1;
    for (let i = 0; i < count; ++i) {
      const xx = x * x;
      const yy = y * y;
      const xy = x * y;
      const r2 = xx + yy;
      const r4 = r2 * r2;
      const r6 = r4 * r2;
      const cdist = 1 + k1! * r2 + k2! * r4 + k3! * r6;
      const icdist = (1 + k4! * r2 + k5! * r4 + k6! * r6) / cdist;
      const deltaX = 2 * p1! * xy + p2! * (r2 + 2 * xx);
      const deltaY = p1! * (r2 + 2 * yy) + 2 * p2! * xy;
      x = (x0 - deltaX) * icdist;
      y = (y0 - deltaY) * icdist;
    }
    out.x = x;
    out.y = y;
    return out;
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
    // Undo distortion (like PintorCameraModel does)
    this.undistortNormalized(out, out);
    out.z = 1.0;
    // Apply cylindrical projection
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
