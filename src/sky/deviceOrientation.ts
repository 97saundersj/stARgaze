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
const VIEW_FORWARD = new THREE.Vector3(0, 0, -1);

export class DeviceOrientationController {
  private listening = false;
  private screenOrientation = 0;
  private alpha: number | null = null;
  private beta: number | null = null;
  private gamma: number | null = null;
  private compassHeading: number | null = null;
  private smoothedCompassHeading: number | null = null;
  private northLocked = false;
  private northWarmup = 0;
  private orientationInitialized = false;
  private onNorthLocked: ((compassRadians: number | null) => void) | null = null;
  private absoluteCompassHandler: ((event: Event) => void) | null = null;
  readonly orientationQuaternion = new THREE.Quaternion();
  readonly displayQuaternion = new THREE.Quaternion();
  private static readonly ORIENTATION_SMOOTHING = 0.028;
  private static readonly COMPASS_SMOOTHING = 0.06;
  private static readonly NORTH_WARMUP_FRAMES = 90;
  private static readonly NORTH_WARMUP_MAX_FRAMES = 150;

  get isActive(): boolean {
    return this.listening;
  }

  get hasOrientationData(): boolean {
    return this.alpha !== null && this.beta !== null && this.gamma !== null;
  }

  get hasCompassHeading(): boolean {
    return this.compassHeading !== null;
  }

  get isNorthCalibrated(): boolean {
    return this.northLocked;
  }

  setOnNorthLocked(handler: (compassRadians: number | null) => void): void {
    this.onNorthLocked = handler;
  }

  /** Horizontal yaw of the view direction from the smoothed device quaternion. */
  getHorizontalViewYaw(): number {
    const forward = VIEW_FORWARD.clone().applyQuaternion(this.displayQuaternion);
    return Math.atan2(forward.x, -forward.z);
  }

  /** Smoothed compass heading in degrees, or null before the first sample. */
  getSmoothedCompassHeading(): number | null {
    return this.smoothedCompassHeading ?? this.compassHeading;
  }

  async requestPermissions(): Promise<boolean> {
    const DeviceOrientationCtor = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };

    if (typeof DeviceOrientationCtor.requestPermission !== 'function') {
      return true;
    }

    try {
      const state = await DeviceOrientationCtor.requestPermission();
      return state === 'granted';
    } catch {
      return false;
    }
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
    window.addEventListener('orientationchange', this.onOrientationChange);

    this.absoluteCompassHandler = (event: Event) => {
      if (this.northLocked) return;
      const e = event as DeviceOrientationEvent;
      if (e.absolute && e.alpha !== null) {
        this.compassHeading = e.alpha;
      }
    };
    window.addEventListener('deviceorientationabsolute', this.absoluteCompassHandler);

    this.listening = true;
  }

  stop(): void {
    if (!this.listening) return;
    window.removeEventListener('deviceorientation', this.onDeviceOrientation);
    window.removeEventListener('orientationchange', this.onOrientationChange);
    if (this.absoluteCompassHandler) {
      window.removeEventListener('deviceorientationabsolute', this.absoluteCompassHandler);
      this.absoluteCompassHandler = null;
    }
    this.listening = false;
    this.smoothedCompassHeading = null;
    this.compassHeading = null;
    this.northLocked = false;
    this.northWarmup = 0;
    this.orientationInitialized = false;
  }

  private smoothCompassHeading(heading: number): number {
    if (this.smoothedCompassHeading === null) {
      this.smoothedCompassHeading = heading;
      return heading;
    }

    let delta = heading - this.smoothedCompassHeading;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    this.smoothedCompassHeading += delta * DeviceOrientationController.COMPASS_SMOOTHING;
    return this.smoothedCompassHeading;
  }

  private lockNorthHeading(): void {
    if (this.northLocked) return;

    const compass = this.smoothedCompassHeading ?? this.compassHeading;
    const compassRad =
      compass !== null ? THREE.MathUtils.degToRad(compass) : null;

    this.northLocked = true;
    if (this.absoluteCompassHandler) {
      window.removeEventListener('deviceorientationabsolute', this.absoluteCompassHandler);
      this.absoluteCompassHandler = null;
    }
    this.onNorthLocked?.(compassRad);
  }

  private updateNorthWarmup(): void {
    if (this.northLocked) return;

    const hasCompass = this.compassHeading !== null;
    if (hasCompass) {
      this.smoothCompassHeading(this.compassHeading!);
    }

    this.northWarmup += 1;

    const readyWithCompass =
      hasCompass && this.northWarmup >= DeviceOrientationController.NORTH_WARMUP_FRAMES;
    const readyWithoutCompass =
      this.northWarmup >= DeviceOrientationController.NORTH_WARMUP_MAX_FRAMES;

    if (readyWithCompass || readyWithoutCompass) {
      this.lockNorthHeading();
    }
  }

  update(): void {
    if (!this.hasOrientationData) return;

    this.updateNorthWarmup();

    const alphaRad = THREE.MathUtils.degToRad(this.alpha!);
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
    }
  };
}

export function isDeviceOrientationSupported(): boolean {
  return 'DeviceOrientationEvent' in window;
}

export function getViewerYawRadians(camera: THREE.Camera): number {
  const worldQuaternion = new THREE.Quaternion();
  camera.getWorldQuaternion(worldQuaternion);
  const forward = VIEW_FORWARD.clone().applyQuaternion(worldQuaternion);
  return Math.atan2(forward.x, -forward.z);
}
