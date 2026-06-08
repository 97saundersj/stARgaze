import * as THREE from 'three';
import type { WebGLRenderer } from 'three';

export async function isARSupported(): Promise<boolean> {
  if (!navigator.xr) return false;
  return navigator.xr.isSessionSupported('immersive-ar');
}

export function createARButton(
  renderer: WebGLRenderer,
  container: HTMLElement,
  overlayRoot: HTMLElement,
  onSessionStart: () => void,
  onSessionEnd: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = 'Enter AR';
  button.disabled = true;

  let currentSession: XRSession | null = null;

  isARSupported().then((supported) => {
    button.disabled = !supported;
    if (!supported) {
      button.textContent = 'AR not available';
    }
  });

  button.addEventListener('click', async () => {
    if (currentSession) {
      await currentSession.end();
      return;
    }

    if (!navigator.xr) return;

    try {
      const session = await requestARSession(overlayRoot);

      currentSession = session;
      button.textContent = 'Exit AR';

      await renderer.xr.setSession(session);
      onSessionStart();

      session.addEventListener('end', () => {
        currentSession = null;
        button.textContent = 'Enter AR';
        onSessionEnd();
      });
    } catch (err) {
      console.error('Failed to start AR session:', err);
    }
  });

  container.appendChild(button);
  return button;
}

export class ARPlacement {
  private hitTestSource: XRHitTestSource | null = null;
  private hitTestSourceRequested = false;
  private placed = false;

  constructor(
    private renderer: WebGLRenderer,
    private target: THREE.Group,
  ) {}

  reset(): void {
    this.placed = false;
    this.hitTestSource = null;
    this.hitTestSourceRequested = false;
  }

  update(frame: XRFrame, referenceSpace: XRReferenceSpace): void {
    const session = this.renderer.xr.getSession();
    if (!session || this.placed) return;

    if (!this.hitTestSourceRequested) {
      this.hitTestSourceRequested = true;
      session.requestReferenceSpace('viewer').then((viewerSpace) => {
        const requestHitTest = session.requestHitTestSource?.bind(session);
        if (!requestHitTest) {
          this.placeDefault(referenceSpace, frame);
          return;
        }
        const hitTestPromise = requestHitTest({ space: viewerSpace });
        if (!hitTestPromise) {
          this.placeDefault(referenceSpace, frame);
          return;
        }
        hitTestPromise
          .then((source) => {
            this.hitTestSource = source;
          })
          .catch(() => {
            this.placeDefault(referenceSpace, frame);
          });
      });
      return;
    }

    if (this.hitTestSource) {
      const hits = frame.getHitTestResults(this.hitTestSource);
      if (hits.length > 0) {
        const pose = hits[0].getPose(referenceSpace);
        if (pose) {
          this.target.position.set(
            pose.transform.position.x,
            pose.transform.position.y + 1.0,
            pose.transform.position.z,
          );
          this.faceViewer(referenceSpace, frame);
          this.placed = true;
          return;
        }
      }
    }
  }

  private placeDefault(referenceSpace: XRReferenceSpace, frame: XRFrame): void {
    const pose = frame.getViewerPose(referenceSpace);
    if (!pose) return;

    const pos = pose.transform.position;
    const ori = pose.transform.orientation;
    const quat = new THREE.Quaternion(ori.x, ori.y, ori.z, ori.w);
    const forward = new THREE.Vector3(0, 0, -1.5).applyQuaternion(quat);

    this.target.position.set(
      pos.x + forward.x,
      pos.y + 1.0,
      pos.z + forward.z,
    );
    this.faceViewer(referenceSpace, frame);
    this.placed = true;
  }

  private faceViewer(referenceSpace: XRReferenceSpace, frame: XRFrame): void {
    const viewerPose = frame.getViewerPose(referenceSpace);
    if (!viewerPose) return;

    const camX = viewerPose.transform.position.x;
    const camZ = viewerPose.transform.position.z;
    const dx = camX - this.target.position.x;
    const dz = camZ - this.target.position.z;
    this.target.rotation.y = Math.atan2(dx, dz);
  }

  placeForPreview(): void {
    this.target.position.set(0, 1.4, -1.5);
    this.target.rotation.set(0, 0, 0);
    this.placed = true;
  }
}

export function setupXRRenderer(renderer: WebGLRenderer): void {
  renderer.xr.enabled = true;
}

async function requestARSession(overlayRoot: HTMLElement): Promise<XRSession> {
  const withDomOverlay: XRSessionInit = {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hit-test', 'dom-overlay'],
    domOverlay: { root: overlayRoot },
  };

  try {
    return await navigator.xr!.requestSession('immersive-ar', withDomOverlay);
  } catch {
    return await navigator.xr!.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['hit-test'],
    });
  }
}
