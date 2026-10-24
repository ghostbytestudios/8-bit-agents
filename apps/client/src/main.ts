import './style.css';
import { EnvelopeSchema, HarnessCommandSchema, type EventFeed, type HarnessCommand } from '@harness/protocol';
import { Color, Mesh, MeshBasicMaterial, RingGeometry, Scene, Vector3, type Camera } from 'three';
import { Choreographer } from './choreo/choreographer';
import { OfficeCamera } from './engine/officeCamera';
import { ENDESGA_32, createPaletteTexture } from './engine/palette';
import { PixelPipeline } from './engine/pixelPipeline';
import { button, el } from './hud/dom';
import { Dock } from './hud/dock';
import { formatCost } from './hud/format';
import { NameTags } from './hud/nameTags';
import { pickActor, type ScreenActor, type ScreenPoint } from './hud/picking';
import { MockRun } from './sim/mockRun';
import { WorldStore } from './state/world';
import { Crowd } from './world/crowd';
import { FRONT_DOOR_OUTSIDE, OFFICE_DEPTH, OFFICE_WIDTH } from './world/layout';
import { buildOffice } from './world/office';

const PIXELS_PER_UNIT = 32;
const MIN_PIXEL_SCALE = 2;
const DEFAULT_ZOOM_LEVEL = 2;
const MAX_ZOOM_LEVEL = 4;
/** Accumulated wheel delta per zoom step, so trackpads don't race through levels. */
const WHEEL_STEP = 50;
const PAN_SPEED = 6;
const MAX_FRAME_DT = 0.1;
const DOOR_OUTSIDE = new Vector3(FRONT_DOOR_OUTSIDE.x, 0, FRONT_DOOR_OUTSIDE.z);
/** True while the office is driven by the in-browser mock rather than real agents. */
const IS_SIMULATED = true;
/** A press that moves less than this (screen px) is a click, not a pan. */
const CLICK_SLOP_PX = 4;
/** How close (in game pixels) a click must land to a character's body to pick it. */
const PICK_RADIUS_GAME_PX = 7;
/** Refreshes "12s ago" labels even when no events arrive. */
const AGE_REFRESH_MS = 1000;
const PAN_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector} element`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#game');
const hud = requireElement<HTMLElement>('#hud');
const topBar = requireElement<HTMLElement>('#topbar');

const pipeline = new PixelPipeline(canvas, createPaletteTexture(ENDESGA_32), ENDESGA_32.length);
const officeCamera = new OfficeCamera({ pixelsPerUnit: PIXELS_PER_UNIT, yawDeg: 28, pitchDeg: 58, distance: 40 });
const officeCenter = new Vector3(OFFICE_WIDTH / 2, 0, OFFICE_DEPTH / 2);
officeCamera.target.copy(officeCenter);
officeCamera.setBounds(0, 0, OFFICE_WIDTH, OFFICE_DEPTH);

const scene = new Scene();
scene.background = new Color('#181425');
const nameTags = new NameTags(document.body);
const world = new WorldStore();

/** Zoom level 1–4 maps to how many screen pixels each game pixel covers (2–5). */
let zoomLevel = DEFAULT_ZOOM_LEVEL;
let pixelScale = MIN_PIXEL_SCALE + zoomLevel - 1;
/** Manual panning hands the camera back to the user. */
let isFollowing = false;

function resize(): void {
  pipeline.resize(window.innerWidth, window.innerHeight, pixelScale);
  officeCamera.setViewport(pipeline.size.x, pipeline.size.y);
}

function setZoom(level: number): void {
  const clamped = Math.min(MAX_ZOOM_LEVEL, Math.max(1, level));
  if (clamped === zoomLevel) return;
  zoomLevel = clamped;
  pixelScale = MIN_PIXEL_SCALE + zoomLevel - 1;
  resize();
  renderHud();
}

function renderHud(): void {
  const flag = (on: boolean) => (on ? 'ON' : '<span class="off">OFF</span>');
  const { palette, outline, dither } = pipeline.settings;
  // Static labels and booleans only; nothing from agents goes through innerHTML.
  hud.innerHTML = [
    '<kbd>CLICK</kbd> INSPECT · <kbd>F</kbd> FOLLOW · <kbd>ESC</kbd> CLOSE',
    '<kbd>I</kbd> INBOX · <kbd>T</kbd> TASKS · <kbd>L</kbd> LOG · <kbd>H</kbd> PANELS',
    `<kbd>DRAG</kbd>/<kbd>WASD</kbd> PAN · <kbd>WHEEL</kbd>/<kbd>1-4</kbd> ZOOM ${zoomLevel}`,
    `<kbd>P</kbd> PALETTE ${flag(palette)} · <kbd>B</kbd> DITHER ${flag(dither)}`,
    `<kbd>O</kbd> OUTLINE ${flag(outline)} · <kbd>N</kbd> NAMES ${flag(nameTags.visible)}`,
    '<kbd>SPACE</kbd> CENTER',
  ].join('<br>');
}

/** Run status comes straight from the world store (exact), not from the animation. */
function createTopBar(onOpenInbox: () => void): () => void {
  const title = el('span', 'topbar__title', IS_SIMULATED ? 'HARNESS · MOCK RUN' : 'HARNESS');
  const status = el('span', 'topbar__status');
  const alert = button('topbar__alert', '', onOpenInbox);
  topBar.append(title, status, alert);
  return () => {
    const { agents, tasks, inbox, totalCostUsd } = world.state;
    const done = [...tasks.values()].filter((task) => task.state === 'done').length;
    // The mock invents token usage; never let a fake number look like a real bill.
    status.textContent = `AGENTS ${agents.size} · TASKS ${done}/${tasks.size} · ${formatCost(totalCostUsd, IS_SIMULATED)}`;
    alert.hidden = inbox.size === 0;
    alert.textContent = `❗ ${inbox.size} WAITING ON YOU`;
  };
}

function toScreen(point: Vector3, camera: Camera): ScreenPoint {
  const rect = canvas.getBoundingClientRect();
  const projected = point.clone().project(camera);
  return { x: rect.left + ((projected.x + 1) / 2) * rect.width, y: rect.top + ((1 - projected.y) / 2) * rect.height };
}

/** Typing an inbox answer must not pan the camera or toggle effects. */
function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

interface InputHandlers {
  onClick(point: ScreenPoint): void;
  /** Returns true when the key was handled. */
  onKey(key: string): boolean;
}

function setupInput(handlers: InputHandlers): () => { right: number; forward: number } {
  let drag: { x: number; y: number } | null = null;
  let pressedAt: ScreenPoint | null = null;
  canvas.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY };
    pressedAt = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    officeCamera.dragBy((event.clientX - drag.x) / pixelScale, (event.clientY - drag.y) / pixelScale);
    drag = { x: event.clientX, y: event.clientY };
    if (pressedAt && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > CLICK_SLOP_PX) {
      pressedAt = null;
      isFollowing = false;
    }
  });
  const endDrag = () => {
    drag = null;
    pressedAt = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', (event) => {
    if (pressedAt) handlers.onClick({ x: event.clientX, y: event.clientY });
    endDrag();
  });
  canvas.addEventListener('pointercancel', endDrag);

  let wheelAccumulator = 0;
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    wheelAccumulator += event.deltaY;
    if (Math.abs(wheelAccumulator) < WHEEL_STEP) return;
    // Scrolling up (negative delta) zooms in.
    setZoom(zoomLevel - Math.sign(wheelAccumulator));
    wheelAccumulator = 0;
  }, { passive: false });

  const pressed = new Set<string>();
  window.addEventListener('keydown', (event) => {
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (handlers.onKey(key)) {
      event.preventDefault();
      return;
    }
    if (PAN_KEYS.includes(key)) isFollowing = false;
    pressed.add(key);
    if (key >= '1' && key <= String(MAX_ZOOM_LEVEL)) {
      setZoom(Number(key));
      return;
    } else if (key === 'p') pipeline.settings.palette = !pipeline.settings.palette;
    else if (key === 'o') pipeline.settings.outline = !pipeline.settings.outline;
    else if (key === 'b') pipeline.settings.dither = !pipeline.settings.dither;
    else if (key === 'n') nameTags.visible = !nameTags.visible;
    else if (key === ' ') {
      isFollowing = false;
      officeCamera.target.copy(officeCenter);
    } else return;
    renderHud();
  });
  window.addEventListener('keyup', (event) => pressed.delete(event.key.toLowerCase()));
  window.addEventListener('blur', () => pressed.clear());

  const axis = (positive: string[], negative: string[]) =>
    (positive.some((k) => pressed.has(k)) ? 1 : 0) - (negative.some((k) => pressed.has(k)) ? 1 : 0);
  return () => ({ right: axis(['d', 'arrowright'], ['a', 'arrowleft']), forward: axis(['w', 'arrowup'], ['s', 'arrowdown']) });
}

/** Flat ring under the selected agent's feet. */
function createSelectionRing(): Mesh {
  const ring = new Mesh(
    new RingGeometry(0.3, 0.38, 20),
    new MeshBasicMaterial({ color: new Color('#feae34'), transparent: true, opacity: 0.9, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 1;
  ring.visible = false;
  return ring;
}

/** Commands leave through the same schema the backend will enforce. */
function sendCommand(feed: EventFeed, command: HarnessCommand): void {
  const parsed = HarnessCommandSchema.safeParse(command);
  if (!parsed.success) {
    console.warn('[feed] refused to send invalid command', parsed.error.issues);
    return;
  }
  feed.send(parsed.data);
}

async function start(): Promise<void> {
  const office = await buildOffice();
  scene.add(office.group);

  const crowd = new Crowd(office.grid);
  const choreographer = new Choreographer({ scene, crowd, spots: office.spots, overlay: nameTags, doorOutside: DOOR_OUTSIDE });
  const ring = createSelectionRing();
  scene.add(ring);
  const feed = new MockRun();

  let selectedId: string | null = null;
  let isRenderQueued = false;
  // Bursts of events collapse into one panel render per frame.
  const renderPanels = () => {
    if (isRenderQueued) return;
    isRenderQueued = true;
    requestAnimationFrame(() => {
      isRenderQueued = false;
      renderTopBar();
      dock.render(world.state, Date.now());
    });
  };
  const select = (id: string | null) => {
    selectedId = id;
    isFollowing = false;
    dock.select(id);
    dock.inspector.setFollowing(false);
    nameTags.setSelected(id);
    renderPanels();
  };
  const toggleFollow = () => {
    isFollowing = selectedId !== null && !isFollowing;
    dock.inspector.setFollowing(isFollowing);
  };
  const dock = new Dock(document.body, {
    onRespond: (requestId, answer) => sendCommand(feed, { type: 'human.respond', requestId, answer }),
    onSelectAgent: select,
    onCloseInspector: () => select(null),
    onToggleFollow: toggleFollow,
  }, IS_SIMULATED);
  nameTags.onSelect = select;
  const renderTopBar = createTopBar(() => dock.openTab('inbox', true));

  // The feed is the system boundary: everything is validated before it touches state.
  feed.subscribe((raw) => {
    const parsed = EnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[feed] dropped invalid event', parsed.error.issues);
      return;
    }
    world.apply(parsed.data);
    choreographer.handle(parsed.data.event, world.state);
  });
  world.subscribe(renderPanels);
  setInterval(renderPanels, AGE_REFRESH_MS);
  renderPanels();
  feed.start();

  const scratch = new Vector3();
  const pickAt = (point: ScreenPoint): string | null => {
    const actors: ScreenActor[] = choreographer.presentCharacters.map(({ id, character }) => ({
      id,
      foot: toScreen(character.root.position, officeCamera.camera),
      head: toScreen(character.headPosition(scratch), officeCamera.camera),
    }));
    return pickActor(actors, point, PICK_RADIUS_GAME_PX * pixelScale);
  };

  const panInput = setupInput({
    onClick: (point) => select(pickAt(point)),
    onKey: (key) => {
      if (key === 'escape') select(null);
      else if (key === 'f') toggleFollow();
      else if (key === 'i') dock.openTab('inbox', true);
      else if (key === 't') dock.openTab('tasks');
      else if (key === 'l') dock.openTab('log');
      else if (key === 'h') dock.visible = !dock.visible;
      else return false;
      return true;
    },
  });

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(MAX_FRAME_DT, (now - last) / 1000);
    last = now;
    const time = now / 1000;

    const { right, forward } = panInput();
    officeCamera.pan(right * PAN_SPEED * dt, forward * PAN_SPEED * dt);
    const selected = selectedId ? choreographer.characterOf(selectedId) : null;
    if (selected && isFollowing) {
      // Center the agent in the uncovered part of the screen, not behind the dock.
      const dockOffset = dock.coveredWidth / 2 / pixelScale / PIXELS_PER_UNIT;
      officeCamera.follow(selected.root.position, dt, dockOffset);
    }
    dock.inspector.setFollowing(isFollowing && selected !== null);
    officeCamera.update();
    pipeline.shiftBySubTexel(officeCamera.subTexel.x, officeCamera.subTexel.y);

    crowd.update(dt);
    choreographer.update(dt, time);
    office.update(time);
    ring.visible = selected !== null;
    if (selected) ring.position.set(selected.root.position.x, 0.015, selected.root.position.z);

    pipeline.render(scene, officeCamera.camera);
    nameTags.update(officeCamera.camera, canvas, dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
resize();
renderHud();
start().catch((error: unknown) => {
  hud.textContent = `FAILED TO START: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
});
