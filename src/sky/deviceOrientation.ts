import * as THREE from 'three';

export interface GeolocationResult {
  latitude: number;
  longitude: number;
  elevationM: number;
}

interface DeviceOrientationEventWithCompass extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

/** Matches classic Three.js DeviceOrientationControls (camera looks out the back of the phone). */
const SCREEN_Z = new THREE.Vector3(0, 0, 1);
const CAMERA_FRAME_FIX = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const SCREEN_ORIENT_QUAT = new THREE.Quaternion();
const DEVICE_EULER = new THREE.Euler(0, 0, 0, 'YXZ');

export class DeviceOrientationController {
  private listening = false;
  private screenOrientation = 0;
  private alpha: number | null = null;
  private beta: number | null = null;
  private gamma: number | null = null;
  private compassHeading: number | null = null;
  private alphaOffsetAngle = 0;
  private orientationInitialized = false;
  readonly orientationQuaternion = new THREE.Quaternion();
  readonly displayQuaternion = new THREE.Quaternion();
  private static readonly ORIENTATION_SMOOTHING = 0.12;

  get isActive(): boolean {
    return this.listening;
  }

  get hasOrientationData(): boolean {
    return this.alpha !== null && this.beta !== null && this.gamma !== null;
  }

  get hasCompassHeading(): boolean {
    return this.compassHeading !== null;
  }

  /** Y-axis rotation to align horizontal star catalog north with real north in WebXR. */
  getSkyNorthOffsetRadians(viewerYawRadians: number): number | null {
    if (this.compassHeading === null) return null;
    const compassRad = THREE.MathUtils.degToRad(this.compassHeading);
    return compassRad - viewerYawRadians;
  }

  async requestPermissions(): Promise<boolean> {
    const DeviceOrientationCtor = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: (options?: { absolute?: boolean }) => Promise<'granted' | 'denied'>;
    };

    if (typeof DeviceOrientationCtor.requestPermission === 'function') {
      try {
        const state = await DeviceOrientationCtor.requestPermission({ absolute: true });
        if (state !== 'granted') return false;
      } catch {
        try {
          const state = await DeviceOrientationCtor.requestPermission();
          if (state !== 'granted') return false;
        } catch {
          return false;
        }
      }
    }

    return true;
  }

  async requestGeolocation(): Promise<GeolocationResult> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            elevationM: position.coords.altitude ?? 0,
          });
        },
        (error) => reject(error),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
      );
    });
  }

  start(): void {
    if (this.listening) return;

    this.screenOrientation = window.screen?.orientation?.angle ?? window.orientation ?? 0;
    window.addEventListener('deviceorientation', this.onDeviceOrientation);
    window.addEventListener('deviceorientationabsolute', this.onDeviceOrientation);
    window.addEventListener('orientationchange', this.onOrientationChange);
    this.listening = true;
  }

  stop(): void {
    if (!this.listening) return;
    window.removeEventListener('deviceorientation', this.onDeviceOrientation);
    window.removeEventListener('deviceorientationabsolute', this.onDeviceOrientation);
    window.removeEventListener('orientationchange', this.onOrientationChange);
    this.listening = false;
    this.alphaOffsetAngle = 0;
    this.compassHeading = null;
    this.orientationInitialized = false;
  }

  update(): void {
    if (!this.hasOrientationData) return;

    if (this.compassHeading !== null && this.alpha !== null) {
      this.alphaOffsetAngle =
        THREE.MathUtils.degToRad(this.compassHeading) - THREE.MathUtils.degToRad(this.alpha);
    }

    const alphaRad = THREE.MathUtils.degToRad(this.alpha!) + this.alphaOffsetAngle;
    const betaRad = THREE.MathUtils.degToRad(this.beta!);
    const gammaRad = THREE.MathUtils.degToRad(this.gamma!);
    const orientRad = THREE.MathUtils.degToRad(this.screenOrientation);

    DEVICE_EULER.set(betaRad, alphaRad, -gammaRad);
    this.orientationQuaternion.setFromEuler(DEVICE_EULER);
    this.orientationQuaternion.multiply(CAMERA_FRAME_FIX);
    this.orientationQuaternion.multiply(
      SCREEN_ORIENT_QUAT.setFromAxisAngle(SCREEN_Z, -orientRad),
    );

    if (!this.orientationInitialized) {
      this.displayQuaternion.copy(this.orientationQuaternion);
      this.orientationInitialized = true;
    } else {
      this.displayQuaternion.slerp(
        this.orientationQuaternion,
        DeviceOrientationController.ORIENTATION_SMOOTHING,
      );
    }
  }

  private onOrientationChange = (): void => {
    this.screenOrientation = window.screen?.orientation?.angle ?? window.orientation ?? 0;
  };

  private onDeviceOrientation = (event: Event): void => {
    const e = event as DeviceOrientationEventWithCompass;
    if (e.alpha !== null) this.alpha = e.alpha;
    if (e.beta !== null) this.beta = e.beta;
    if (e.gamma !== null) this.gamma = e.gamma;

    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
      this.compassHeading = e.webkitCompassHeading;
    } else if (e.absolute && e.alpha !== null) {
      // Android Chrome: alpha is degrees clockwise from magnetic north when absolute.
      this.compassHeading = e.alpha;
    }
  };
}

export function isDeviceOrientationSupported(): boolean {
  return 'DeviceOrientationEvent' in window;
}

export function getViewerYawRadians(camera: THREE.Camera): number {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  return Math.atan2(forward.x, -forward.z);
}
