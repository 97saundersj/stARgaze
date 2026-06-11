import * as THREE from 'three';
import type { WebGLRenderer } from 'three';

export interface TapResult {
  starId: string | null;
  isDecoy: boolean;
  mesh: THREE.Mesh | null;
}

export function createInputHandlers(
  renderer: WebGLRenderer,
  camera: THREE.Camera,
  getInteractiveMeshes: () => THREE.Mesh[],
  onTap: (result: TapResult) => void,
  onAnyTap: () => void,
  getPhase: () => string,
  isSkyLookActive: () => boolean,
  trySkyStarTap: ((clientX: number, clientY: number) => boolean) | null,
  trySkyStarTapFromRay: ((origin: THREE.Vector3, direction: THREE.Vector3) => boolean) | null,
): { dispose: () => void; updateXR: (frame: XRFrame) => void } {
  const raycaster = new THREE.Raycaster();
  raycaster.near = 0.01;
  raycaster.far = 20;

  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();

  let isDragging = false;
  let activePointerId: number | null = null;
  let xrSelecting = false;
  let arPointerDownX = 0;
  let arPointerDownY = 0;
  let arPointerActive = false;
  const AR_TAP_THRESHOLD_PX = 20;

  function getActiveCamera(): THREE.Camera {
    return renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  }

  function resolveTapTarget(object: THREE.Object3D): THREE.Mesh | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (current instanceof THREE.Mesh && (current.userData.starId || current.userData.isDecoy)) {
        return current;
      }
      current = current.parent;
    }
    return object instanceof THREE.Mesh ? object : null;
  }

  function castFromRay(rayOrigin: THREE.Vector3, rayDirection: THREE.Vector3): TapResult {
    raycaster.set(rayOrigin, rayDirection.normalize());
    const meshes = getInteractiveMeshes();
    const hits = raycaster.intersectObjects(meshes, true);

    if (hits.length === 0) {
      return { starId: null, isDecoy: false, mesh: null };
    }

    const mesh = resolveTapTarget(hits[0].object);
    if (!mesh) {
      return { starId: null, isDecoy: false, mesh: null };
    }

    if (mesh.userData.isDecoy) {
      return { starId: null, isDecoy: true, mesh };
    }

    return {
      starId: (mesh.userData.starId as string) ?? null,
      isDecoy: false,
      mesh,
    };
  }

  function castFromNdc(ndc: THREE.Vector2): TapResult {
    raycaster.setFromCamera(ndc, getActiveCamera());
    const meshes = getInteractiveMeshes();
    const hits = raycaster.intersectObjects(meshes, true);

    if (hits.length === 0) {
      return { starId: null, isDecoy: false, mesh: null };
    }

    const mesh = resolveTapTarget(hits[0].object);
    if (!mesh) {
      return { starId: null, isDecoy: false, mesh: null };
    }

    if (mesh.userData.isDecoy) {
      return { starId: null, isDecoy: true, mesh };
    }

    return {
      starId: (mesh.userData.starId as string) ?? null,
      isDecoy: false,
      mesh,
    };
  }

  function castFromXRInput(frame: XRFrame, inputSource: XRInputSource): TapResult | null {
    const referenceSpace = renderer.xr.getReferenceSpace();
    if (!referenceSpace) return null;

    const pose = frame.getPose(inputSource.targetRaySpace, referenceSpace);
    if (!pose) return null;

    origin.set(
      pose.transform.position.x,
      pose.transform.position.y,
      pose.transform.position.z,
    );
    quaternion.set(
      pose.transform.orientation.x,
      pose.transform.orientation.y,
      pose.transform.orientation.z,
      pose.transform.orientation.w,
    );
    direction.set(0, 0, -1).applyQuaternion(quaternion);

    return castFromRay(origin, direction);
  }

  function handleTapResult(result: TapResult): void {
    onTap(result);
  }

  function ndcFromEvent(event: PointerEvent): THREE.Vector2 {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  function handlePointerInteraction(event: PointerEvent): boolean {
    if (renderer.xr.isPresenting) {
      return trySkyStarTap?.(event.clientX, event.clientY) ?? false;
    }
    if (trySkyStarTap?.(event.clientX, event.clientY)) return true;
    handleTapResult(castFromNdc(ndcFromEvent(event)));
    return false;
  }

  function endDrag(event: PointerEvent): void {
    if (activePointerId !== event.pointerId) return;
    isDragging = false;
    activePointerId = null;
    renderer.domElement.releasePointerCapture(event.pointerId);
  }

  function onPointerDown(event: PointerEvent): void {
    if (renderer.xr.isPresenting) {
      arPointerActive = true;
      arPointerDownX = event.clientX;
      arPointerDownY = event.clientY;
      return;
    }

    if (isSkyLookActive()) return;

    const phase = getPhase();
    if (phase === 'theQuestion') {
      onAnyTap();
      return;
    }
    if (phase !== 'findStars' || renderer.xr.isPresenting) return;

    isDragging = true;
    activePointerId = event.pointerId;
    renderer.domElement.setPointerCapture(event.pointerId);
    handlePointerInteraction(event);
  }

  function onPointerMove(event: PointerEvent): void {
    if (isSkyLookActive()) return;
    if (!isDragging || activePointerId !== event.pointerId) return;
    if (getPhase() !== 'findStars' || renderer.xr.isPresenting) return;

    handlePointerInteraction(event);
  }

  function onPointerUp(event: PointerEvent): void {
    if (renderer.xr.isPresenting && arPointerActive) {
      const dx = event.clientX - arPointerDownX;
      const dy = event.clientY - arPointerDownY;
      if (dx * dx + dy * dy < AR_TAP_THRESHOLD_PX * AR_TAP_THRESHOLD_PX) {
        trySkyStarTap?.(event.clientX, event.clientY);
      }
      arPointerActive = false;
      return;
    }

    if (isSkyLookActive()) return;
    endDrag(event);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (renderer.xr.isPresenting) {
      arPointerActive = false;
      return;
    }

    if (isSkyLookActive()) return;
    endDrag(event);
  }

  function onSelect(event: XRSessionEvent & { frame: XRFrame; inputSource: XRInputSource }): void {
    const phase = getPhase();
    if (phase === 'theQuestion') {
      onAnyTap();
      return;
    }

    if (trySkyStarTapFromRay && renderer.xr.isPresenting) {
      const referenceSpace = renderer.xr.getReferenceSpace();
      if (referenceSpace) {
        const pose = event.frame.getPose(event.inputSource.targetRaySpace, referenceSpace);
        if (pose) {
          origin.set(
            pose.transform.position.x,
            pose.transform.position.y,
            pose.transform.position.z,
          );
          quaternion.set(
            pose.transform.orientation.x,
            pose.transform.orientation.y,
            pose.transform.orientation.z,
            pose.transform.orientation.w,
          );
          direction.set(0, 0, -1).applyQuaternion(quaternion);
          if (trySkyStarTapFromRay(origin, direction)) return;
        }
      }
    }

    if (phase !== 'findStars') return;

    const result = castFromXRInput(event.frame, event.inputSource);
    if (result) handleTapResult(result);
  }

  function onSelectStart(): void {
    if (getPhase() === 'findStars') {
      xrSelecting = true;
    }
  }

  function onSelectEnd(): void {
    xrSelecting = false;
  }

  function bindSession(session: XRSession): void {
    session.addEventListener('select', onSelect as EventListener);
    session.addEventListener('selectstart', onSelectStart);
    session.addEventListener('selectend', onSelectEnd);
  }

  function unbindSession(session: XRSession): void {
    session.removeEventListener('select', onSelect as EventListener);
    session.removeEventListener('selectstart', onSelectStart);
    session.removeEventListener('selectend', onSelectEnd);
    xrSelecting = false;
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerCancel);

  const xrSession = renderer.xr;
  let boundSession: XRSession | null = null;

  xrSession.addEventListener('sessionstart', () => {
    const session = xrSession.getSession();
    if (!session) return;
    boundSession = session;
    bindSession(session);
  });

  xrSession.addEventListener('sessionend', () => {
    if (boundSession) {
      unbindSession(boundSession);
      boundSession = null;
    }
  });

  function updateXR(frame: XRFrame): void {
    if (!xrSelecting || getPhase() !== 'findStars') return;

    const session = renderer.xr.getSession();
    if (!session) return;

    for (const inputSource of session.inputSources) {
      const result = castFromXRInput(frame, inputSource);
      if (result) {
        handleTapResult(result);
        break;
      }
    }
  }

  return {
    dispose: () => {
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerCancel);
      if (boundSession) unbindSession(boundSession);
    },
    updateXR,
  };
}
