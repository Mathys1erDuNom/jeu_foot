import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

/** Taille réelle d'un joueur en mètres. */
export const CHARACTER_HEIGHT = 1.8;

/**
 * Les modèles Kenney regardent vers +Z. Si un personnage apparaît de dos,
 * mets Math.PI ici.
 */
export const MODEL_FACING_OFFSET = 0;

const MODEL_DIR = 'assets/characters/';
const loader = new GLTFLoader();
const templates = new Map();

/** Charge un modèle GLB une seule fois (mis en cache). */
export function loadCharacterTemplate(file) {
  if (!templates.has(file)) {
    templates.set(file, loader.loadAsync(MODEL_DIR + file));
  }
  return templates.get(file);
}

/**
 * Une instance de personnage : son propre squelette, son propre mixer
 * d'animations, et une racine (`root`) dont la position = pieds au sol.
 */
export class Character {
  constructor(gltf, { tint = null } = {}) {
    this.root = new THREE.Group();
    this.model = SkeletonUtils.clone(gltf.scene);

    // Mise à l'échelle à 1.80 m et pieds posés sur y = 0
    this.model.rotation.y = MODEL_FACING_OFFSET;
    this.model.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(this.model).getSize(new THREE.Vector3());
    this.model.scale.setScalar(CHARACTER_HEIGHT / size.y);
    this.model.updateMatrixWorld(true);
    const minY = new THREE.Box3().setFromObject(this.model).min.y;
    this.model.position.y -= minY;
    this.root.add(this.model);

    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (tint !== null) {
        const tinted = (m) => {
          const c = m.clone();
          c.color.set(tint);
          return c;
        };
        o.material = Array.isArray(o.material) ? o.material.map(tinted) : tinted(o.material);
      }
    });

    this.mixer = new THREE.AnimationMixer(this.model);
    this.clips = new Map(gltf.animations.map((c) => [c.name, c]));
    this.current = null;
  }

  /** Oriente le personnage vers une direction horizontale. */
  setFacing(dir) {
    this.root.rotation.y = Math.atan2(dir.x, dir.z);
  }

  setPosition(x, y, z) {
    this.root.position.set(x, y, z);
  }

  /** Joue une animation (noms : idle, jump, fall, attack-kick-right, ...). */
  play(name, { once = false, fade = 0.2, speed = 1 } = {}) {
    const clip = this.clips.get(name);
    if (!clip) return;
    const action = this.mixer.clipAction(clip);
    if (action === this.current) return;

    action.reset();
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.setEffectiveTimeScale(speed);
    action.fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = action;
  }

  update(dt) {
    this.mixer.update(dt);
  }
}
