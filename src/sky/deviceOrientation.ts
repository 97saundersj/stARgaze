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
const _yawForward = new THREE.Vector3();
const _yawUp = new THREE.Vector3();

/**
 * Yaw about world-up, robust to pitch. When the view points near-vertical
 * (e.g. up at the sky) the forward vector's horizontal projection becomes
 * unstable, so we blend toward the screen-up vector, which is horizontal then.
 * Without this, looking up gives a different heading on every reload.
 */
export function robustYawFromQuaternion(q: THREE.Quaternion): number {
  _yawForward.set(0, 0, -1).applyQuaternion(q);
  _yawUp.set(0, 1, 0).applyQuaternion(q);

  const forwardHoriz = Math.hypot(_yawForward.x, _yawForward.z);
  let fx = _yawForward.x;
  let fz = _yawForward.z;
  if (forwardHoriz > 1e-4) {
    fx /= forwardHoriz;
    fz /= forwardHoriz;
  }

  // Looking up (forward.y > 0): screen-up points toward the opposite heading.
  const upSign = _yawForward.y >= 0 ? -1 : 1;
  let ux = upSign * _yawUp.x;
  let uz = upSign * _yawUp.z;
  const upHoriz = Math.hypot(ux, uz);
  if (upHoriz > 1e-4) {
    ux /= upHoriz;
    uz /= upHoriz;
  }

  const w = THREE.MathUtils.clamp((forwardHoriz - 0.15) / 0.2, 0, 1);
  const bx = fx * w + ux * (1 - w);
  const bz = fz * w + uz * (1 - w);
  return Math.atan2(bx, -bz);
}

/**
 * Tilt-compensated compass heading (degrees, clockwise from north) from raw
 * deviceorientation angles. Matches iOS webkitCompassHeading convention so the
 * Android absolute path uses the same reference frame.
 */
export function compassHeadingFromOrientation(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
): number {
  const x = THREE.MathUtils.degToRad(betaDeg);
  const y = THREE.MathUtils.degToRad(gammaDeg);
  const z = THREE.MathUtils.degToRad(alphaDeg);

  const cY = Math.cos(y);
  const cZ = Math.cos(z);
  const sX = Math.sin(x);
  const sY = Math.sin(y);
  const sZ = Math.sin(z);

  const vx = -cZ * sY - sZ * sX * cY;
  const vy = -sZ * sY + cZ * sX * cY;

  let heading = Math.atan2(vx, vy);
  if (heading < 0) heading += 2 * Math.PI;
  return THREE.MathUtils.radToDeg(heading);
}

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

  /** True once an absolute compass heading sample has been received. */
  get isNorthReady(): boolean {
    return this.compassHeading !== null;
  }

  setOnNorthLocked(handler: (compassRadians: number | null) => void): void {
    this.onNorthLocked = handler;
  }

  /** Horizontal yaw of the view direction from the smoothed device quaternion. */
  getHorizontalViewYaw(): number {
    return robustYawFromQuaternion(this.displayQuaternion);
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
      if (e.absolute && e.alpha !== null && e.beta !== null && e.gamma !== null) {
        this.compassHeading = compassHeadingFromOrientation(e.alpha, e.beta, e.gamma);
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
    if (compass === null) return;

    const compassRad = THREE.MathUtils.degToRad(compass);
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

    if (hasCompass && this.northWarmup >= DeviceOrientationController.NORTH_WARMUP_FRAMES) {
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
    } else if (
      e.absolute &&
      e.alpha !== null &&
      e.beta !== null &&
      e.gamma !== null &&
      !this.northLocked
    ) {
      this.compassHeading = compassHeadingFromOrientation(e.alpha, e.beta, e.gamma);
    }
  };
}

export function isDeviceOrientationSupported(): boolean {
  return 'DeviceOrientationEvent' in window;
}

export function getViewerYawRadians(camera: THREE.Camera): number {
  const worldQuaternion = new THREE.Quaternion();
  camera.getWorldQuaternion(worldQuaternion);
  return robustYawFromQuaternion(worldQuaternion);
}
