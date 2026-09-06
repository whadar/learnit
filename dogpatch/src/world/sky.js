/**
 * Sky, sun and fog for a clear afternoon on the bay.
 *
 * A gradient dome, one directional sun with a shadow camera framed on the circuit, hemisphere
 * fill, and linear fog tuned so the far side of the box fades rather than ending in a hard edge.
 * The sun sits low enough (about 34 deg) that shadows have length; too high and every shadow
 * hides inside the silhouette that casts it, which reads as no shadows at all.
 */
import * as THREE from 'three';
import { clamp } from '../core/math.js';

export function createSky(scene, opts = {}) {
  const world = opts.world ?? null;
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
  const MAP = opts.shadowMap ?? 2048;
  const NEAR_EXTENT = opts.shadowExtent ?? 92;     // half-width of the shadow box, metres
  const FAR_EXTENT = opts.shadowExtentFar ?? 260;  // grown when the camera climbs
  const LIGHT_BACK = 240;                          // clears the tallest thing above the focus
  const BIAS_M = 0.020;                            // depth bias in METRES, not normalised units
  const PENUMBRA_M = 0.26;                         // softness as a distance on the ground
  if (sun.castShadow) {
    sun.shadow.mapSize.set(MAP, MAP);
    sun.shadow.camera.near = 1;
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
  /* Image-based fill, generated from this dome rather than guessed at.
   *
   * A hemisphere light gives shaded surfaces one colour from above and one from below. Real
   * ambient carries the sky's whole distribution — bright toward the sun, cooler away, warm off
   * the ground — which is what makes a shadowed elevation read as a lit surface in shade rather
   * than as a darker version of itself. Prefiltering the dome we already drew costs one render
   * at boot and nothing per frame.
   *
   * The hemisphere light stays, at about a third of its former strength: the IBL now carries
   * most of the fill, and doubling up was what flattened the key in round two. */
  if (opts.ibl !== false && opts.renderer) {
    const pmrem = new THREE.PMREMGenerator(opts.renderer);
    const tmp = new THREE.Scene();
    tmp.add(dome.clone());
    scene.environment = pmrem.fromScene(tmp, 0, 1, 6000).texture;
    scene.environmentIntensity = opts.iblIntensity ?? 0.55;
    pmrem.dispose();
  }
  scene.add(new THREE.HemisphereLight(0xc8dcee, 0x8a8578, 0.42));
  // Haze that actually reaches the far side of the box. At 420-2100 m over a circuit whose
  // furthest visible block is about 1.5 km out, distance cost almost nothing and the skyline
  // sat at the same contrast as the kerb in front of the player — which every critic read as
  // collapsed depth. Tinted toward the horizon colour so the fade lands in the sky, not in grey.
  scene.fog = new THREE.Fog(0xc4d6e2, 160, 1500);
  scene.background = null;

  /* ---------------------------------------------------------------- shadow fitting ---
   * Ported from the previous build's render/lighting.js, which had solved this properly.
   *
   * The rig here was a fixed 320 m half-box over a 2048 px map: 0.31 m per texel, so a 2 m
   * kart spanned six of them and its shadow could only ever be a smudge. Fitting the box to
   * the camera at 92 m gives 0.09 m per texel and about 22 texels across the same kart —
   * which is the difference between a contact shadow and a suggestion of one.
   *
   * Three details come with it and all three matter:
   *   - the focus is pushed down the view axis, so the box is spent on what is in frame
   *     rather than on the ground behind the camera;
   *   - the focus is snapped to whole texels in light space, or the map crawls with
   *     sub-texel camera motion and every shadow edge shimmers;
   *   - bias and penumbra are expressed in METRES and converted per frame. `shadow.radius`
   *     is in texels, and a texel is a different size in every view, so a constant radius
   *     means a penumbra three times wider on one shot than another.
   */
  const lightDir = dir.clone().negate();                 // from the sun toward the ground
  const _fwd = new THREE.Vector3(), _focus = new THREE.Vector3();
  const _basis = new THREE.Matrix4(), _basisInv = new THREE.Matrix4();
  const _origin = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

  return {
    sun, dome, direction: dir,
    /** Keep the shadow volume on the action, or a 3 km map is spent almost entirely on nothing. */
    follow(p, camera) {
      if (!sun.castShadow) return;
      let extent = NEAR_EXTENT;
      if (camera) {
        camera.getWorldDirection(_fwd);
        const g = world ? world.heightAt(camera.position.x, camera.position.z) : 0;
        const height = Math.max(0, camera.position.y - (Number.isFinite(g) ? g : 0));
        extent = clamp(NEAR_EXTENT + height * 3.2, NEAR_EXTENT, FAR_EXTENT);
        _focus.copy(camera.position).addScaledVector(_fwd, extent * 0.55);
      } else {
        _focus.set(p.x, p.y, p.z);
      }
      const fy = world ? world.heightAt(_focus.x, _focus.z) : p.y;
      _focus.y = (Number.isFinite(fy) ? fy : p.y) + 2;

      const texel = (extent * 2) / MAP;
      _basis.lookAt(_origin, lightDir, _up);
      _basisInv.copy(_basis).invert();
      _focus.applyMatrix4(_basisInv);
      _focus.x = Math.floor(_focus.x / texel) * texel;
      _focus.y = Math.floor(_focus.y / texel) * texel;
      _focus.applyMatrix4(_basis);

      sun.target.position.copy(_focus);
      sun.position.copy(_focus).addScaledVector(lightDir, -LIGHT_BACK);
      sun.target.updateMatrixWorld();

      const c = sun.shadow.camera;
      c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent;
      c.far = LIGHT_BACK + extent * 2.2;
      c.updateProjectionMatrix();

      sun.shadow.bias = -(BIAS_M / (c.far - c.near));
      sun.shadow.normalBias = clamp(1.35 * texel, 0.035, 0.11);
      sun.shadow.radius = clamp(PENUMBRA_M / texel, 1.15, 4.6);
    },
  };
}
