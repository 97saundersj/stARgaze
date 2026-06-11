import * as THREE from 'three';
import starCatalog from '../data/starCatalog.json';
import { constellationIllustrationUrl } from './constellationIllustrations';
import { deriveConstellationLines } from './catalogLines';
import { getIllustrationMetadata } from './catalogIllustrations';
import {
  buildStellariumImageTransform,
  createStellariumIllustrationGeometry,
  updateStellariumIllustrationGeometry,
} from './illustrationAlign';
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
/** Screen-distance penalty so found stars don't steal taps from close neighbors. */
const FOUND_STAR_TAP_PENALTY = 3;
const ILLUSTRATION_INSET = 0;
const ILLUSTRATION_FADE_DURATION = 0.9;
const ILLUSTRATION_MAX_OPACITY = 0.92;

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

interface IllustrationEntry {
  mesh: THREE.Mesh;
  fade: number;
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
  readonly illustrationsGroup = new THREE.Group();
  readonly starsGroup = new THREE.Group();
  readonly linesGroup = new THREE.Group();

  private readonly starEntries: StarEntry[] = [];
  private readonly lineEntries: LineEntry[] = [];
  private readonly lineByKey = new Map<string, LineEntry>();
  private readonly starById = new Map<string, StarEntry>();
  private readonly constellationStarCounts = new Map<string, number>();
  private readonly constellationNames = new Map<string, string>();
  private readonly constellationIau = new Map<string, string>();
  private readonly constellationRaHours = new Map<string, number>();
  private readonly constellationDecDeg = new Map<string, number>();
  private readonly starByHip = new Map<number, StarEntry>();
  private readonly illustrationByConstellation = new Map<string, IllustrationEntry>();
  private readonly foundStars = new Set<string>();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly hitMeshes: THREE.Mesh[] = [];
  private readonly edgeAnimations = new Map<string, number>();
  private readonly projectedStar = new THREE.Vector3();
  private readonly worldStar = new THREE.Vector3();
  private readonly illustrationStarDir0 = new THREE.Vector3();
  private readonly illustrationStarDir1 = new THREE.Vector3();
  private readonly illustrationStarDir2 = new THREE.Vector3();
  private readonly illustrationTransform = new THREE.Matrix4();
  private readonly illustrationProjectScratch = new THREE.Vector3();
  private positions = new Float32Array(0);
  private pointOpacities = new Float32Array(0);
  private points: THREE.Points | null = null;
  private observer = createObserver({ latitude: 48.85, longitude: 2.35, elevationM: 35 });
  private lastUpdateMs = 0;
  private readonly updateIntervalMs = 60000;
  private visibleStarCount = 0;
  private activeConstellationId: string | null = null;
  private readonly tapOrder: string[] = [];
  private lastTappedStarId: string | null = null;
  private visualBoost = 1;
  private showConstellations = false;

  constructor() {
    this.group.add(this.illustrationsGroup);
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

  getShowConstellations(): boolean {
    return this.showConstellations;
  }

  setShowConstellations(show: boolean): void {
    if (this.showConstellations === show) return;
    this.showConstellations = show;
    if (show) {
      this.showAllConstellationOverlays();
    } else {
      this.restoreGameConstellationOverlays();
    }
    this.updateStarPositions(new Date(), true);
  }

  getActiveConstellationName(): string | null {
    if (!this.activeConstellationId) return null;
    const entry = this.starEntries.find((e) => e.constellationId === this.activeConstellationId);
    return entry?.constellationName ?? null;
  }

  setVisualBoost(boost: number): void {
    this.visualBoost = boost;
    const material = this.points?.material as THREE.ShaderMaterial | undefined;
    if (material?.uniforms?.sizeScale) {
      material.uniforms.sizeScale.value = boost > 1 ? 1.75 : 1;
    }
    this.updateStarPositions(new Date(), true);
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
    this.clearAllIllustrations();
    this.refreshStarBrightness();
  }

  setObserver(location: ObserverLocation): void {
    this.observer = createObserver(location);
    this.updateStarPositions(new Date(), true);
  }

  update(timeMs: number, dt: number, date = new Date()): void {
    this.updateLineAnimations(dt);
    this.updateIllustrationFades(dt);
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
    const nearestStarId = this.findNearestVisibleStar(ndc, camera, viewportWidth, viewportHeight);
    if (!nearestStarId) return null;
    return this.tapStar(nearestStarId);
  }

  tapFromRay(origin: THREE.Vector3, direction: THREE.Vector3): SkyTapResult | null {
    const dir = direction.clone().normalize();
    const snapAngleCos = Math.cos(THREE.MathUtils.degToRad(4.5));
    let bestStarId: string | null = null;
    let bestScore = snapAngleCos;

    for (const entry of this.starEntries) {
      if (!entry.hit.visible) continue;

      entry.hit.getWorldPosition(this.worldStar);
      this.worldStar.sub(origin);
      const dist = this.worldStar.length();
      if (dist < 0.001) continue;
      this.worldStar.divideScalar(dist);

      const alignment = dir.dot(this.worldStar);
      if (alignment < snapAngleCos) continue;

      const score = this.foundStars.has(entry.star.id)
        ? alignment / FOUND_STAR_TAP_PENALTY
        : alignment;
      if (score > bestScore) {
        bestScore = score;
        bestStarId = entry.star.id;
      }
    }

    if (!bestStarId) return null;
    return this.tapStar(bestStarId);
  }

  private findNearestVisibleStar(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    viewportWidth: number,
    viewportHeight: number,
  ): string | null {
    const snapRadiusSq = TAP_SNAP_RADIUS_PX * TAP_SNAP_RADIUS_PX;
    let bestStarId: string | null = null;
    let bestScore = snapRadiusSq;

    for (const entry of this.starEntries) {
      if (!entry.hit.visible) continue;

      entry.hit.getWorldPosition(this.projectedStar);
      this.projectedStar.project(camera);
      if (this.projectedStar.z > 1) continue;

      const pxX = (this.projectedStar.x - ndc.x) * 0.5 * viewportWidth;
      const pxY = (this.projectedStar.y - ndc.y) * 0.5 * viewportHeight;
      const distSq = pxX * pxX + pxY * pxY;
      if (distSq >= snapRadiusSq) continue;

      const score = this.foundStars.has(entry.star.id)
        ? distSq * FOUND_STAR_TAP_PENALTY
        : distSq;
      if (score < bestScore) {
        bestScore = score;
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
      this.revealIllustration(entry.constellationId);
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
      this.constellationNames.set(constellation.id, constellation.name);
      this.constellationIau.set(constellation.id, constellation.iau);
      let raHoursSum = 0;
      let decDegSum = 0;
      for (const star of constellation.stars) {
        raHoursSum += star.raHours;
        decDegSum += star.decDeg;
        allStars.push({
          star,
          constellationId: constellation.id,
          constellationName: constellation.name,
        });
      }
      this.constellationRaHours.set(constellation.id, raHoursSum / constellation.stars.length);
      this.constellationDecDeg.set(constellation.id, decDegSum / constellation.stars.length);

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
      this.starByHip.set(star.hip, this.starEntries[this.starEntries.length - 1]);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(pointSizes, 1));
    geometry.setAttribute('opacity', new THREE.BufferAttribute(this.pointOpacities, 1));

    const pointsMaterial = new THREE.ShaderMaterial({
      uniforms: {
        sizeScale: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float sizeScale;
        attribute float size;
        attribute float opacity;
        varying float vOpacity;
        void main() {
          vOpacity = opacity;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * sizeScale * (380.0 / -mvPosition.z);
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

    this.hideIllustration(constellationId);
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

    const visible =
      line.mesh.userData.aboveHorizon === true && (this.showConstellations || progress > 0);
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
      const boosted = pointOpacity * this.visualBoost;
      this.pointOpacities[idx] = this.foundStars.has(entry.star.id)
        ? Math.min(1, boosted * 1.4)
        : Math.min(1, boosted);
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
      const startId = this.showConstellations
        ? line.fromId
        : (line.growFromId ?? line.fromId);
      const endId = this.showConstellations ? line.toId : (line.growToId ?? line.toId);
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
      const progress = this.showConstellations ? 1 : line.progress;
      this.setLineProgress(line.lineKey, progress);
    }

    this.updateIllustrationLayouts(date);
  }

  private isConstellationComplete(constellationId: string): boolean {
    const total = this.constellationStarCounts.get(constellationId) ?? 0;
    if (total === 0) return false;
    let found = 0;
    for (const entry of this.starEntries) {
      if (entry.constellationId !== constellationId) continue;
      if (this.foundStars.has(entry.star.id)) found++;
    }
    return found >= total;
  }

  private showAllConstellationOverlays(): void {
    for (const line of this.lineEntries) {
      line.progress = 1;
    }
    for (const constellationId of this.constellationStarCounts.keys()) {
      this.revealIllustration(constellationId);
      const entry = this.illustrationByConstellation.get(constellationId);
      if (!entry) continue;
      entry.fade = 1;
      const material = entry.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = ILLUSTRATION_MAX_OPACITY;
    }
  }

  private restoreGameConstellationOverlays(): void {
    for (const line of this.lineEntries) {
      const bothFound =
        this.foundStars.has(line.fromId) && this.foundStars.has(line.toId);
      if (!bothFound) {
        this.edgeAnimations.delete(line.lineKey);
        line.progress = 0;
        line.growFromId = null;
        line.growToId = null;
        this.setLineProgress(line.lineKey, 0);
        continue;
      }
      if (line.progress < 1) {
        this.setLineProgress(line.lineKey, line.progress);
        continue;
      }
      line.growFromId = line.fromId;
      line.growToId = line.toId;
      this.setLineProgress(line.lineKey, 1);
    }

    for (const constellationId of [...this.illustrationByConstellation.keys()]) {
      if (!this.isConstellationComplete(constellationId)) {
        this.hideIllustration(constellationId);
      }
    }
    for (const constellationId of this.constellationStarCounts.keys()) {
      if (this.isConstellationComplete(constellationId)) {
        this.revealIllustration(constellationId);
      }
    }
  }

  private revealIllustration(constellationId: string): void {
    if (this.illustrationByConstellation.has(constellationId)) return;

    const name = this.constellationNames.get(constellationId);
    const url = name ? constellationIllustrationUrl(name) : undefined;
    if (!url) return;

    const mesh = new THREE.Mesh(
      createStellariumIllustrationGeometry(),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
      }),
    );
    mesh.visible = false;
    mesh.renderOrder = -1;
    mesh.userData.constellationId = constellationId;
    this.illustrationsGroup.add(mesh);
    this.illustrationByConstellation.set(constellationId, {
      mesh,
      fade: 0,
    });

    this.textureLoader.load(url, (texture) => {
      if (!this.illustrationByConstellation.has(constellationId)) return;

      texture.colorSpace = THREE.SRGBColorSpace;
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.map = texture;
      material.side = THREE.DoubleSide;
      material.needsUpdate = true;
      mesh.visible = true;
      this.updateIllustrationLayout(constellationId);
    });
  }

  private hideIllustration(constellationId: string): void {
    const entry = this.illustrationByConstellation.get(constellationId);
    if (!entry) return;

    this.illustrationsGroup.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    const material = entry.mesh.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    material.dispose();
    this.illustrationByConstellation.delete(constellationId);
  }

  private clearAllIllustrations(): void {
    for (const constellationId of [...this.illustrationByConstellation.keys()]) {
      this.hideIllustration(constellationId);
    }
  }

  private updateIllustrationFades(dt: number): void {
    if (this.illustrationByConstellation.size === 0) return;

    const speed = 1 / ILLUSTRATION_FADE_DURATION;
    for (const entry of this.illustrationByConstellation.values()) {
      if (this.showConstellations) {
        entry.fade = 1;
        const material = entry.mesh.material as THREE.MeshBasicMaterial;
        material.opacity = ILLUSTRATION_MAX_OPACITY;
        continue;
      }
      if (entry.fade >= 1) continue;
      entry.fade = Math.min(entry.fade + speed * dt, 1);
      const material = entry.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = entry.fade * ILLUSTRATION_MAX_OPACITY;
    }
  }

  private updateIllustrationLayouts(date: Date): void {
    for (const constellationId of this.illustrationByConstellation.keys()) {
      this.updateIllustrationLayout(constellationId, date);
    }
  }

  private updateIllustrationLayout(constellationId: string, _date = new Date()): void {
    const entry = this.illustrationByConstellation.get(constellationId);
    if (!entry) return;

    const mesh = entry.mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;
    if (!material.map) return;

    const iau = this.constellationIau.get(constellationId) ?? '';
    const meta = getIllustrationMetadata(iau);
    if (!meta || meta.anchors.length < 3) return;

    const [texSizeX, texSizeY] = meta.size;
    const anchors = meta.anchors.slice(0, 3) as [
      (typeof meta.anchors)[0],
      (typeof meta.anchors)[0],
      (typeof meta.anchors)[0],
    ];

    const starDirs: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
      this.illustrationStarDir0,
      this.illustrationStarDir1,
      this.illustrationStarDir2,
    ];
    for (let i = 0; i < 3; i++) {
      const star = this.starByHip.get(anchors[i].hip);
      if (!star) return;
      starDirs[i].copy(star.glow.position).normalize();
    }

    if (
      !buildStellariumImageTransform(
        starDirs,
        anchors,
        texSizeX,
        texSizeY,
        this.illustrationTransform,
      )
    ) {
      return;
    }

    if (material.map) {
      material.map.flipY = false;
      material.map.needsUpdate = true;
    }

    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);

    updateStellariumIllustrationGeometry(
      mesh.geometry,
      this.illustrationTransform,
      texSizeX,
      texSizeY,
      SKY_SPHERE_RADIUS,
      ILLUSTRATION_INSET,
      this.illustrationProjectScratch,
    );
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
