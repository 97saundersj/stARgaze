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
  setCameraProvider: (provider: () => THREE.Camera) => void;
  setStarTapHandler: (handler: (result: SkyTapResult) => void) => void;
  tryTapAt: (clientX: number, clientY: number, domElement: HTMLElement) => SkyTapResult | null;
}

const DRAG_SENSITIVITY = 0.004;
const TAP_THRESHOLD_PX = 18;
const AR_NORTH_SAMPLE_COUNT = 8;

function circularMeanRadians(angles: number[]): number {
  let sinSum = 0;
  let cosSum = 0;
  for (const angle of angles) {
    sinSum += Math.sin(angle);
    cosSum += Math.cos(angle);
  }
  return Math.atan2(sinSum, cosSum);
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
  let arNorthOffsetY = 0;
  let arNorthAligned = false;
  const arNorthSamples: number[] = [];

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
    if (!lookActive || state !== 'active') return;
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

    if (isTap && domElement) {
      const result = tryTapAt(event.clientX, event.clientY, domElement);
      if (result) onStarTap?.(result);
    }

    if (isDragging && domElement?.hasPointerCapture(event.pointerId)) {
      domElement.releasePointerCapture(event.pointerId);
    }
    isDragging = false;
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
      errorMessage = null;
      isDragging = false;
      pointerDown = false;
      dragYaw = 0;
      dragPitch = -0.35;
      arNorthOffsetY = 0;
      arNorthAligned = false;
      arNorthSamples.length = 0;
    },
    update(timeMs: number, dt: number) {
      if (state !== 'active') return;
      deviceOrientation.update();
      skyScene.update(timeMs, dt);
    },
    applyCameraOrientation(camera: THREE.PerspectiveCamera) {
      camera.position.set(0, 0, 0);
      dragEuler.set(dragPitch, dragYaw, 0);
      dragQuaternion.setFromEuler(dragEuler);

      if (deviceOrientation.isActive && deviceOrientation.hasOrientationData) {
        camera.quaternion.copy(deviceOrientation.displayQuaternion).multiply(dragQuaternion);
        return;
      }

      camera.quaternion.copy(dragQuaternion);
    },
    captureArNorthOffset(camera: THREE.Camera) {
      deviceOrientation.update();
      const offset = deviceOrientation.getSkyNorthOffsetRadians(getViewerYawRadians(camera));
      if (offset === null) return false;

      arNorthSamples.push(offset);
      if (arNorthSamples.length < AR_NORTH_SAMPLE_COUNT) return false;

      arNorthOffsetY = circularMeanRadians(arNorthSamples);
      arNorthAligned = true;
      arNorthSamples.length = 0;
      return true;
    },
    hasArNorthAlignment() {
      return arNorthAligned;
    },
    followSkyToCamera(camera: THREE.Camera, alignNorthForXr: boolean, worldParent?: THREE.Object3D) {
      if (alignNorthForXr) {
        if (skyScene.group.parent !== camera) {
          skyScene.group.parent?.remove(skyScene.group);
          camera.add(skyScene.group);
        }
        skyScene.group.position.set(0, 0, 0);
        skyScene.group.rotation.set(0, arNorthOffsetY, 0);
        return;
      }

      if (worldParent && skyScene.group.parent !== worldParent) {
        skyScene.group.parent?.remove(skyScene.group);
        worldParent.add(skyScene.group);
      }
      skyScene.group.position.set(0, 0, 0);
      skyScene.group.rotation.set(0, 0, 0);
    },
    detachSkyToScene(sceneRoot: THREE.Object3D) {
      if (skyScene.group.parent === sceneRoot) return;
      skyScene.group.parent?.remove(skyScene.group);
      sceneRoot.add(skyScene.group);
      skyScene.group.position.set(0, 0, 0);
      skyScene.group.rotation.set(0, 0, 0);
    },
    setLookActive(active: boolean) {
      lookActive = active;
      if (!active) {
        isDragging = false;
        pointerDown = false;
      }
    },
    setCameraProvider(provider: () => THREE.Camera) {
      getCamera = provider;
    },
    setStarTapHandler(handler: (result: SkyTapResult) => void) {
      onStarTap = handler;
    },
    tryTapAt,
  };
}
