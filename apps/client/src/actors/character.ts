import { BoxGeometry, Color, Group, Mesh, MeshLambertMaterial, Vector3 } from 'three';

export interface CharacterLook {
  shirt: string;
  pants: string;
  skin: string;
  hair: string;
  shoes: string;
  tie?: string;
}

export type CharacterPose = 'idle' | 'walk' | 'sit' | 'type' | 'draw' | 'operate';

const LEG_HEIGHT = 0.28;
const TORSO_HEIGHT = 0.26;
const HEAD_SIZE = 0.18;
const SHOULDER_Y = LEG_HEIGHT + TORSO_HEIGHT - 0.02;
const WALK_SPEED = 1.6;
const STRIDE_RATE = 9;
const TURN_RATE = 12;

const materials = new Map<string, MeshLambertMaterial>();

function material(color: string): MeshLambertMaterial {
  let shared = materials.get(color);
  if (!shared) {
    shared = new MeshLambertMaterial({ color: new Color(color) });
    materials.set(color, shared);
  }
  return shared;
}

/** Box mesh; with `hangFromTop` the pivot sits at the top face so limbs swing naturally. */
function block(size: [number, number, number], color: string, hangFromTop = false): Mesh {
  const geometry = new BoxGeometry(...size);
  if (hangFromTop) geometry.translate(0, -size[1] / 2, 0);
  const mesh = new Mesh(geometry, material(color));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** A blocky office worker built from boxes, with simple procedural animation. Faces +z. */
export class Character {
  readonly root = new Group();
  pose: CharacterPose = 'idle';
  onArrive?: () => void;

  private readonly body = new Group();
  private readonly legs: [Group, Group];
  private readonly arms: [Group, Group];
  private readonly head = new Group();
  private readonly scratch = new Vector3();
  private path: Vector3[] = [];
  private heading = 0;
  private targetHeading = 0;
  private stridePhase = 0;
  private seatHeight = 0;

  constructor(look: CharacterLook) {
    this.root.add(this.body);
    this.legs = [this.buildLeg(look, -1), this.buildLeg(look, 1)];
    this.arms = [this.buildArm(look, -1), this.buildArm(look, 1)];

    const torso = block([0.24, TORSO_HEIGHT, 0.14], look.shirt);
    torso.position.y = LEG_HEIGHT + TORSO_HEIGHT / 2;
    this.body.add(torso);
    if (look.tie) {
      const tie = block([0.04, 0.16, 0.012], look.tie);
      tie.position.set(0, LEG_HEIGHT + TORSO_HEIGHT - 0.1, 0.071);
      this.body.add(tie);
    }
    this.buildHead(look);
  }

  get isWalking(): boolean {
    return this.path.length > 0;
  }

  /** Top of the head in world space (follows sitting, bobbing and walking). */
  headPosition(out: Vector3): Vector3 {
    this.head.updateWorldMatrix(true, false);
    this.head.getWorldPosition(out);
    out.y += HEAD_SIZE + 0.04;
    return out;
  }

  get waypointCount(): number {
    return this.path.length;
  }

  /** Queues one more point to walk to, standing up first if seated. */
  appendWaypoint(point: Vector3): void {
    this.path.push(point.clone());
    this.seatHeight = 0;
    this.pose = 'walk';
  }

  /** Strike a pose where the character already stands (e.g. sit down at the chair it walked to). */
  settle(pose: CharacterPose, heading: number, seatHeight = 0): void {
    this.path = [];
    this.targetHeading = heading;
    this.seatHeight = seatHeight;
    this.pose = pose;
  }

  walkTo(points: Vector3[]): void {
    this.path = points.map((point) => point.clone());
    this.seatHeight = 0;
    this.pose = this.path.length ? 'walk' : 'idle';
  }

  sit(at: Vector3, heading: number, seatHeight: number, working: boolean): void {
    this.path = [];
    this.root.position.copy(at);
    this.heading = this.targetHeading = heading;
    this.seatHeight = seatHeight;
    this.pose = working ? 'type' : 'sit';
  }

  stand(at: Vector3, heading: number, pose: CharacterPose = 'idle'): void {
    this.path = [];
    this.root.position.copy(at);
    this.heading = this.targetHeading = heading;
    this.seatHeight = 0;
    this.pose = pose;
  }

  update(dt: number, time: number): void {
    this.followPath(dt);
    this.heading += wrapAngle(this.targetHeading - this.heading) * Math.min(1, dt * TURN_RATE);
    this.root.rotation.y = this.heading;
    this.animate(dt, time);
  }

  private followPath(dt: number): void {
    const target = this.path[0];
    if (!target) return;
    const toTarget = this.scratch.subVectors(target, this.root.position).setY(0);
    const distance = toTarget.length();
    const step = WALK_SPEED * dt;
    if (distance > 1e-4) this.targetHeading = Math.atan2(toTarget.x, toTarget.z);
    if (distance <= step) {
      this.root.position.set(target.x, this.root.position.y, target.z);
      this.path.shift();
      if (!this.path.length) {
        this.pose = 'idle';
        this.onArrive?.();
      }
      return;
    }
    this.root.position.addScaledVector(toTarget, step / distance);
  }

  private animate(dt: number, time: number): void {
    const [legLeft, legRight] = this.legs;
    const [armLeft, armRight] = this.arms;
    for (const limb of [legLeft, legRight, armLeft, armRight]) limb.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    this.body.position.y = 0;

    switch (this.pose) {
      case 'walk': {
        this.stridePhase += dt * STRIDE_RATE;
        const swing = Math.sin(this.stridePhase);
        legLeft.rotation.x = swing * 0.6;
        legRight.rotation.x = -swing * 0.6;
        armLeft.rotation.x = -swing * 0.5;
        armRight.rotation.x = swing * 0.5;
        this.body.position.y = Math.abs(Math.cos(this.stridePhase)) * 0.02;
        break;
      }
      case 'idle':
        this.body.position.y = Math.sin(time * 2) * 0.004;
        armLeft.rotation.z = -0.05;
        armRight.rotation.z = 0.05;
        break;
      case 'sit':
      case 'type': {
        this.body.position.y = this.seatHeight - LEG_HEIGHT;
        legLeft.rotation.x = legRight.rotation.x = -Math.PI / 2;
        if (this.pose === 'type') {
          armLeft.rotation.x = -1.15 + Math.sin(time * 22) * 0.12;
          armRight.rotation.x = -1.15 + Math.sin(time * 22 + 2) * 0.12;
          this.head.rotation.x = 0.12 + Math.sin(time * 1.3) * 0.04;
        } else {
          armLeft.rotation.x = armRight.rotation.x = -0.4;
        }
        break;
      }
      case 'operate':
        armLeft.rotation.x = -1.0 + Math.sin(time * 6) * 0.15;
        armRight.rotation.x = -1.0 + Math.sin(time * 6 + 1.5) * 0.15;
        this.head.rotation.x = 0.1;
        this.body.position.y = Math.sin(time * 2) * 0.004;
        break;
      case 'draw':
        armRight.rotation.x = -2.4 + Math.sin(time * 3) * 0.25;
        armRight.rotation.z = Math.sin(time * 1.7) * 0.3;
        armLeft.rotation.z = -0.05;
        this.body.position.y = Math.sin(time * 1.5) * 0.004;
        this.head.rotation.y = Math.sin(time * 0.8) * 0.15;
        break;
    }
  }

  private buildLeg(look: CharacterLook, side: -1 | 1): Group {
    const leg = new Group();
    leg.position.set(side * 0.055, LEG_HEIGHT, 0);
    leg.add(block([0.09, LEG_HEIGHT, 0.1], look.pants, true));
    const shoe = block([0.1, 0.05, 0.13], look.shoes);
    shoe.position.set(0, -LEG_HEIGHT + 0.025, 0.015);
    leg.add(shoe);
    this.body.add(leg);
    return leg;
  }

  private buildArm(look: CharacterLook, side: -1 | 1): Group {
    const arm = new Group();
    arm.position.set(side * 0.155, SHOULDER_Y, 0);
    arm.add(block([0.07, 0.18, 0.08], look.shirt, true));
    const hand = block([0.06, 0.06, 0.07], look.skin);
    hand.position.y = -0.21;
    arm.add(hand);
    this.body.add(arm);
    return arm;
  }

  private buildHead(look: CharacterLook): void {
    this.head.position.y = LEG_HEIGHT + TORSO_HEIGHT;
    const face = block([HEAD_SIZE, HEAD_SIZE, HEAD_SIZE], look.skin);
    face.position.y = HEAD_SIZE / 2 + 0.01;
    const hairTop = block([HEAD_SIZE + 0.01, 0.05, HEAD_SIZE + 0.01], look.hair);
    hairTop.position.y = HEAD_SIZE + 0.02;
    const hairBack = block([HEAD_SIZE + 0.01, 0.12, 0.04], look.hair);
    hairBack.position.set(0, HEAD_SIZE - 0.04, -0.08);
    this.head.add(face, hairTop, hairBack);
    for (const side of [-1, 1]) {
      const eye = block([0.03, 0.035, 0.01], '#181425');
      eye.position.set(side * 0.045, HEAD_SIZE * 0.6, HEAD_SIZE / 2 + 0.011);
      this.head.add(eye);
    }
    this.body.add(this.head);
  }
}
