import {
  BasicShadowMap,
  DepthTexture,
  HalfFloatType,
  Mesh,
  MeshNormalMaterial,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
  type Texture,
} from 'three';
import { POST_FRAGMENT, POST_VERTEX } from './postShader';

export interface PixelSettings {
  palette: boolean;
  outline: boolean;
  dither: boolean;
}

const DITHER_STRENGTH = 0.05;
/** Minimum depth jump, in world units, that counts as a silhouette edge. */
const OUTLINE_THRESHOLD = 0.12;
const NORMAL_EDGE_STRENGTH = 0.35;
/** Extra texels rendered on each side to hide the sub-texel scroll shift. */
const MARGIN_TEXELS = 1;

function createTarget(withDepth: boolean): WebGLRenderTarget {
  const target = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    generateMipmaps: false,
  });
  if (withDepth) target.depthTexture = new DepthTexture(1, 1);
  return target;
}

/**
 * Renders the scene at a low internal resolution (color + depth, then normals),
 * runs the 8-bit post shader, and lets CSS upscale the canvas by an integer factor
 * with `image-rendering: pixelated`.
 */
export class PixelPipeline {
  readonly renderer: WebGLRenderer;
  readonly settings: PixelSettings = { palette: false, outline: true, dither: false };
  readonly size = new Vector2(1, 1);
  private readonly origin = new Vector2();
  private pixelScale = 1;

  private readonly colorTarget = createTarget(true);
  private readonly normalTarget = createTarget(false);
  private readonly normalMaterial = new MeshNormalMaterial();
  private readonly postScene = new Scene();
  private readonly postCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly postMaterial: ShaderMaterial;

  constructor(private readonly canvas: HTMLCanvasElement, palette: Texture, paletteSize: number) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = BasicShadowMap;
    // Shadows are rendered once per frame for the color pass, not again for normals.
    this.renderer.shadowMap.autoUpdate = false;

    this.postMaterial = new ShaderMaterial({
      vertexShader: POST_VERTEX,
      fragmentShader: POST_FRAGMENT,
      defines: { PALETTE_SIZE: paletteSize },
      uniforms: {
        tColor: { value: this.colorTarget.texture },
        tDepth: { value: this.colorTarget.depthTexture },
        tNormal: { value: this.normalTarget.texture },
        tPalette: { value: palette },
        resolution: { value: this.size },
        depthRange: { value: 1 },
        outlineThreshold: { value: OUTLINE_THRESHOLD },
        normalEdgeStrength: { value: NORMAL_EDGE_STRENGTH },
        ditherStrength: { value: DITHER_STRENGTH },
        usePalette: { value: 1 },
        useOutline: { value: 1 },
        useDither: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), this.postMaterial);
    quad.frustumCulled = false;
    this.postScene.add(quad);
  }

  resize(viewportWidth: number, viewportHeight: number, pixelScale: number): void {
    // A spare texel on every side, so shifting the canvas by a sub-texel never shows an edge.
    const width = Math.max(1, Math.floor(viewportWidth / pixelScale)) + 2 * MARGIN_TEXELS;
    const height = Math.max(1, Math.floor(viewportHeight / pixelScale)) + 2 * MARGIN_TEXELS;
    this.size.set(width, height);
    this.pixelScale = pixelScale;
    this.renderer.setSize(width, height, false);
    this.canvas.style.width = `${width * pixelScale}px`;
    this.canvas.style.height = `${height * pixelScale}px`;
    // Whole-pixel centering keeps every upscaled texel the same size.
    this.origin.set(Math.round((viewportWidth - width * pixelScale) / 2), Math.round((viewportHeight - height * pixelScale) / 2));
    this.shiftBySubTexel(0, 0);
    this.colorTarget.setSize(width, height);
    this.normalTarget.setSize(width, height);
  }

  /**
   * Slides the upscaled canvas by the camera's sub-texel remainder (texels along
   * screen right/up), so scrolling moves in screen pixels rather than whole texels.
   */
  shiftBySubTexel(rightTexels: number, upTexels: number): void {
    const x = this.origin.x - Math.round(rightTexels * this.pixelScale);
    const y = this.origin.y + Math.round(upTexels * this.pixelScale);
    this.canvas.style.transform = `translate(${x}px, ${y}px)`;
  }

  render(scene: Scene, camera: OrthographicCamera): void {
    const renderer = this.renderer;

    renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(this.colorTarget);
    renderer.render(scene, camera);

    const previousOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.normalMaterial;
    renderer.setRenderTarget(this.normalTarget);
    renderer.render(scene, camera);
    scene.overrideMaterial = previousOverride;

    const uniforms = this.postMaterial.uniforms;
    uniforms.depthRange.value = camera.far - camera.near;
    uniforms.usePalette.value = this.settings.palette ? 1 : 0;
    uniforms.useOutline.value = this.settings.outline ? 1 : 0;
    uniforms.useDither.value = this.settings.dither ? 1 : 0;

    renderer.setRenderTarget(null);
    renderer.render(this.postScene, this.postCamera);
  }
}
