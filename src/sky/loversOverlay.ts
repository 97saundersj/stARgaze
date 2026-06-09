import * as THREE from 'three';

const OVERLAY_OFFSET = new THREE.Vector3(0.55, -0.1, -1.35);
const OVERLAY_SCALE = 0.8;

export class LoversOverlay {
  readonly group = new THREE.Group();

  constructor() {
    this.group.position.copy(OVERLAY_OFFSET);
    this.group.scale.setScalar(OVERLAY_SCALE);
  }

  attachToCamera(camera: THREE.Camera): void {
    camera.add(this.group);
  }

  detachFromCamera(camera: THREE.Camera): void {
    camera.remove(this.group);
  }

  mountConstellation(constellationGroup: THREE.Group): void {
    if (constellationGroup.parent !== this.group) {
      this.group.add(constellationGroup);
    }
  }

  unmountConstellation(constellationGroup: THREE.Group, targetParent: THREE.Object3D): void {
    if (constellationGroup.parent === this.group) {
      targetParent.add(constellationGroup);
    }
  }
}
