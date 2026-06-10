import * as THREE from 'three';
import { ConstellationScene } from './constellationScene';
import { createPhaseController } from './phases';
import { createInputHandlers } from './input';
import { createMessageOverlay } from './messageOverlay';
import { createSkyModeController } from './sky/skyMode';
import type { SkyTapResult } from './sky/SkyScene';
import {
  ARPlacement,
  createARButton,
  isARSupported,
  setupXRRenderer,
} from './xr';

type AppMode = 'preview' | 'sky' | 'ar';

const overlayEl = document.getElementById('overlay')!;
const instructionEl = document.getElementById('instruction')!;
const previewBanner = document.getElementById('preview-banner')!;
const arButtonContainer = document.getElementById('ar-button-container')!;
const messageOverlay = createMessageOverlay(document.getElementById('message')!);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
const PREVIEW_CAMERA = new THREE.Vector3(0, 1.4, 0);
const PREVIEW_TARGET = new THREE.Vector3(0, 1.4, -1.5);
const PREVIEW_FAR = 20;
const SKY_FAR = 1000;

camera.position.copy(PREVIEW_CAMERA);
camera.lookAt(PREVIEW_TARGET);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x0a0d1a, 1);
document.body.appendChild(renderer.domElement);

setupXRRenderer(renderer);

const constellationScene = new ConstellationScene();
scene.add(constellationScene.group);

const skyMode = createSkyModeController();
const placement = new ARPlacement(renderer, constellationScene.group);

let appMode: AppMode = 'preview';
let previewPlaced = false;
let skyBackgroundActive = false;
let arNorthCaptureStartedAt = 0;
const AR_NORTH_CAPTURE_TIMEOUT_MS = 5000;
let skyButton: HTMLButtonElement | null = null;

const phaseController = createPhaseController(constellationScene, {
  onPhaseChange: (phase) => {
    if (phase === 'findStars' || phase === 'connect' || phase === 'reveal') {
      messageOverlay.hide();
    }
    if (phase !== 'findStars') {
      instructionEl.classList.add('fade-out');
      setTimeout(() => {
        instructionEl.textContent = '';
        instructionEl.classList.remove('fade-out');
      }, 600);
    }
  },
  onInstructionChange: (text) => {
    if (text) {
      instructionEl.textContent = text;
      instructionEl.classList.remove('fade-out');
    }
  },
  onMessageShow: (key, opacity) => {
    if (renderer.xr.isPresenting) {
      constellationScene.showARMessage(key, opacity);
    } else {
      messageOverlay.show(key, opacity);
    }
  },
  onMessageHide: () => {
    messageOverlay.hide();
    constellationScene.hideARMessage();
  },
});

function getHeadCamera(): THREE.Camera {
  return renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
}

function handleSkyStarTap(result: SkyTapResult): void {
  if (result.constellationComplete) {
    instructionEl.textContent = `${result.constellationName} complete! Tap another constellation's stars.`;
  } else {
    instructionEl.textContent = `Join ${result.constellationName}: ${result.foundInConstellation}/${result.totalInConstellation} stars — tap ${result.starName}`;
  }
  instructionEl.classList.remove('fade-out');
}

function trySkyStarTap(clientX: number, clientY: number): boolean {
  if (!skyBackgroundActive) return false;
  const result = skyMode.tryTapAt(clientX, clientY, renderer.domElement);
  if (!result) return false;
  handleSkyStarTap(result);
  return true;
}

skyMode.setCameraProvider(getHeadCamera);
skyMode.setStarTapHandler(handleSkyStarTap);

const inputHandlers = createInputHandlers(
  renderer,
  camera,
  () => constellationScene.getInteractiveMeshes(),
  (result) => {
    phaseController.handleStarTap(result.starId, result.isDecoy, result.mesh ?? undefined);
  },
  () => phaseController.handleTap(),
  () => phaseController.phase,
  () => appMode === 'sky',
  trySkyStarTap,
);

let lastTime = performance.now();

function updateSkyBanner(): void {
  if (!skyBackgroundActive) return;
  const count = skyMode.skyScene.getVisibleStarCount();
  let base =
    appMode === 'ar'
      ? 'AR with sky map — look around to find constellations'
      : 'Sky map — drag or point your phone at the sky';
  if (appMode === 'ar' && renderer.xr.isPresenting && !skyMode.hasArNorthAlignment()) {
    base = 'AR sky map — calibrating compass… face north if stars look misaligned';
  }
  previewBanner.textContent = skyMode.errorMessage ?? `${base} (${count} stars visible)`;
}

async function enableSkyBackground(): Promise<void> {
  if (skyBackgroundActive) return;

  skyBackgroundActive = true;
  scene.add(skyMode.skyScene.group);
  camera.far = SKY_FAR;
  camera.updateProjectionMatrix();
  constellationScene.setPreviewBackground(scene, false);

  await skyMode.start(renderer.domElement);
  updateSkyBanner();
}

function disableSkyBackground(): void {
  if (!skyBackgroundActive) return;

  skyMode.stop();
  skyMode.detachSkyToScene(scene);
  skyMode.loversOverlay.unmountConstellation(constellationScene.group, scene);
  skyMode.loversOverlay.detachFromCamera(camera);
  arNorthCaptureStartedAt = 0;
  skyBackgroundActive = false;
  camera.far = PREVIEW_FAR;
  camera.updateProjectionMatrix();
}

function mountLoversOverlay(): void {
  skyMode.loversOverlay.mountConstellation(constellationScene.group);
  skyMode.loversOverlay.attachToCamera(camera);
}

function unmountLoversOverlay(): void {
  skyMode.loversOverlay.unmountConstellation(constellationScene.group, scene);
  skyMode.loversOverlay.detachFromCamera(camera);
}

function setPreviewMode(): void {
  appMode = 'preview';
  disableSkyBackground();
  renderer.setClearColor(0x0a0d1a, 1);
  previewBanner.classList.remove('hidden');
  previewBanner.textContent = 'Preview mode — open the HTTPS network URL on Android Chrome for AR';
  constellationScene.setPreviewBackground(scene, true);
  placement.reset();
  placement.placeForPreview();
  previewPlaced = true;
  instructionEl.textContent = 'Tap or drag across the stars of the constellation.';
  instructionEl.classList.remove('fade-out');
}

async function enterSkyMode(): Promise<void> {
  appMode = 'sky';
  previewPlaced = false;
  previewBanner.classList.remove('hidden');

  await enableSkyBackground();
  mountLoversOverlay();
  skyMode.setLookActive(true);

  instructionEl.textContent =
    'Drag to look around. Tap stars to trace a constellation — lines appear as you join them.';
  instructionEl.classList.remove('fade-out');
  updateSkyBanner();
}

function exitSkyMode(): void {
  if (appMode !== 'sky') return;
  setPreviewMode();
}

async function enterARMode(): Promise<void> {
  appMode = 'ar';
  previewPlaced = false;
  previewBanner.classList.remove('hidden');
  unmountLoversOverlay();

  await enableSkyBackground();
  skyMode.setLookActive(false);
  arNorthCaptureStartedAt = 0;
  renderer.setClearColor(0x0a0d1a, 0);
  constellationScene.setPreviewBackground(scene, false);
  placement.reset();

  instructionEl.textContent =
    'Tap sky stars to trace a constellation. Tap the Lovers panel stars for the proposal.';
  instructionEl.classList.remove('fade-out');
  updateSkyBanner();
}

function exitARMode(): void {
  constellationScene.hideARMessage();
  setPreviewMode();
}

function animate(): void {
  renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
    const dt = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;

    phaseController.update(dt);
    constellationScene.updateNameFloat(time * 0.001);

    if (frame) {
      const referenceSpace = renderer.xr.getReferenceSpace();
      if (referenceSpace) {
        placement.update(frame, referenceSpace);
      }
      inputHandlers.updateXR(frame);

      if (skyBackgroundActive) {
        skyMode.update(time, dt);
        const headCamera = renderer.xr.getCamera();
        if (!skyMode.hasArNorthAlignment()) {
          if (arNorthCaptureStartedAt === 0) {
            arNorthCaptureStartedAt = time;
          }
          if (time - arNorthCaptureStartedAt < AR_NORTH_CAPTURE_TIMEOUT_MS) {
            skyMode.captureArNorthOffset(headCamera);
          }
        }
        skyMode.followSkyToCamera(headCamera, true);
        if (time % 2000 < 20) updateSkyBanner();
      }
    } else if (appMode === 'sky' && skyBackgroundActive) {
      skyMode.update(time, dt);
      skyMode.applyCameraOrientation(camera);
      skyMode.followSkyToCamera(camera, false, scene);
      if (time % 2000 < 20) updateSkyBanner();
    } else if (appMode === 'preview') {
      if (!previewPlaced) {
        placement.placeForPreview();
        previewPlaced = true;
      }
      camera.position.copy(PREVIEW_CAMERA);
      camera.lookAt(PREVIEW_TARGET);
    }

    renderer.render(scene, camera);
  });
}

function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', onResize);

function updateModeButtonLabel(): void {
  if (!skyButton) return;
  skyButton.textContent = appMode === 'sky' ? 'The Lovers' : 'Sky Map';
}

function createModeButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = 'The Lovers';
  button.className = 'mode-button';

  button.addEventListener('click', async () => {
    if (appMode === 'sky') {
      exitSkyMode();
      updateModeButtonLabel();
      return;
    }

    if (renderer.xr.isPresenting) {
      const session = renderer.xr.getSession();
      if (session) await session.end();
    }

    await enterSkyMode();
    updateModeButtonLabel();
  });

  return button;
}

async function init(): Promise<void> {
  await isARSupported();

  skyButton = createModeButton();
  arButtonContainer.appendChild(skyButton);

  createARButton(
    renderer,
    arButtonContainer,
    overlayEl,
    async () => {
      await enterARMode();
      updateModeButtonLabel();
    },
    () => {
      exitARMode();
      updateModeButtonLabel();
    },
  );

  await enterSkyMode();
  updateModeButtonLabel();

  animate();
}

init();
