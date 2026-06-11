import * as THREE from 'three';

export interface IllustrationAnchor {
  pos: [number, number];
}

/** Grid segments per axis; Stellarium uses 4 (5 sample lines). */
export const ILLUSTRATION_TESSELLATION_DIVISIONS = 16;

/**
 * Stellarium constellation-artwork placement (ConstellationMgr.cpp).
 * Three texture anchors map to three star directions via X = B * inv(A), then each
 * pixel is projected onto the unit sphere and normalized.
 */
export function buildStellariumImageTransform(
  starDirs: [THREE.Vector3, THREE.Vector3, THREE.Vector3],
  anchors: [IllustrationAnchor, IllustrationAnchor, IllustrationAnchor],
  texSizeX: number,
  texSizeY: number,
  transformOut: THREE.Matrix4,
): boolean {
  const [s1, s2, s3] = starDirs;
  const s4 = new THREE.Vector3()
    .copy(s2)
    .sub(s1)
    .cross(new THREE.Vector3().copy(s3).sub(s1))
    .add(s1);

  const [x1, y1] = anchors[0].pos;
  const [x2, y2] = anchors[1].pos;
  const [x3, y3] = anchors[2].pos;
  const fy1 = texSizeY - y1;
  const fy2 = texSizeY - y2;
  const fy3 = texSizeY - y3;

  const mA = new THREE.Matrix4().set(
    x1, x2, x3, x1,
    fy1, fy2, fy3, fy1,
    0, 0, 0, texSizeX,
    1, 1, 1, 1,
  );
  const mB = new THREE.Matrix4().set(
    s1.x, s2.x, s3.x, s4.x,
    s1.y, s2.y, s3.y, s4.y,
    s1.z, s2.z, s3.z, s4.z,
    1, 1, 1, 1,
  );

  const mAInv = mA.clone().invert();
  if (!Number.isFinite(mAInv.elements[0])) return false;

  transformOut.copy(mB).multiply(mAInv);
  return true;
}

export function projectStellariumTexCoord(
  transform: THREE.Matrix4,
  px: number,
  py: number,
  target: THREE.Vector3,
): void {
  target.set(px, py, 0).applyMatrix4(transform).normalize();
}

function pushTri(
  positions: number[],
  uvs: number[],
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
): void {
  positions.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
  uvs.push(u0, v0, u1, v1, u2, v2);
}

/** Curved sky patch matching Stellarium's triangle tessellation over the full texture. */
export function createStellariumIllustrationGeometry(
  divisions = ILLUSTRATION_TESSELLATION_DIVISIONS,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];

  for (let j = 0; j < divisions; j++) {
    const v0 = j / divisions;
    const v1 = (j + 1) / divisions;
    for (let i = 0; i < divisions; i++) {
      const u0 = i / divisions;
      const u1 = (i + 1) / divisions;
      pushTri(positions, uvs, u0, v0, u1, v0, u0, v1);
      pushTri(positions, uvs, u1, v0, u1, v1, u0, v1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

export function updateStellariumIllustrationGeometry(
  geometry: THREE.BufferGeometry,
  transform: THREE.Matrix4,
  texSizeX: number,
  texSizeY: number,
  sphereRadius: number,
  inset: number,
  scratch: THREE.Vector3,
): void {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const r = sphereRadius - inset;

  for (let i = 0; i < posAttr.count; i++) {
    const u = uvAttr.getX(i);
    const v = uvAttr.getY(i);
    projectStellariumTexCoord(transform, u * texSizeX, v * texSizeY, scratch);
    posAttr.setXYZ(i, scratch.x * r, scratch.y * r, scratch.z * r);
  }

  posAttr.needsUpdate = true;
  geometry.computeBoundingSphere();
}
