import * as THREE from 'three';
import { Horizon, MakeTime, Observer } from 'astronomy-engine';

export const SKY_SPHERE_RADIUS = 200;

export interface ObserverLocation {
  latitude: number;
  longitude: number;
  elevationM: number;
}

export interface HorizontalPosition {
  altitude: number;
  azimuth: number;
}

export function createObserver(location: ObserverLocation): Observer {
  return new Observer(location.latitude, location.longitude, location.elevationM);
}

export function starHorizontalPosition(
  raHours: number,
  decDeg: number,
  observer: Observer,
  date: Date,
): HorizontalPosition {
  const time = MakeTime(date);
  const { altitude, azimuth } = Horizon(time, observer, raHours, decDeg, 'normal');
  return { altitude, azimuth };
}

/**
 * Convert horizontal coordinates to a unit direction on the celestial sphere.
 * Azimuth: clockwise from north (N=0, E=90). Altitude: degrees above horizon.
 * Three.js: Y-up, -Z is default camera forward at identity orientation.
 */
export function altAzToDirection(azimuthDeg: number, altitudeDeg: number): THREE.Vector3 {
  const azRad = THREE.MathUtils.degToRad(azimuthDeg);
  const altRad = THREE.MathUtils.degToRad(altitudeDeg);

  const cosAlt = Math.cos(altRad);
  const x = cosAlt * Math.sin(azRad);
  const y = Math.sin(altRad);
  const z = -cosAlt * Math.cos(azRad);

  return new THREE.Vector3(x, y, z).normalize();
}

export function altAzToWorldPosition(
  azimuthDeg: number,
  altitudeDeg: number,
  radius = SKY_SPHERE_RADIUS,
): THREE.Vector3 {
  return altAzToDirection(azimuthDeg, altitudeDeg).multiplyScalar(radius);
}

/** World-space radius on the celestial sphere (scaled for visibility at SKY_SPHERE_RADIUS). */
export function magnitudeToRadius(mag: number, sphereRadius = SKY_SPHERE_RADIUS): number {
  const angularSize = 0.0055 * Math.pow(10, -0.16 * mag);
  const radius = angularSize * sphereRadius;
  return THREE.MathUtils.clamp(radius, sphereRadius * 0.002, sphereRadius * 0.022);
}

export function magnitudeToPointSize(mag: number): number {
  const size = 20 * Math.pow(10, -0.18 * mag);
  return THREE.MathUtils.clamp(size, 8, 28);
}

export function horizonOpacity(altitudeDeg: number): number {
  if (altitudeDeg < 0) return 0;
  if (altitudeDeg > 5) return 1;
  return altitudeDeg / 5;
}
