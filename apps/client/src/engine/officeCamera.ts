import { MathUtils, OrthographicCamera, Vector2, Vector3 } from 'three';

/** How quickly the follow camera catches up (1/s); higher is snappier. */
const FOLLOW_SHARPNESS = 5;

export interface OfficeCameraOptions {
  /** Low-res texels per world unit (one floor tile = one unit). */
  pixelsPerUnit: number;
  yawDeg: number;
  pitchDeg: number;
  distance: number;
}

/**
 * Fixed-angle orthographic camera that snaps to the texel grid so the
 * pixelated image doesn't shimmer while panning.
 */
export class OfficeCamera {
  readonly camera: OrthographicCamera;
  readonly target = new Vector3();
  /**
   * What the texel snap threw away, in texels along screen right/up (each within ±0.5).
   * Shifting the upscaled canvas by this restores smooth scrolling without shimmer.
   */
  readonly subTexel = new Vector2();

  private readonly offset: Vector3;
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly groundForward: Vector3;
  private readonly groundRight: Vector3;
  private readonly snapped = new Vector3();
  private readonly sinPitch: number;
  private bounds: { minX: number; minZ: number; maxX: number; maxZ: number } | null = null;

  constructor(private readonly options: OfficeCameraOptions) {
    const yaw = MathUtils.degToRad(options.yawDeg);
    const pitch = MathUtils.degToRad(options.pitchDeg);
    this.sinPitch = Math.sin(pitch);
    this.offset = new Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    ).multiplyScalar(options.distance);
    this.groundForward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.groundRight = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, options.distance * 2);
    this.camera.position.copy(this.offset);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.up.setFromMatrixColumn(this.camera.matrixWorld, 1);
  }

  setViewport(lowResWidth: number, lowResHeight: number): void {
    const halfWidth = lowResWidth / this.options.pixelsPerUnit / 2;
    const halfHeight = lowResHeight / this.options.pixelsPerUnit / 2;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Keep the camera target inside a floor rectangle. */
  setBounds(minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.bounds = { minX, minZ, maxX, maxZ };
  }

  /** Pan along the floor in screen-relative directions. */
  pan(rightAmount: number, forwardAmount: number): void {
    this.target.addScaledVector(this.groundRight, rightAmount);
    this.target.addScaledVector(this.groundForward, forwardAmount);
    if (this.bounds) {
      this.target.x = MathUtils.clamp(this.target.x, this.bounds.minX, this.bounds.maxX);
      this.target.z = MathUtils.clamp(this.target.z, this.bounds.minZ, this.bounds.maxZ);
    }
  }

  /** Drag the floor with the pointer: deltas are in low-res texels, so the floor tracks the cursor. */
  dragBy(deltaXTexels: number, deltaYTexels: number): void {
    const unitsPerTexel = 1 / this.options.pixelsPerUnit;
    // Screen-vertical motion is foreshortened by the camera tilt.
    this.pan(-deltaXTexels * unitsPerTexel, (deltaYTexels * unitsPerTexel) / this.sinPitch);
  }

  /**
   * Ease the target toward `goal` (frame-rate independent exponential damping), so a
   * followed agent's stops, turns and sit-down snaps don't jerk the whole view.
   * `screenRightOffset` (world units) aims the camera that far to the goal's screen-right.
   */
  follow(goal: Vector3, dt: number, screenRightOffset = 0): void {
    // Offsetting along screen-right keeps the goal centered in the part of the view
    // that isn't covered by side panels.
    const goalX = goal.x + this.groundRight.x * screenRightOffset;
    const goalZ = goal.z + this.groundRight.z * screenRightOffset;
    const blend = 1 - Math.exp(-FOLLOW_SHARPNESS * dt);
    this.target.x += (goalX - this.target.x) * blend;
    this.target.z += (goalZ - this.target.z) * blend;
  }

  update(): void {
    const texel = 1 / this.options.pixelsPerUnit;
    const alongRight = this.target.dot(this.right);
    const alongUp = this.target.dot(this.up);
    const snappedRight = Math.round(alongRight / texel) * texel;
    const snappedUp = Math.round(alongUp / texel) * texel;
    this.subTexel.set((alongRight - snappedRight) / texel, (alongUp - snappedUp) / texel);
    this.snapped
      .copy(this.target)
      .addScaledVector(this.right, snappedRight - alongRight)
      .addScaledVector(this.up, snappedUp - alongUp);
    this.camera.position.copy(this.snapped).add(this.offset);
    this.camera.updateMatrixWorld();
  }
}
