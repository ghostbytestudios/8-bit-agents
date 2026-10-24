import { MathUtils, OrthographicCamera, Vector3 } from 'three';

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

  update(): void {
    const texel = 1 / this.options.pixelsPerUnit;
    const alongRight = this.target.dot(this.right);
    const alongUp = this.target.dot(this.up);
    this.snapped
      .copy(this.target)
      .addScaledVector(this.right, Math.round(alongRight / texel) * texel - alongRight)
      .addScaledVector(this.up, Math.round(alongUp / texel) * texel - alongUp);
    this.camera.position.copy(this.snapped).add(this.offset);
    this.camera.updateMatrixWorld();
  }
}
