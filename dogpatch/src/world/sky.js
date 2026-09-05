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
        // Value-noise fbm. Three critics called the flat vertical gradient out by name, and a
        // cloud deck is the one thing that makes a sky read as weather rather than as a fill.
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                     mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
        }
        float fbm(vec2 p){
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++){ v += a * vnoise(p); p *= 2.03; a *= 0.5; }
          return v;
        }
        void main(){
          vec3 d = normalize(vd);
          float h = clamp(d.y * 1.15 + 0.10, 0.0, 1.0);
          vec3 c = mix(bot, top, pow(h, 0.72));

          // Project onto the cloud plane. Guarding y keeps the projection from exploding at the
          // horizon, where it would otherwise smear one cloud across the whole skyline.
          if (d.y > 0.02) {
            vec2 uv = d.xz / max(d.y, 0.12) * 0.55;
            float n = fbm(uv * 1.6);
            float deck = smoothstep(0.52, 0.86, n) * smoothstep(0.02, 0.30, d.y);
            float lit = smoothstep(0.45, 0.95, fbm(uv * 1.6 + normalize(sun).xz * 0.30));
            vec3 cloud = mix(vec3(0.72, 0.75, 0.80), vec3(1.0, 0.98, 0.95), lit);
            c = mix(c, cloud, deck * 0.82);
          }

          float sd = max(dot(d, normalize(sun)), 0.0);
          c += vec3(1.0, 0.93, 0.78) * pow(sd, 12.0) * 0.30;
          c += vec3(1.0, 0.96, 0.86) * smoothstep(0.9975, 0.9995, sd) * 0.9;   // the disc itself
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
  dome.name = 'sky'; dome.frustumCulled = false; dome.renderOrder = -1;
  scene.add(dome);

  const sun = new THREE.DirectionalLight(0xfff3dd, 3.2);
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

  /* Key-to-fill is the whole argument here, and it has now been got wrong in both directions.
   *
   * Round one ran fill 1.05 against a dark 0x50524e bounce, and three critics read the shaded
   * elevations as unlit black polygons. Round two answered with fill 1.9 and a warm bounce, which
   * lifted the shade — and flattened the key to a 1.3:1 ratio, at which point the same three
   * critics said there were NO SHADOWS ANYWHERE and the lighting was flat ambient. The shadow map
   * was on the whole time, 189 casters and 1956 receivers; the fill had simply washed it out.
   *
   * So: keep round two's warm, bright bounce, which is what stopped the crushing, but put the sun
   * back in charge at about 2.8:1. The contract this project keeps re-learning is that an effect
   * swinging between opposite failures is one problem, not two. */
  scene.add(new THREE.HemisphereLight(0xc8dcee, 0x8a8578, 1.15));
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
