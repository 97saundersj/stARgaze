import * as THREE from 'three';
import type { WebGLRenderer } from 'three';

export async function isARSupported(): Promise<boolean> {
  if (!navigator.xr) return false;
  return navigator.xr.isSessionSupported('immersive-ar');
}

function referenceSpaceTypeForSession(session: XRSession): XRReferenceSpaceType {
  const features = session.enabledFeatures ?? [];
  if (features.includes('local-floor')) return 'local-floor';
  if (features.includes('local')) return 'local';
  return 'viewer';
}

export function createARButton(
  renderer: WebGLRenderer,
  container: HTMLElement,
  overlayRoot: HTMLElement,
  onBeforeSession: () => void,
  onSessionStart: () => void | Promise<void>,
  onSessionEnd: () => void,
  onSessionError: (message: string) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
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

    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Starting AR…';

    try {
      onBeforeSession();
      const session = await requestARSession(overlayRoot);
      renderer.xr.setReferenceSpaceType(referenceSpaceTypeForSession(session));
      await renderer.xr.setSession(session);

      currentSession = session;
      button.textContent = 'Exit AR';
      button.disabled = false;

      await onSessionStart();

      session.addEventListener('end', () => {
        currentSession = null;
        button.textContent = 'Enter AR';
        button.disabled = false;
        onSessionEnd();
      });
    } catch (err) {
      console.error('Failed to start AR session:', err);
      button.textContent = previousLabel;
      button.disabled = false;
      const message =
        err instanceof Error ? err.message : 'Could not start AR. Try Chrome on Android over HTTPS.';
      onSessionError(message);
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
  const attempts: XRSessionInit[] = [
    {
      optionalFeatures: ['local-floor', 'hit-test', 'dom-overlay'],
      domOverlay: { root: overlayRoot },
    },
    {
      optionalFeatures: ['hit-test', 'dom-overlay'],
      domOverlay: { root: overlayRoot },
    },
    {
      optionalFeatures: ['local-floor', 'hit-test'],
    },
    {
      optionalFeatures: ['hit-test'],
    },
    {},
  ];

  let lastError: unknown;
  for (const init of attempts) {
    try {
      return await navigator.xr!.requestSession('immersive-ar', init);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('AR session not supported on this device');
}
