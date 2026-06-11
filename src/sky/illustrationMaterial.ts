import * as THREE from 'three';

export type IllustrationMaterial = THREE.ShaderMaterial;

/** Pixels at or below this luminance are treated as the opaque black background. */
const BACKGROUND_LUM_THRESHOLD = 0.01;

export function createIllustrationMaterial(): IllustrationMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null as THREE.Texture | null },
      opacity: { value: 0 },
      arMode: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform float opacity;
      uniform float arMode;
      varying vec2 vUv;
      void main() {
        vec4 tex = texture2D(map, vUv);
        float lum = max(max(tex.r, tex.g), tex.b);
        if (lum <= ${BACKGROUND_LUM_THRESHOLD.toFixed(3)}) discard;

        if (arMode > 0.5) {
          vec3 rgb = clamp(tex.rgb * 2.4 + vec3(0.12), 0.0, 1.0);
          gl_FragColor = vec4(rgb, opacity);
        } else {
          gl_FragColor = vec4(tex.rgb, opacity);
        }
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

export function setIllustrationOpacity(material: IllustrationMaterial, opacity: number): void {
  material.uniforms.opacity.value = opacity;
}

export function setIllustrationArMode(material: IllustrationMaterial, arMode: boolean): void {
  material.uniforms.arMode.value = arMode ? 1 : 0;
  material.blending = arMode ? THREE.NormalBlending : THREE.AdditiveBlending;
  material.needsUpdate = true;
}

export function setIllustrationMap(material: IllustrationMaterial, texture: THREE.Texture): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  material.uniforms.map.value = texture;
}

export function getIllustrationMap(material: IllustrationMaterial): THREE.Texture | null {
  return material.uniforms.map.value as THREE.Texture | null;
}
