import * as THREE from 'three';
import { ConstellationScene } from './constellationScene';
import { createPhaseController } from './phases';
import { createInputHandlers } from './input';
import { createMessageOverlay } from './messageOverlay';
import {
  ARPlacement,
  createARButton,
  isARSupported,
  setupXRRenderer,
} from './xr';

const overlayEl = document.getElementById('overlay')!;
const instructionEl = document.getElementById('instruction')!;
const previewBanner = document.getElementById('preview-banner')!;
const arButtonContainer = document.getElementById('ar-button-container')!;
const messageOverlay = createMessageOverlay(document.getElementById('message')!);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
const PREVIEW_CAMERA = new THREE.Vector3(0, 1.4, 0);
const PREVIEW_TARGET = new THREE.Vector3(0, 1.4, -1.5);

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

const placement = new ARPlacement(renderer, constellationScene.group);
let isPreview = true;

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

const inputHandlers = createInputHandlers(
  renderer,
  camera,
  () => constellationScene.getInteractiveMeshes(),
  (result) => {
    phaseController.handleStarTap(result.starId, result.isDecoy, result.mesh ?? undefined);
  },
  () => phaseController.handleTap(),
  () => phaseController.phase,
);

let lastTime = performance.now();
let previewPlaced = false;

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
    } else if (isPreview) {
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

async function init(): Promise<void> {
  await isARSupported();

  previewBanner.classList.remove('hidden');
  isPreview = true;
  constellationScene.setPreviewBackground(scene, true);
  placement.placeForPreview();
  previewPlaced = true;

  createARButton(
    renderer,
    arButtonContainer,
    overlayEl,
    () => {
      previewBanner.classList.add('hidden');
      isPreview = false;
      previewPlaced = false;
      constellationScene.setPreviewBackground(scene, false);
      placement.reset();
    },
    () => {
      previewBanner.classList.remove('hidden');
      isPreview = true;
      previewPlaced = false;
      constellationScene.setPreviewBackground(scene, true);
      constellationScene.hideARMessage();
      placement.reset();
      placement.placeForPreview();
      previewPlaced = true;
    },
  );

  animate();
}

init();
