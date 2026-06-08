import * as THREE from 'three';
import constellationData from './data/constellation.json';
import textLayouts from './data/textLayouts.json';
import { MESSAGES, type MessageKey } from './messages';

const GOLD = 0xffd54f;
const GOLD_GLOW = 0xd4af37;
const NAVY = 0x0a0d1a;
const DECOY_COUNT = 50;
const EDGE_TAP_ANIM_DURATION = 0.45;
const LINE_RADIUS = 0.0045;
const LINE_GLOW_RADIUS = 0.009;
const LINE_DEPTH_OFFSET = -0.005;
const STAR_RENDER_ORDER = 2;
const LINE_RENDER_ORDER = 0;

export interface StarObject {
  id: string;
  mesh: THREE.Mesh;
  isConstellation: boolean;
  baseScale: number;
}

export interface EdgeObject {
  id: string;
  mesh: THREE.Mesh;
  glow: THREE.Mesh;
  progress: number;
}

type TextLayoutKey = 'theQuestion' | 'theMoment';

interface ConstellationNode {
  id: string;
  x: number;
  y: number;
  color: string;
  radius: number;
}

function canvasToWorld(x: number, y: number, worldWidth: number): THREE.Vector3 {
  const { width, height } = constellationData.canvas;
  const nx = (x - width / 2) / width;
  const ny = (y - height / 2) / height;
  return new THREE.Vector3(nx * worldWidth, -ny * worldWidth, 0);
}

const TEXT_STAR_RADIUS = 0.004;
const TEXT_LAYOUT_SCALE = 1.15;

function createTextStarMesh(color: string, radius = TEXT_STAR_RADIUS): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 8, 8),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 1,
    }),
  );
}

function createStarMesh(color: string, radius: number, dim = false): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: dim ? 0.25 : 0.7,
  });

  if (dim) {
    return new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 12), material);
  }

  const hitRadius = Math.max(radius * 4, 0.025);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(hitRadius, 12, 12),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  const visual = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 12), material);
  visual.renderOrder = STAR_RENDER_ORDER;
  mesh.add(visual);
  return mesh;
}

function createEdgeMeshes(from: THREE.Vector3, to: THREE.Vector3): { mesh: THREE.Mesh; glow: THREE.Mesh } {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = direction.length();
  direction.normalize();

  const orientation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction,
  );

  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(LINE_RADIUS, LINE_RADIUS, 1, 12),
    new THREE.MeshBasicMaterial({
      color: GOLD,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
    }),
  );
  mesh.renderOrder = LINE_RENDER_ORDER;
  mesh.quaternion.copy(orientation);
  mesh.userData.from = from.clone();
  mesh.userData.to = to.clone();
  mesh.userData.fullLength = length;
  mesh.userData.direction = direction.clone();
  mesh.visible = false;

  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(LINE_GLOW_RADIUS, LINE_GLOW_RADIUS, 1, 10),
    new THREE.MeshBasicMaterial({
      color: GOLD_GLOW,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
    }),
  );
  glow.renderOrder = LINE_RENDER_ORDER;
  glow.quaternion.copy(orientation);
  glow.visible = false;

  return { mesh, glow };
}

function createLabelSprite(text: string, color: 'white' | 'gold', worldWidth: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 72;
  ctx.font = `700 ${fontSize}px Georgia, serif`;
  const textWidth = ctx.measureText(text).width;
  canvas.width = Math.max(256, Math.pow(2, Math.ceil(Math.log2(textWidth + 48))));
  canvas.height = 128;

  ctx.font = `700 ${fontSize}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color === 'gold' ? '#ffd700' : '#ffffff';
  ctx.shadowColor = ctx.fillStyle;
  ctx.shadowBlur = 16;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(worldWidth, worldWidth / aspect, 1);
  return sprite;
}

export class ConstellationScene {
  readonly group = new THREE.Group();
  readonly constellationGroup = new THREE.Group();
  readonly edgesGroup = new THREE.Group();
  readonly textGroup = new THREE.Group();
  readonly arMessageGroup = new THREE.Group();
  readonly decoyGroup = new THREE.Group();

  readonly stars = new Map<string, StarObject>();
  readonly decoys: THREE.Mesh[] = [];
  readonly edges = new Map<string, EdgeObject>();

  private glowPhase = 0;
  private textStars: THREE.Mesh[] = [];
  private arMessageSprites: THREE.Sprite[] = [];
  private currentTextLayout: TextLayoutKey | null = null;
  private currentARMessage: MessageKey | null = null;
  private edgeAnimations = new Map<string, number>();
  private nameLabel: THREE.Sprite | null = null;
  private nameBaseY = 0;

  constructor() {
    this.group.add(this.constellationGroup);
    this.group.add(this.decoyGroup);
    this.group.add(this.textGroup);
    this.group.add(this.arMessageGroup);
    this.textGroup.visible = false;
    this.arMessageGroup.visible = false;

    this.buildConstellation();
    this.buildDecoys();
  }

  private buildConstellation(): void {
    const nodePositions = new Map<string, THREE.Vector3>();
    const worldWidth = constellationData.worldWidth;

    this.edgesGroup.position.z = LINE_DEPTH_OFFSET;
    this.constellationGroup.add(this.edgesGroup);

    for (const node of constellationData.nodes as ConstellationNode[]) {
      const pos = canvasToWorld(node.x, node.y, worldWidth);
      nodePositions.set(node.id, pos);
    }

    for (const edge of constellationData.edges) {
      const from = nodePositions.get(edge.from);
      const to = nodePositions.get(edge.to);
      if (!from || !to) continue;

      const { mesh, glow } = createEdgeMeshes(from, to);
      this.edgesGroup.add(glow);
      this.edgesGroup.add(mesh);
      this.edges.set(edge.id, { id: edge.id, mesh, glow, progress: 0 });
    }

    for (const node of constellationData.nodes as ConstellationNode[]) {
      const pos = nodePositions.get(node.id)!;
      const mesh = createStarMesh(node.color, node.radius);
      mesh.position.copy(pos);
      mesh.renderOrder = STAR_RENDER_ORDER;
      mesh.userData.starId = node.id;
      mesh.userData.isConstellation = true;

      this.constellationGroup.add(mesh);
      this.stars.set(node.id, {
        id: node.id,
        mesh,
        isConstellation: true,
        baseScale: 1,
      });
    }

    this.buildNameLabel(worldWidth);
  }

  private buildNameLabel(worldWidth: number): void {
    const name = (constellationData as { name?: string }).name ?? 'The Lovers';
    const { height } = constellationData.canvas;
    const nodes = constellationData.nodes as ConstellationNode[];
    const topY = Math.max(
      ...nodes.map((node) => -((node.y - height / 2) / height) * worldWidth),
    );

    this.nameBaseY = topY + worldWidth * 0.12;
    const label = createLabelSprite(name, 'gold', worldWidth * 0.48);
    label.position.set(0, this.nameBaseY, 0.03);
    label.renderOrder = STAR_RENDER_ORDER;
    this.constellationGroup.add(label);
    this.nameLabel = label;
  }

  updateNameFloat(time: number): void {
    if (!this.nameLabel?.visible) return;
    const bob = Math.sin(time * 1.4) * 0.012;
    this.nameLabel.position.y = this.nameBaseY + bob;
  }

  private getConstellationExclusionBounds(worldWidth: number): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } {
    const { height } = constellationData.canvas;
    const nodes = constellationData.nodes as ConstellationNode[];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      const pos = canvasToWorld(node.x, node.y, worldWidth);
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }

    const padX = worldWidth * 0.1;
    const padY = worldWidth * 0.08;
    const topY = Math.max(
      ...nodes.map((node) => -((node.y - height / 2) / height) * worldWidth),
    );
    const titleTop = topY + worldWidth * 0.22;

    return {
      minX: minX - padX,
      maxX: maxX + padX,
      minY: minY - padY,
      maxY: Math.max(maxY + padY, titleTop),
    };
  }

  private isInsideExclusionBounds(
    x: number,
    y: number,
    bounds: { minX: number; maxX: number; minY: number; maxY: number },
  ): boolean {
    return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  }

  private buildDecoys(): void {
    const worldWidth = constellationData.worldWidth;
    const spread = worldWidth * 0.95;
    const exclusion = this.getConstellationExclusionBounds(worldWidth);

    let placed = 0;
    let attempts = 0;
    const maxAttempts = DECOY_COUNT * 40;

    while (placed < DECOY_COUNT && attempts < maxAttempts) {
      attempts++;
      const x = (Math.random() - 0.5) * spread * 2;
      const y = (Math.random() - 0.5) * spread * 1.6;
      if (this.isInsideExclusionBounds(x, y, exclusion)) continue;

      const mesh = createStarMesh('#FFFFFF', 0.006 + Math.random() * 0.004, true);
      mesh.position.set(x, y, 0);
      mesh.userData.isConstellation = false;
      mesh.userData.isDecoy = true;
      this.decoyGroup.add(mesh);
      this.decoys.push(mesh);
      placed++;
    }
  }

  getConstellationMeshes(): THREE.Mesh[] {
    return [...this.stars.values()].map((s) => s.mesh);
  }

  getInteractiveMeshes(): THREE.Mesh[] {
    return [...this.getConstellationMeshes(), ...this.decoys];
  }

  markStarFound(starId: string): void {
    const star = this.stars.get(starId);
    if (!star) return;
    const visual = star.mesh.children[0] as THREE.Mesh | undefined;
    const target = visual ?? star.mesh;
    const mat = target.material as THREE.MeshBasicMaterial;
    mat.opacity = 1;
    star.mesh.scale.setScalar(1.4);
    star.baseScale = 1.4;
  }

  flashDecoy(mesh: THREE.Mesh): void {
    const mat = mesh.material as THREE.MeshBasicMaterial;
    const original = mat.opacity;
    mat.opacity = 0.1;
    setTimeout(() => {
      mat.opacity = original;
    }, 200);
  }

  hideDecoys(): void {
    this.decoyGroup.visible = false;
  }

  revealEdgesForFoundNodes(foundStars: Set<string>): void {
    for (const edge of constellationData.edges) {
      if (!foundStars.has(edge.from) || !foundStars.has(edge.to)) continue;
      const existing = this.edges.get(edge.id);
      if (existing && existing.progress >= 1) continue;
      if (!this.edgeAnimations.has(edge.id)) {
        this.edgeAnimations.set(edge.id, existing?.progress ?? 0);
      }
    }
  }

  updateEdgeAnimations(dt: number): void {
    if (this.edgeAnimations.size === 0) return;

    const speed = 1 / EDGE_TAP_ANIM_DURATION;
    for (const [edgeId, progress] of this.edgeAnimations) {
      const next = Math.min(progress + speed * dt, 1);
      this.setEdgeProgress(edgeId, next);
      if (next >= 1) {
        this.edgeAnimations.delete(edgeId);
      } else {
        this.edgeAnimations.set(edgeId, next);
      }
    }
  }

  allEdgesComplete(): boolean {
    return [...this.edges.values()].every((edge) => edge.progress >= 1);
  }

  setEdgeProgress(edgeId: string, progress: number): void {
    const edge = this.edges.get(edgeId);
    if (!edge) return;

    edge.progress = progress;
    const from = edge.mesh.userData.from as THREE.Vector3;
    const direction = edge.mesh.userData.direction as THREE.Vector3;
    const fullLength = edge.mesh.userData.fullLength as number;
    const currentLength = fullLength * progress;
    const midpoint = from.clone().addScaledVector(direction, currentLength * 0.5);

    edge.mesh.position.copy(midpoint);
    edge.mesh.scale.set(1, currentLength, 1);
    edge.glow.position.copy(midpoint);
    edge.glow.scale.set(1, currentLength, 1);

    const visible = progress > 0;
    edge.mesh.visible = visible;
    edge.glow.visible = visible;

    const mat = edge.mesh.material as THREE.MeshBasicMaterial;
    const glowMat = edge.glow.material as THREE.MeshBasicMaterial;
    mat.opacity = visible ? 1 : 0;
    glowMat.opacity = visible ? 0.4 : 0;
  }

  showAllEdges(): void {
    for (const edge of this.edges.values()) {
      this.setEdgeProgress(edge.id, 1);
    }
  }

  setGlow(active: boolean, time: number): void {
    this.glowPhase = active ? time : 0;
  }

  updateGlow(time: number): void {
    if (this.glowPhase === 0) return;

    const pulse = 0.85 + Math.sin(time * 3) * 0.15;

    for (const star of this.stars.values()) {
      const scale = star.baseScale * pulse;
      star.mesh.scale.setScalar(scale);
      const visual = star.mesh.children[0] as THREE.Mesh | undefined;
      const target = visual ?? star.mesh;
      const mat = target.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.9 + Math.sin(time * 4 + star.mesh.position.x) * 0.1;
    }

    for (const edge of this.edges.values()) {
      const mat = edge.mesh.material as THREE.MeshBasicMaterial;
      const glowMat = edge.glow.material as THREE.MeshBasicMaterial;
      mat.opacity = pulse;
      glowMat.opacity = pulse * 0.4;
    }
  }

  fadeConstellation(opacity: number): void {
    const visible = opacity > 0.01;
    this.constellationGroup.visible = visible;
    this.decoyGroup.visible = visible && opacity > 0.5;

    for (const star of this.stars.values()) {
      const visual = star.mesh.children[0] as THREE.Mesh | undefined;
      const target = visual ?? star.mesh;
      const mat = target.material as THREE.MeshBasicMaterial;
      mat.opacity = opacity * 0.9;
    }
    for (const edge of this.edges.values()) {
      const mat = edge.mesh.material as THREE.MeshBasicMaterial;
      const glowMat = edge.glow.material as THREE.MeshBasicMaterial;
      mat.opacity = opacity;
      glowMat.opacity = opacity * 0.4;
      edge.mesh.visible = visible && edge.progress > 0;
      edge.glow.visible = visible && edge.progress > 0;
    }
    if (this.nameLabel) {
      const mat = this.nameLabel.material as THREE.SpriteMaterial;
      mat.opacity = opacity * 0.95;
      this.nameLabel.visible = visible;
    }
  }

  showARMessage(key: MessageKey, opacity = 1): void {
    if (this.currentARMessage !== key) {
      this.clearARMessage();
      this.currentARMessage = key;

      const lines = MESSAGES[key];
      const spacing = 0.11;
      const startY = ((lines.length - 1) * spacing) / 2;

      lines.forEach((line, index) => {
        const sprite = createLabelSprite(
          line.text,
          line.color ?? 'white',
          line.worldWidth ?? 0.4,
        );
        sprite.position.set(0, startY - index * spacing, 0.05);
        sprite.renderOrder = 10;
        this.arMessageGroup.add(sprite);
        this.arMessageSprites.push(sprite);
      });
    }

    this.setARMessageOpacity(opacity);
  }

  setARMessageOpacity(opacity: number): void {
    for (const sprite of this.arMessageSprites) {
      const mat = sprite.material as THREE.SpriteMaterial;
      mat.opacity = opacity;
    }
    this.arMessageGroup.visible = opacity > 0.01;
  }

  clearARMessage(): void {
    for (const sprite of this.arMessageSprites) {
      this.arMessageGroup.remove(sprite);
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    this.arMessageSprites = [];
    this.currentARMessage = null;
  }

  hideARMessage(): void {
    this.setARMessageOpacity(0);
  }

  showTextLayout(layoutKey: TextLayoutKey, opacity = 1): void {
    if (this.currentTextLayout !== layoutKey) {
      this.clearTextStars();
      this.currentTextLayout = layoutKey;

      const layout = textLayouts[layoutKey];
      const worldWidth = constellationData.worldWidth * TEXT_LAYOUT_SCALE;

      for (const line of layout.lines) {
        for (const star of line.stars) {
          const starColor = 'color' in star ? star.color : '#FFFFFF';
          const mesh = createTextStarMesh(starColor);
          mesh.position.set(star.x * worldWidth, -star.y * worldWidth, 0.01);
          this.textGroup.add(mesh);
          this.textStars.push(mesh);
        }
      }
    }

    this.setTextOpacity(opacity);
  }

  setTextOpacity(opacity: number): void {
    for (const mesh of this.textStars) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = opacity;
    }
    this.textGroup.visible = opacity > 0.01;
  }

  clearTextStars(): void {
    for (const mesh of this.textStars) {
      this.textGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.textStars = [];
    this.currentTextLayout = null;
  }

  setPreviewBackground(scene: THREE.Scene, preview: boolean): void {
    scene.background = preview ? new THREE.Color(NAVY) : null;
  }
}
