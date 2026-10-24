import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { OfficeCamera } from './officeCamera';

const PPU = 32;
const makeCamera = () => new OfficeCamera({ pixelsPerUnit: PPU, yawDeg: 28, pitchDeg: 58, distance: 40 });

describe('OfficeCamera.follow', () => {
  it('glides toward the goal instead of jumping to it', () => {
    const camera = makeCamera();
    camera.follow(new Vector3(10, 0, 0), 1 / 60);
    expect(camera.target.x).toBeGreaterThan(0);
    expect(camera.target.x).toBeLessThan(1);
  });

  it('settles on the goal without overshooting, at any frame rate', () => {
    for (const fps of [30, 60, 144]) {
      const camera = makeCamera();
      let previous = 0;
      for (let frame = 0; frame < fps * 3; frame++) {
        camera.follow(new Vector3(10, 0, 4), 1 / fps);
        expect(camera.target.x).toBeGreaterThanOrEqual(previous);
        expect(camera.target.x).toBeLessThanOrEqual(10);
        previous = camera.target.x;
      }
      expect(camera.target.x).toBeCloseTo(10, 2);
      expect(camera.target.z).toBeCloseTo(4, 2);
    }
  });
});

describe('OfficeCamera.follow with a screen offset', () => {
  it('puts the goal left of center by the offset, so side panels do not cover it', () => {
    const camera = makeCamera();
    for (let frame = 0; frame < 600; frame++) camera.follow(new Vector3(5, 0, 5), 1 / 60, 2);
    camera.update();
    const right = new Vector3().setFromMatrixColumn(camera.camera.matrixWorld, 0);
    const goalFromTarget = new Vector3(5, 0, 5).sub(camera.target);
    expect(goalFromTarget.dot(right)).toBeCloseTo(-2, 3);
  });
});

describe('OfficeCamera.update', () => {
  /** The eye position the camera would have without snapping, rebuilt from snapped eye + remainder. */
  function unsnappedEyeOffset(camera: OfficeCamera): Vector3 {
    const right = new Vector3().setFromMatrixColumn(camera.camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.camera.matrixWorld, 1);
    return camera.camera.position.clone()
      .addScaledVector(right, camera.subTexel.x / PPU)
      .addScaledVector(up, camera.subTexel.y / PPU)
      .sub(camera.target);
  }

  it('reports the sub-texel remainder the snap threw away, within half a texel', () => {
    const camera = makeCamera();
    for (let step = 0; step < 50; step++) {
      camera.target.set(3 + step * 0.0137, 0, 5 - step * 0.0091);
      camera.update();
      expect(Math.abs(camera.subTexel.x)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(camera.subTexel.y)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it('snapped eye plus the remainder sits at a fixed offset from the true target', () => {
    const camera = makeCamera();
    camera.target.set(7.123, 0, 3.456);
    camera.update();
    const first = unsnappedEyeOffset(camera);
    camera.target.set(2.987, 0, 9.001);
    camera.update();
    expect(unsnappedEyeOffset(camera).distanceTo(first)).toBeLessThan(1e-9);
  });
});
