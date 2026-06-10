import * as THREE from 'three';
import starCatalog from '../data/starCatalog.json';
import { deriveConstellationLines } from './catalogLines';
import {
  altAzToWorldPosition,
  createObserver,
  magnitudeToPointSize,
  magnitudeToRadius,
  SKY_SPHERE_RADIUS,
  starHorizontalPosition,
  type ObserverLocation,
} from './skyMath';

const GOLD = 0xffd54f;
const GOLD_GLOW = 0xd4af37;
const LINE_RADIUS = 0.14;
const LINE_GLOW_RADIUS = 0.28;
const EDGE_ANIM_DURATION = 0.45;
const FOUND_STAR_SCALE = 1.45;
const HIT_RADIUS_MULTIPLIER = 14;
const HIT_RADIUS_MIN = SKY_SPHERE_RADIUS * 0.03;
const TAP_SNAP_RADIUS_PX = 56;

export interface CatalogStar {
  id: string;
  name: string;
  hip: number;
  raHours: number;
  decDeg: number;
  mag: number;
}

export interface CatalogConstellation {
  id: string;
  iau: string;
  name: string;
  stars: CatalogStar[];
}

export interface SkyTapResult {
  starId: string;
  starName: string;
  constellationId: string;
  constellationName: string;
  foundInConstellation: number;
  totalInConstellation: number;
  constellationComplete: boolean;
}

interface StarEntry {
  star: CatalogStar;
  constellationId: string;
  constellationName: string;
  index: number;
  glow: THREE.Mesh;
  hit: THREE.Mesh;
  baseGlowOpacity: number;
}

interface LineEntry {
  lineKey: string;
  mesh: THREE.Mesh;
  glow: THREE.Mesh;
  fromId: string;
  toId: string;
  constellationId: string;
  progress: number;
  growFromId: string | null;
  growToId: string | null;
}

function lineKey(fromId: string, toId: string): string {
  return `${fromId}:${toId}`;
}

function createSkyLineMeshes(): { mesh: THREE.Mesh; glow: THREE.Mesh } {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(LINE_RADIUS, LINE_RADIUS, 1, 10),
    new THREE.MeshBasicMaterial({
      color: GOLD,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
    }),
  );
  mesh.visible = false;
  mesh.renderOrder = 0;

  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(LINE_GLOW_RADIUS, LINE_GLOW_RADIUS, 1, 8),
    new THREE.MeshBasicMaterial({
      color: GOLD_GLOW,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
    }),
  );
  glow.visible = false;
  glow.renderOrder = 0;

  return { mesh, glow };
}

export class SkyScene {
  readonly group = new THREE.Group();
  readonly starsGroup = new THREE.Group();
  readonly linesGroup = new THREE.Group();

  private readonly starEntries: StarEntry[] = [];
  private readonly lineEntries: LineEntry[] = [];
  private readonly lineByKey = new Map<string, LineEntry>();
  private readonly starById = new Map<string, StarEntry>();
  private readonly constellationStarCounts = new Map<string, number>();
  private readonly foundStars = new Set<string>();
  private readonly hitMeshes: THREE.Mesh[] = [];
  private readonly edgeAnimations = new Map<string, number>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly projectedStar = new THREE.Vector3();
  private positions = new Float32Array(0);
  private pointOpacities = new Float32Array(0);
  private points: THREE.Points | null = null;
  private observer = createObserver({ latitude: 48.85, longitude: 2.35, elevationM: 35 });
  private lastUpdateMs = 0;
  private readonly updateIntervalMs = 2000;
  private visibleStarCount = 0;
  private activeConstellationId: string | null = null;
  private readonly tapOrder: string[] = [];
  private lastTappedStarId: string | null = null;

  constructor() {
    this.group.add(this.starsGroup);
    this.group.add(this.linesGroup);
    this.buildFromCatalog(starCatalog.constellations as CatalogConstellation[]);
    this.updateStarPositions(new Date(), true);
  }

  getVisibleStarCount(): number {
    return this.visibleStarCount;
  }

  getFoundStarCount(): number {
    return this.foundStars.size;
  }

  getActiveConstellationName(): string | null {
    if (!this.activeConstellationId) return null;
    const entry = this.starEntries.find((e) => e.constellationId === this.activeConstellationId);
    return entry?.constellationName ?? null;
  }

  resetProgress(): void {
    this.foundStars.clear();
    this.activeConstellationId = null;
    this.tapOrder.length = 0;
    this.lastTappedStarId = null;
    this.edgeAnimations.clear();
    for (const entry of this.starEntries) {
      entry.glow.scale.setScalar(1);
      const mat = entry.glow.material as THREE.MeshBasicMaterial;
      mat.color.setHex(0xffffff);
    }
    for (const line of this.lineEntries) {
      line.progress = 0;
      line.growFromId = null;
      line.growToId = null;
      this.setLineProgress(line.lineKey, 0);
    }
    this.refreshStarBrightness();
  }

  setObserver(location: ObserverLocation): void {
    this.observer = createObserver(location);
    this.updateStarPositions(new Date(), true);
  }

  update(timeMs: number, dt: number, date = new Date()): void {
    this.updateLineAnimations(dt);
    if (timeMs - this.lastUpdateMs >= this.updateIntervalMs) {
      this.updateStarPositions(date);
      this.lastUpdateMs = timeMs;
    }
  }

  getHitMeshes(): THREE.Mesh[] {
    return this.hitMeshes.filter((mesh) => mesh.visible);
  }

  tapFromNdc(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    viewportWidth: number,
    viewportHeight: number,
  ): SkyTapResult | null {
    this.raycaster.setFromCamera(ndc, camera);
    this.raycaster.far = SKY_SPHERE_RADIUS * 1.5;
    const hits = this.raycaster.intersectObjects(this.getHitMeshes(), false);
    if (hits.length > 0) {
      const starId = hits[0].object.userData.starId as string;
      return this.tapStar(starId);
    }

    const nearestStarId = this.findNearestVisibleStar(ndc, camera, viewportWidth, viewportHeight);
    if (!nearestStarId) return null;
    return this.tapStar(nearestStarId);
  }

  private findNearestVisibleStar(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    viewportWidth: number,
    viewportHeight: number,
  ): string | null {
    const snapRadiusSq = TAP_SNAP_RADIUS_PX * TAP_SNAP_RADIUS_PX;
    let bestStarId: string | null = null;
    let bestDistSq = snapRadiusSq;

    for (const entry of this.starEntries) {
      if (!entry.hit.visible) continue;

      this.projectedStar.copy(entry.hit.position).project(camera);
      if (this.projectedStar.z > 1) continue;

      const pxX = (this.projectedStar.x - ndc.x) * 0.5 * viewportWidth;
      const pxY = (this.projectedStar.y - ndc.y) * 0.5 * viewportHeight;
      const distSq = pxX * pxX + pxY * pxY;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestStarId = entry.star.id;
      }
    }

    return bestStarId;
  }

  tapStar(starId: string): SkyTapResult | null {
    const entry = this.starById.get(starId);
    if (!entry || !entry.hit.visible) return null;

    if (!this.activeConstellationId) {
      this.activeConstellationId = entry.constellationId;
    } else if (entry.constellationId !== this.activeConstellationId) {
      this.clearConstellationProgress(this.activeConstellationId);
      this.activeConstellationId = entry.constellationId;
    }

    const previousTap = this.lastTappedStarId;
    const isNewStar = !this.foundStars.has(starId);

    if (isNewStar) {
      this.foundStars.add(starId);
      this.tapOrder.push(starId);
      this.lastTappedStarId = starId;
      entry.glow.scale.setScalar(FOUND_STAR_SCALE);
      const mat = entry.glow.material as THREE.MeshBasicMaterial;
      mat.color.setHex(GOLD);
      this.revealLinesForFoundStars(starId, previousTap);
    } else {
      this.lastTappedStarId = starId;
    }

    this.refreshStarBrightness();

    const total = this.constellationStarCounts.get(entry.constellationId) ?? 0;
    const foundInConstellation = [...this.foundStars].filter(
      (id) => this.starById.get(id)?.constellationId === entry.constellationId,
    ).length;

    const constellationComplete = foundInConstellation >= total;
    if (constellationComplete) {
      this.activeConstellationId = null;
    }

    return {
      starId,
      starName: entry.star.name,
      constellationId: entry.constellationId,
      constellationName: entry.constellationName,
      foundInConstellation,
      totalInConstellation: total,
      constellationComplete,
    };
  }

  private buildFromCatalog(constellations: CatalogConstellation[]): void {
    const allStars: { star: CatalogStar; constellationId: string; constellationName: string }[] = [];

    for (const constellation of constellations) {
      this.constellationStarCounts.set(constellation.id, constellation.stars.length);
      for (const star of constellation.stars) {
        allStars.push({
          star,
          constellationId: constellation.id,
          constellationName: constellation.name,
        });
      }

      const lines = deriveConstellationLines(constellation.iau, constellation.stars);
      for (const [fromId, toId] of lines) {
        const key = lineKey(fromId, toId);
        const { mesh, glow } = createSkyLineMeshes();
        const entry: LineEntry = {
          lineKey: key,
          mesh,
          glow,
          fromId,
          toId,
          constellationId: constellation.id,
          progress: 0,
          growFromId: null,
          growToId: null,
        };
        this.lineEntries.push(entry);
        this.lineByKey.set(key, entry);
        this.linesGroup.add(glow);
        this.linesGroup.add(mesh);
      }
    }

    this.positions = new Float32Array(allStars.length * 3);
    const pointSizes = new Float32Array(allStars.length);
    this.pointOpacities = new Float32Array(allStars.length);

    const hitMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });

    for (let i = 0; i < allStars.length; i++) {
      const { star, constellationId, constellationName } = allStars[i];
      pointSizes[i] = magnitudeToPointSize(star.mag);

      const glowRadius = magnitudeToRadius(star.mag);
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(glowRadius, 10, 10),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      glow.visible = false;
      glow.renderOrder = 5;

      const hitRadius = Math.max(glowRadius * HIT_RADIUS_MULTIPLIER, HIT_RADIUS_MIN);
      const hit = new THREE.Mesh(new THREE.SphereGeometry(hitRadius, 8, 8), hitMaterial.clone());
      hit.visible = false;
      hit.userData.starId = star.id;
      hit.userData.isSkyStar = true;
      hit.userData.constellationId = constellationId;
      this.hitMeshes.push(hit);
      this.starsGroup.add(hit);
      this.starsGroup.add(glow);

      this.starEntries.push({
        star,
        constellationId,
        constellationName,
        index: i,
        glow,
        hit,
        baseGlowOpacity: 1,
      });
      this.starById.set(star.id, this.starEntries[this.starEntries.length - 1]);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(pointSizes, 1));
    geometry.setAttribute('opacity', new THREE.BufferAttribute(this.pointOpacities, 1));

    const pointsMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float size;
        attribute float opacity;
        varying float vOpacity;
        void main() {
          vOpacity = opacity;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (380.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vOpacity;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          float dist = length(c);
          if (dist > 0.5) discard;
          float core = smoothstep(0.5, 0.0, dist);
          float alpha = core * vOpacity;
          gl_FragColor = vec4(1.0, 1.0, 0.95, alpha);
        }
      `,
    });

    this.points = new THREE.Points(geometry, pointsMaterial);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    this.starsGroup.add(this.points);
  }

  private clearConstellationProgress(constellationId: string): void {
    for (const starId of [...this.foundStars]) {
      const starEntry = this.starById.get(starId);
      if (starEntry?.constellationId !== constellationId) continue;
      this.foundStars.delete(starId);
      starEntry.glow.scale.setScalar(1);
      const mat = starEntry.glow.material as THREE.MeshBasicMaterial;
      mat.color.setHex(0xffffff);
    }

    this.tapOrder.length = 0;
    this.lastTappedStarId = null;

    for (const line of this.lineEntries) {
      if (line.constellationId !== constellationId) continue;
      this.edgeAnimations.delete(line.lineKey);
      line.progress = 0;
      line.growFromId = null;
      line.growToId = null;
      this.setLineProgress(line.lineKey, 0);
    }

    this.refreshStarBrightness();
  }

  private resolveLineGrowth(
    line: LineEntry,
    currentStarId: string,
    previousTap: string | null,
  ): { growFromId: string; growToId: string } {
    const otherId = line.fromId === currentStarId ? line.toId : line.fromId;

    if (previousTap === otherId) {
      return { growFromId: previousTap, growToId: currentStarId };
    }

    const orderOther = this.tapOrder.indexOf(otherId);
    const orderCurrent = this.tapOrder.indexOf(currentStarId);
    return orderOther <= orderCurrent
      ? { growFromId: otherId, growToId: currentStarId }
      : { growFromId: currentStarId, growToId: otherId };
  }

  private rebindLineFromStars(line: LineEntry): void {
    const startId = line.growFromId ?? line.fromId;
    const endId = line.growToId ?? line.toId;
    const fromEntry = this.starById.get(startId);
    const toEntry = this.starById.get(endId);
    if (!fromEntry?.glow.visible || !toEntry?.glow.visible) return;
    this.bindLineGeometry(line, fromEntry.glow.position, toEntry.glow.position);
  }

  private revealLinesForFoundStars(currentStarId: string, previousTap: string | null): void {
    for (const line of this.lineEntries) {
      if (this.activeConstellationId && line.constellationId !== this.activeConstellationId) {
        continue;
      }
      if (!this.foundStars.has(line.fromId) || !this.foundStars.has(line.toId)) {
        continue;
      }
      if (line.fromId !== currentStarId && line.toId !== currentStarId) {
        continue;
      }
      if (line.progress >= 1) continue;
      if (this.edgeAnimations.has(line.lineKey)) continue;

      const { growFromId, growToId } = this.resolveLineGrowth(line, currentStarId, previousTap);
      line.growFromId = growFromId;
      line.growToId = growToId;
      this.rebindLineFromStars(line);
      this.edgeAnimations.set(line.lineKey, line.progress);
    }
  }

  private updateLineAnimations(dt: number): void {
    if (this.edgeAnimations.size === 0) return;

    const speed = 1 / EDGE_ANIM_DURATION;
    for (const [key, progress] of this.edgeAnimations) {
      const next = Math.min(progress + speed * dt, 1);
      this.setLineProgress(key, next);
      if (next >= 1) {
        this.edgeAnimations.delete(key);
      } else {
        this.edgeAnimations.set(key, next);
      }
    }
  }

  private setLineProgress(key: string, progress: number): void {
    const line = this.lineByKey.get(key);
    if (!line) return;

    line.progress = progress;
    const from = line.mesh.userData.from as THREE.Vector3 | undefined;
    const direction = line.mesh.userData.direction as THREE.Vector3 | undefined;
    const fullLength = line.mesh.userData.fullLength as number | undefined;
    if (!from || !direction || fullLength === undefined) return;

    const currentLength = fullLength * progress;
    const midpoint = from.clone().addScaledVector(direction, currentLength * 0.5);

    line.mesh.position.copy(midpoint);
    line.mesh.scale.set(1, Math.max(currentLength, 0.001), 1);
    line.glow.position.copy(midpoint);
    line.glow.scale.set(1, Math.max(currentLength, 0.001), 1);

    const visible = progress > 0 && line.mesh.userData.aboveHorizon === true;
    line.mesh.visible = visible;
    line.glow.visible = visible;

    const mat = line.mesh.material as THREE.MeshBasicMaterial;
    const glowMat = line.glow.material as THREE.MeshBasicMaterial;
    mat.opacity = visible ? 1 : 0;
    glowMat.opacity = visible ? 0.45 : 0;
  }

  private refreshStarBrightness(): void {
    for (const entry of this.starEntries) {
      const idx = entry.index;
      const isFound = this.foundStars.has(entry.star.id);
      if (isFound) {
        this.pointOpacities[idx] = Math.min(1, entry.baseGlowOpacity * 1.4);
        const glowMat = entry.glow.material as THREE.MeshBasicMaterial;
        glowMat.opacity = Math.min(1, entry.baseGlowOpacity * 1.2);
      }
    }
    const opacityAttr = this.points?.geometry.getAttribute('opacity') as THREE.BufferAttribute | undefined;
    if (opacityAttr) opacityAttr.needsUpdate = true;
  }

  private updateStarPositions(date: Date, force = false): void {
    if (!force && this.starEntries.length === 0) return;

    const worldPositions = new Map<string, THREE.Vector3>();
    let visible = 0;

    for (const entry of this.starEntries) {
      const { altitude, azimuth } = starHorizontalPosition(
        entry.star.raHours,
        entry.star.decDeg,
        this.observer,
        date,
      );

      const idx = entry.index;
      const pointOpacity = 0.85 + 0.15 * (1.4 - entry.star.mag) / 1.4;
      this.pointOpacities[idx] = this.foundStars.has(entry.star.id)
        ? Math.min(1, pointOpacity * 1.4)
        : pointOpacity;
      entry.baseGlowOpacity = pointOpacity;

      const pos = altAzToWorldPosition(azimuth, altitude, SKY_SPHERE_RADIUS);
      this.positions[idx * 3] = pos.x;
      this.positions[idx * 3 + 1] = pos.y;
      this.positions[idx * 3 + 2] = pos.z;
      worldPositions.set(entry.star.id, pos);

      entry.glow.position.copy(pos);
      entry.hit.position.copy(pos);
      const glowMat = entry.glow.material as THREE.MeshBasicMaterial;
      glowMat.opacity = this.foundStars.has(entry.star.id)
        ? Math.min(1, pointOpacity * 1.15)
        : pointOpacity;
      entry.glow.visible = true;
      entry.hit.visible = true;
      visible++;
    }

    this.visibleStarCount = visible;

    const positionAttr = this.points?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    const opacityAttr = this.points?.geometry.getAttribute('opacity') as THREE.BufferAttribute | undefined;
    if (positionAttr) positionAttr.needsUpdate = true;
    if (opacityAttr) opacityAttr.needsUpdate = true;

    for (const line of this.lineEntries) {
      const startId = line.growFromId ?? line.fromId;
      const endId = line.growToId ?? line.toId;
      const from = worldPositions.get(startId);
      const to = worldPositions.get(endId);
      if (!from || !to) {
        line.mesh.userData.aboveHorizon = false;
        line.mesh.visible = false;
        line.glow.visible = false;
        continue;
      }

      this.bindLineGeometry(line, from, to);
      line.mesh.userData.aboveHorizon = true;
      this.setLineProgress(line.lineKey, line.progress);
    }
  }

  private bindLineGeometry(line: LineEntry, from: THREE.Vector3, to: THREE.Vector3): void {
    const direction = new THREE.Vector3().subVectors(to, from);
    const length = direction.length();
    if (length < 0.001) return;

    direction.normalize();
    const orientation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction,
    );

    line.mesh.userData.from = from.clone();
    line.mesh.userData.to = to.clone();
    line.mesh.userData.direction = direction.clone();
    line.mesh.userData.fullLength = length;
    line.mesh.quaternion.copy(orientation);
    line.glow.quaternion.copy(orientation);
  }
}
