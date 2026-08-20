/**
 * Shared bootstrap for per-module preview pages. Each parallel agent gets its own page so
 * everyone can render and screenshot their work without fighting over main.js or a port.
 *
 *   import { boot } from './common.js';
 *   boot({ name: 'buildings', modules: async (ctx) => { ... add things to ctx.engine.scene ... },
 *          views: { hero: { pos:[..], look:[..], fov:50 } } });
 */
import * as THREE from 'three';
import { Engine } from '../src/core/engine.js';
import { WorldData } from '../src/world/worldData.js';
import { createSky } from '../src/world/sky.js';
import { createTerrain } from '../src/world/terrain.js';

export async function boot({ name, modules, views = {}, sky = true, terrain = true }) {
  const engine = new Engine(document.getElementById('app') || document.body);
  const game = window.__game = {
    engine, world: null, ready: false, error: null, views: {},
    setView(n) {
      const v = this.views[n]; if (!v) throw new Error('unknown view: ' + n);
      engine.camera.position.set(...v.pos);
      engine.camera.up.set(0, 1, 0);
      engine.camera.lookAt(new THREE.Vector3(...v.look));
      engine.camera.fov = v.fov ?? 55; engine.camera.updateProjectionMatrix();
      engine.camera.updateMatrixWorld(true);
    },
    renderOnce() { engine.render(); },
  };
  try {
    const world = game.world = await WorldData.load('/data/');
    const ctx = { engine, world, THREE, scene: engine.scene };
    if (sky) ctx.sky = createSky(engine, world);
    if (terrain) ctx.terrain = createTerrain(engine, world);
    await modules?.(ctx);
    game.views = views;
    game.setView(Object.keys(views)[0]);
    engine.start();
    game.ready = true;
  } catch (e) {
    game.error = String((e && e.stack) || e);
    console.error(e);
  }
  return game;
}
