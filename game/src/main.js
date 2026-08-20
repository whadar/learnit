import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { WorldData } from './world/worldData.js';
import { createTerrain } from './world/terrain.js';
import { createBuildings } from './world/buildings.js';
import { createSky } from './world/sky.js';

const engine = new Engine(document.getElementById('app'));

/** Debug/automation surface used by the screenshot harness and the visual-review loop. */
const game = window.__game = {
  engine, world: null, ready: false, error: null,
  views: {},
  setView(name) {
    const v = this.views[name]; if (!v) throw new Error('unknown view: ' + name);
    engine.camera.position.set(...v.pos);
    engine.camera.lookAt(new THREE.Vector3(...v.look));
    engine.camera.fov = v.fov ?? 62; engine.camera.updateProjectionMatrix();
  },
  renderOnce() { engine.render(); },
};

(async () => {
  try {
    const world = game.world = await WorldData.load();
    createSky(engine, world);
    createTerrain(engine, world);
    createBuildings(engine, world);

    // Named camera views the visual-review harness screenshots.
    const h = (x, z) => world.heightAt(x, z);
    game.views = {
      overview:  { pos: [-620, h(-620, 620) + 320, 620], look: [0, h(0, 0), 0], fov: 55 },
      village:   { pos: [120, h(120, 180) + 45, 180], look: [-40, h(-40, 20) + 6, 20], fov: 50 },
      street:    { pos: [-20, h(-20, 40) + 3.2, 40], look: [60, h(60, 10) + 2, 10], fov: 65 },
      ridge:     { pos: [500, h(500, -500) + 90, -500], look: [0, h(0, 0), 0], fov: 48 },
    };
    game.setView('overview');
    engine.start();
    game.ready = true;
  } catch (e) {
    game.error = String(e && e.stack || e);
    console.error(e);
  }
})();
