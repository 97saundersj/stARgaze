import * as THREE from 'three';
import {
  DeviceOrientationController,
  getViewerYawRadians,
  isDeviceOrientationSupported,
} from './deviceOrientation';
import { SkyScene, type SkyTapResult } from './SkyScene';
import { LoversOverlay } from './loversOverlay';

export type SkyModeState = 'idle' | 'active' | 'error';

export interface SkyModeController {
  readonly skyScene: SkyScene;
  readonly deviceOrientation: DeviceOrientationController;
  readonly loversOverlay: LoversOverlay;
  readonly state: SkyModeState;
  readonly errorMessage: string | null;
  start: (domElement: HTMLElement) => Promise<void>;
  stop: () => void;
  update: (timeMs: number, dt: number) => void;
  applyCameraOrientation: (camera: THREE.PerspectiveCamera) => void;
  followSkyToCamera: (
    camera: THREE.Camera,
    alignNorthForXr: boolean,
    worldParent?: THREE.Object3D,
  ) => void;
  detachSkyToScene: (sceneRoot: THREE.Object3D) => void;
  captureArNorthOffset: (camera: THREE.Camera) => boolean;
  hasArNorthAlignment: () => boolean;
  setLookActive: (active: boolean) => void;
  setSkyTapActive: (active: boolean) => void;
  setOrientationDrivingCamera: (active: boolean) => void;
  setArSkyMode: (active: boolean) => void;
  releaseInteraction: () => void;
  applySessionNorthAlignment: () => boolean;
  beginArNorthCapture: () => void;
  snapshotSkyOrientation: (camera: THREE.PerspectiveCamera) => void;
  setCameraProvider: (provider: () => THREE.Camera) => void;
  setStarTapHandler: (handler: (result: SkyTapResult) => void) => void;
  setShowConstellations: (show: boolean) => void;
  tryTapAt: (clientX: number, clientY: number, domElement: HTMLElement) => SkyTapResult | null;
  tryTapFromRay: (origin: THREE.Vector3, direction: THREE.Vector3) => SkyTapResult | null;
}

const DRAG_SENSITIVITY = 0.004;
const TAP_THRESHOLD_PX = 18;
const AR_NORTH_SAMPLE_COUNT = 12;
const AR_NORTH_PRECALIBRATED_SAMPLE_COUNT = 3;
const AR_NORTH_MAX_SAMPLE_SPREAD = THREE.MathUtils.degToRad(12);
const AR_SKY_VISUAL_BOOST = 2.2;
const SKY_NORTH_TRACKING = 0.14;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const northCompensateQuat = new THREE.Quaternion();
const northDevConjugate = new THREE.Quaternion();
const northTempDrag = new THREE.Quaternion();
const northDragEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const northTempEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function circularMeanRadians(angles: number[]): number {
  let sinSum = 0;
  let cosSum = 0;
  for (const angle of angles) {
    sinSum += Math.sin(angle);
    cosSum += Math.cos(angle);
  }
  return Math.atan2(sinSum, cosSum);
}

function normalizeRadians(angle: number): number {
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

/** Rotate drag so a sky-dome Y offset change does not move stars on screen. */
function compensateDragForSkyOffsetDelta(
  delta: number,
  deviceQuat: THREE.Quaternion,
  dragPitch: number,
  dragYaw: number,
): { dragPitch: number; dragYaw: number } {
  if (Math.abs(delta) < 1e-6) {
    return { dragPitch, dragYaw };
  }

  northCompensateQuat.setFromAxisAngle(Y_AXIS, delta);
  northDevConjugate.copy(deviceQuat).conjugate();
  northDragEuler.set(dragPitch, dragYaw, 0);
  northTempDrag.setFromEuler(northDragEuler);
  northTempDrag
    .copy(northDevConjugate)
    .multiply(northCompensateQuat)
    .multiply(deviceQuat)
    .multiply(northTempDrag);

  northTempEuler.setFromQuaternion(northTempDrag, 'YXZ');
  return { dragPitch: northTempEuler.x, dragYaw: northTempEuler.y };
}

export function createSkyModeController(): SkyModeController {
  const skyScene = new SkyScene();
  const deviceOrientation = new DeviceOrientationController();
  const loversOverlay = new LoversOverlay();
  const dragQuaternion = new THREE.Quaternion();
  const dragEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  let state: SkyModeState = 'idle';
  let errorMessage: string | null = null;
  let lookActive = false;
  let skyTapActive = false;
  let orientationDrivesCamera = true;
  let activePointerId: number | null = null;
  let domElement: HTMLElement | null = null;
  let getCamera: (() => THREE.Camera) | null = null;
  let onStarTap: ((result: SkyTapResult) => void) | null = null;
  let dragYaw = 0;
  let dragPitch = -0.35;
  let isDragging = false;
  let pointerDown = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let downPointerX = 0;
  let downPointerY = 0;
  let skyNorthOffsetY = 0;
  let arNorthOffsetY = 0;
  let arNorthAligned = false;
  let sessionNorthOffsetY: number | null = null;
  let sessionNorthAligned = false;
  let skyReferenceYaw: number | null = null;
  const arNorthSamples: number[] = [];
  const skyWorldPosition = new THREE.Vector3();

  const applySkyNorthOffsetDelta = (delta: number): void => {
    if (Math.abs(delta) < 1e-5) return;
    const compensated = compensateDragForSkyOffsetDelta(
      delta,
      deviceOrientation.displayQuaternion,
      dragPitch,
      dragYaw,
    );
    dragPitch = compensated.dragPitch;
    dragYaw = compensated.dragYaw;
    skyNorthOffsetY = normalizeRadians(skyNorthOffsetY + delta);
  };

  const targetSkyNorthOffset = (): number | null => {
    const compassDeg = deviceOrientation.getSmoothedCompassHeading();
    if (compassDeg === null) return null;
    return normalizeRadians(
      THREE.MathUtils.degToRad(compassDeg) - deviceOrientation.getHorizontalViewYaw(),
    );
  };

  const trackSkyNorthAlignment = (): void => {
    if (deviceOrientation.isNorthCalibrated) return;

    const targetOffset = targetSkyNorthOffset();
    if (targetOffset === null) return;

    const delta = normalizeRadians(targetOffset - skyNorthOffsetY);
    if (Math.abs(delta) < 1e-5) return;

    applySkyNorthOffsetDelta(delta * SKY_NORTH_TRACKING);
  };

  const finalizeSkyNorthAlignment = (): void => {
    const targetOffset = targetSkyNorthOffset();
    if (targetOffset === null) return;
    applySkyNorthOffsetDelta(normalizeRadians(targetOffset - skyNorthOffsetY));
  };

  const attachLookControls = (element: HTMLElement): void => {
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
  };

  const detachLookControls = (element: HTMLElement): void => {
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerUp);
  };

  const tryTapAt = (clientX: number, clientY: number, element: HTMLElement): SkyTapResult | null => {
    if (!getCamera) return null;
    const rect = element.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    return skyScene.tapFromNdc(ndc, getCamera(), rect.width, rect.height);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (state !== 'active' || (!lookActive && !skyTapActive)) return;
    pointerDown = true;
    isDragging = false;
    downPointerX = event.clientX;
    downPointerY = event.clientY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!lookActive || !pointerDown || state !== 'active') return;

    const totalDx = event.clientX - downPointerX;
    const totalDy = event.clientY - downPointerY;
    if (!isDragging && totalDx * totalDx + totalDy * totalDy < TAP_THRESHOLD_PX * TAP_THRESHOLD_PX) {
      return;
    }

    if (!isDragging) {
      isDragging = true;
      activePointerId = event.pointerId;
      domElement?.setPointerCapture(event.pointerId);
    }

    const dx = event.clientX - lastPointerX;
    const dy = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    dragYaw -= dx * DRAG_SENSITIVITY;
    dragPitch -= dy * DRAG_SENSITIVITY;
    dragPitch = THREE.MathUtils.clamp(dragPitch, -Math.PI / 2 + 0.1, Math.PI / 2 - 0.1);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!pointerDown) return;
    pointerDown = false;

    const totalDx = event.clientX - downPointerX;
    const totalDy = event.clientY - downPointerY;
    const isTap = totalDx * totalDx + totalDy * totalDy < TAP_THRESHOLD_PX * TAP_THRESHOLD_PX;

    if (isTap && domElement && lookActive) {
      const result = tryTapAt(event.clientX, event.clientY, domElement);
      if (result) onStarTap?.(result);
    }

    if (isDragging && activePointerId !== null && domElement?.hasPointerCapture(activePointerId)) {
      domElement.releasePointerCapture(activePointerId);
    }
    isDragging = false;
    activePointerId = null;
  };

  return {
    skyScene,
    deviceOrientation,
    loversOverlay,
    get state() {
      return state;
    },
    get errorMessage() {
      return errorMessage;
    },
    async start(element: HTMLElement) {
      errorMessage = null;
      domElement = element;
      attachLookControls(element);

      if (isDeviceOrientationSupported()) {
        const permitted = await deviceOrientation.requestPermissions();
        if (!permitted) {
          errorMessage = 'Motion permission denied. Drag to look around.';
        } else {
          try {
            const location = await deviceOrientation.requestGeolocation();
            skyScene.setObserver(location);
          } catch {
            errorMessage = 'Location unavailable. Using default observer (Paris).';
          }
          deviceOrientation.setOnNorthLocked(() => finalizeSkyNorthAlignment());
          deviceOrientation.start();
        }
      }

      state = 'active';
    },
    stop() {
      if (domElement) {
        detachLookControls(domElement);
        domElement = null;
      }
      deviceOrientation.stop();
      skyScene.resetProgress();
      state = 'idle';
      lookActive = false;
      skyTapActive = false;
      orientationDrivesCamera = true;
      errorMessage = null;
      isDragging = false;
      pointerDown = false;
      activePointerId = null;
      dragYaw = 0;
      dragPitch = -0.35;
      skyNorthOffsetY = 0;
      arNorthOffsetY = 0;
      arNorthAligned = false;
      sessionNorthOffsetY = null;
      sessionNorthAligned = false;
      skyReferenceYaw = null;
      arNorthSamples.length = 0;
    },
    update(timeMs: number, dt: number) {
      if (state !== 'active') return;
      if (orientationDrivesCamera) {
        deviceOrientation.update();
        trackSkyNorthAlignment();
      }
      skyScene.update(timeMs, dt);
    },
    applyCameraOrientation(camera: THREE.PerspectiveCamera) {
      camera.position.set(0, 0, 0);
      dragEuler.set(dragPitch, dragYaw, 0);
      dragQuaternion.setFromEuler(dragEuler);

      if (
        orientationDrivesCamera &&
        deviceOrientation.isActive &&
        deviceOrientation.hasOrientationData
      ) {
        camera.quaternion.copy(deviceOrientation.displayQuaternion).multiply(dragQuaternion);
        return;
      }

      camera.quaternion.copy(dragQuaternion);
    },
    applySessionNorthAlignment() {
      if (!sessionNorthAligned || sessionNorthOffsetY === null) return false;
      arNorthOffsetY = sessionNorthOffsetY;
      arNorthAligned = true;
      arNorthSamples.length = 0;
      return true;
    },
    snapshotSkyOrientation(camera: THREE.PerspectiveCamera) {
      skyReferenceYaw = getViewerYawRadians(camera);
    },
    beginArNorthCapture() {
      arNorthAligned = false;
      arNorthSamples.length = 0;
    },
    captureArNorthOffset(camera: THREE.Camera) {
      if (arNorthAligned) return true;

      if (skyReferenceYaw !== null) {
        const xrYaw = getViewerYawRadians(camera);
        arNorthOffsetY = normalizeRadians(skyNorthOffsetY + skyReferenceYaw - xrYaw);
        arNorthAligned = true;
        sessionNorthOffsetY = arNorthOffsetY;
        sessionNorthAligned = true;
        skyReferenceYaw = null;
        arNorthSamples.length = 0;
        return true;
      }

      if (this.applySessionNorthAlignment()) return true;

      deviceOrientation.update();
      const offset = normalizeRadians(
        skyNorthOffsetY +
          deviceOrientation.getHorizontalViewYaw() -
          getViewerYawRadians(camera),
      );

      arNorthSamples.push(offset);
      const requiredSamples = deviceOrientation.isNorthCalibrated
        ? AR_NORTH_PRECALIBRATED_SAMPLE_COUNT
        : AR_NORTH_SAMPLE_COUNT;
      if (arNorthSamples.length < requiredSamples) return false;

      const mean = circularMeanRadians(arNorthSamples);
      let maxSpread = 0;
      for (const sample of arNorthSamples) {
        let delta = sample - mean;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        maxSpread = Math.max(maxSpread, Math.abs(delta));
      }

      arNorthSamples.length = 0;
      if (maxSpread > AR_NORTH_MAX_SAMPLE_SPREAD) return false;

      arNorthOffsetY = mean;
      arNorthAligned = true;
      sessionNorthOffsetY = mean;
      sessionNorthAligned = true;
      return true;
    },
    hasArNorthAlignment() {
      return arNorthAligned;
    },
    followSkyToCamera(camera: THREE.Camera, alignNorthForXr: boolean, worldParent?: THREE.Object3D) {
      if (alignNorthForXr) {
        const parent = worldParent ?? skyScene.group.parent;
        if (!parent) return;

        if (skyScene.group.parent !== parent) {
          skyScene.group.parent?.remove(skyScene.group);
          parent.add(skyScene.group);
        }

        camera.getWorldPosition(skyWorldPosition);
        skyScene.group.position.copy(skyWorldPosition);
        skyScene.group.rotation.set(0, arNorthOffsetY, 0);
        return;
      }

      if (worldParent && skyScene.group.parent !== worldParent) {
        skyScene.group.parent?.remove(skyScene.group);
        worldParent.add(skyScene.group);
      }
      skyScene.group.position.set(0, 0, 0);
      skyScene.group.rotation.set(0, skyNorthOffsetY, 0);
    },
    detachSkyToScene(sceneRoot: THREE.Object3D) {
      if (skyScene.group.parent === sceneRoot) return;
      skyScene.group.parent?.remove(skyScene.group);
      sceneRoot.add(skyScene.group);
      skyScene.group.position.set(0, 0, 0);
      skyScene.group.rotation.set(0, skyNorthOffsetY, 0);
    },
    setLookActive(active: boolean) {
      lookActive = active;
      if (active) {
        skyTapActive = true;
      }
      if (!active) {
        isDragging = false;
        pointerDown = false;
      }
    },
    setSkyTapActive(active: boolean) {
      skyTapActive = active;
      if (!active) {
        pointerDown = false;
      }
    },
    setOrientationDrivingCamera(active: boolean) {
      orientationDrivesCamera = active;
    },
    setArSkyMode(active: boolean) {
      skyScene.setVisualBoost(active ? AR_SKY_VISUAL_BOOST : 1);
    },
    releaseInteraction() {
      if (activePointerId !== null && domElement?.hasPointerCapture(activePointerId)) {
        domElement.releasePointerCapture(activePointerId);
      }
      isDragging = false;
      pointerDown = false;
      activePointerId = null;
    },
    setCameraProvider(provider: () => THREE.Camera) {
      getCamera = provider;
    },
    setStarTapHandler(handler: (result: SkyTapResult) => void) {
      onStarTap = handler;
    },
    setShowConstellations(show: boolean) {
      skyScene.setShowConstellations(show);
    },
    tryTapAt,
    tryTapFromRay(origin: THREE.Vector3, direction: THREE.Vector3) {
      return skyScene.tapFromRay(origin, direction);
    },
  };
}
