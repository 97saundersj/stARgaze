import * as THREE from 'three';
import { SKY_SPHERE_RADIUS } from './skyMath';

const SKY_DOME_VERTEX = `
  varying float vAltitude;
  void main() {
    vAltitude = asin(clamp(position.y / ${SKY_SPHERE_RADIUS.toFixed(1)}, -1.0, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_DOME_FRAGMENT = `
  varying float vAltitude;

  vec3 colorAtAltitude(float altRad) {
    float altDeg = degrees(altRad);
    vec3 zenith = vec3(0.039, 0.051, 0.102);
    vec3 mid = vec3(0.071, 0.094, 0.165);
    vec3 low = vec3(0.102, 0.082, 0.125);
    vec3 horizon = vec3(0.239, 0.180, 0.102);

    if (altDeg >= 15.0) {
      float t = clamp((altDeg - 15.0) / 75.0, 0.0, 1.0);
      return mix(mid, zenith, t);
    }
    if (altDeg >= 5.0) {
      float t = clamp((altDeg - 5.0) / 10.0, 0.0, 1.0);
      return mix(low, mid, t);
    }
    if (altDeg >= 0.0) {
      float t = clamp(altDeg / 5.0, 0.0, 1.0);
      return mix(horizon, low, t);
    }
    return horizon;
  }

  void main() {
    if (vAltitude < 0.0) discard;
    vec3 color = colorAtAltitude(vAltitude);
    float edge = smoothstep(0.0, radians(4.0), vAltitude);
    gl_FragColor = vec4(color, edge);
  }
`;

/** Narrow slice around the equator — inner surface visible from the observer. */
const HORIZON_BAND_VERTEX = `
  varying float vAltitude;
  void main() {
    vAltitude = asin(clamp(position.y / ${SKY_SPHERE_RADIUS.toFixed(1)}, -1.0, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HORIZON_BAND_FRAGMENT = `
  varying float vAltitude;

  void main() {
    float altDeg = degrees(vAltitude);
    float halfBand = 3.5;
    float dist = abs(altDeg);
    if (dist > halfBand) discard;

    vec3 color = vec3(0.239, 0.180, 0.102);
    float alpha = 1.0 - smoothstep(halfBand * 0.35, halfBand, dist);
    gl_FragColor = vec4(color, alpha * 0.75);
  }
`;

export type HorizonMode = 'hidden' | 'sky' | 'ar';

export class HorizonVisual {
  readonly group = new THREE.Group();
  private readonly skyDome: THREE.Mesh;
  private readonly horizonBand: THREE.Mesh;

  constructor() {
    const skyGeometry = new THREE.SphereGeometry(
      SKY_SPHERE_RADIUS,
      64,
      32,
      0,
      Math.PI * 2,
      0,
      Math.PI / 2,
    );
    this.skyDome = new THREE.Mesh(
      skyGeometry,
      new THREE.ShaderMaterial({
        vertexShader: SKY_DOME_VERTEX,
        fragmentShader: SKY_DOME_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
        transparent: true,
      }),
    );
    this.skyDome.renderOrder = -2;
    this.skyDome.frustumCulled = false;

    const bandPhi = THREE.MathUtils.degToRad(4);
    const bandGeometry = new THREE.SphereGeometry(
      SKY_SPHERE_RADIUS,
      96,
      8,
      0,
      Math.PI * 2,
      Math.PI / 2 - bandPhi,
      bandPhi * 2,
    );
    this.horizonBand = new THREE.Mesh(
      bandGeometry,
      new THREE.ShaderMaterial({
        vertexShader: HORIZON_BAND_VERTEX,
        fragmentShader: HORIZON_BAND_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.horizonBand.renderOrder = -1;
    this.horizonBand.frustumCulled = false;

    this.group.add(this.skyDome);
    this.group.add(this.horizonBand);
    this.setMode('hidden');
  }

  setMode(mode: HorizonMode): void {
    this.skyDome.visible = mode === 'sky';
    this.horizonBand.visible = mode === 'ar';
    this.group.visible = mode !== 'hidden';
  }

  mount(scene: THREE.Scene): void {
    if (this.group.parent !== scene) {
      scene.add(this.group);
    }
    this.resetTransform();
  }

  resetTransform(): void {
    this.group.position.set(0, 0, 0);
    this.group.rotation.set(0, 0, 0);
  }

  followPosition(camera: THREE.Camera): void {
    camera.getWorldPosition(this.group.position);
    this.group.rotation.set(0, 0, 0);
  }
}
