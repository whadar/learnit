import * as THREE from 'three';

/** Renderer + scene + frame loop. Systems register update(dt, elapsed) callbacks. */
export class Engine {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, powerPreference: 'high-performance', stencil: false, depth: true, alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.25, 8000);
    this.clock = new THREE.Clock();
    this.systems = [];
    this.elapsed = 0;
    this.frame = 0;
    this.paused = false;
    this.composer = null;                 // set by the post-processing stack when present

    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
    this.resize();
  }

  add(system) { this.systems.push(system); return system; }

  resize() {
    const w = this.container.clientWidth || innerWidth, h = this.container.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
    for (const s of this.systems) s.resize?.(w, h);
  }

  start() {
    this.renderer.setAnimationLoop(() => this.tick());
  }

  tick() {
    const dt = Math.min(this.clock.getDelta(), 1 / 15);
    if (!this.paused) {
      this.elapsed += dt;
      for (const s of this.systems) s.update?.(dt, this.elapsed);
    }
    this.render();
    this.frame++;
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() { removeEventListener('resize', this._onResize); this.renderer.setAnimationLoop(null); }
}
