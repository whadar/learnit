/**
 * Sky, sun and fog for a clear afternoon on the bay.
 *
 * A gradient dome, one directional sun with a shadow camera framed on the circuit, hemisphere
 * fill, and linear fog tuned so the far side of the box fades rather than ending in a hard edge.
 * The sun sits low enough (about 34 deg) that shadows have length; too high and every shadow
 * hides inside the silhouette that casts it, which reads as no shadows at all.
 */
import * as THREE from 'three';

export function createSky(scene, opts = {}) {
  const azimuth = opts.azimuth ?? 2.15;        // radians; sun to the west-south-west
  const elev = opts.elevation ?? 0.60;         // ~34 degrees

  const dir = new THREE.Vector3(
    Math.cos(elev) * Math.sin(azimuth), Math.sin(elev), Math.cos(elev) * Math.cos(azimuth));

  const top = new THREE.Color(0x3f86c8), bottom = new THREE.Color(0xcfe0ea);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(2400, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: top }, bot: { value: bottom }, sun: { value: dir } },
      vertexShader: 'varying vec3 vd; void main(){ vd = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vd; uniform vec3 top; uniform vec3 bot; uniform vec3 sun;
        void main(){
          float h = clamp(vd.y * 1.15 + 0.10, 0.0, 1.0);
          vec3 c = mix(bot, top, pow(h, 0.72));
          float g = pow(max(dot(normalize(vd), normalize(sun)), 0.0), 12.0);
          c += vec3(1.0, 0.93, 0.78) * g * 0.30;
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
  dome.name = 'sky'; dome.frustumCulled = false; dome.renderOrder = -1;
  scene.add(dome);

  const sun = new THREE.DirectionalLight(0xfff3dd, 2.5);
  sun.position.copy(dir).multiplyScalar(500);
  sun.castShadow = opts.shadows !== false;
  if (sun.castShadow) {
    const c = sun.shadow.camera, R = opts.shadowRadius ?? 320;
    c.left = -R; c.right = R; c.top = R; c.bottom = -R; c.near = 60; c.far = 1300;
    sun.shadow.mapSize.set(opts.shadowMap ?? 2048, opts.shadowMap ?? 2048);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.9;
  }
  scene.add(sun);
  scene.add(sun.target);

  scene.add(new THREE.HemisphereLight(0xbcd6ea, 0x50524e, 1.05));
  scene.fog = new THREE.Fog(0xbcd0dd, 420, 2100);
  scene.background = null;

  return {
    sun, dome, direction: dir,
    /** Keep the shadow volume on the action, or a 3 km map wastes the whole map on nothing. */
    follow(p) {
      sun.target.position.set(p.x, p.y, p.z);
      sun.position.set(p.x + dir.x * 500, p.y + dir.y * 500, p.z + dir.z * 500);
      sun.target.updateMatrixWorld();
    },
  };
}
