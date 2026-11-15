import * as THREE from 'three';
import {
  BALL_RADIUS, GOAL, MAX_SPIN, G,
  createBall, integrate, collideSegment, predictCrossing, solveLaunchAngle,
} from './physics.js';
import { loadCharacterTemplate, Character } from './characters.js';

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------
const PITCH = { halfW: 40, zMin: -10, zMax: 60, ppm: 20 }; // ppm = pixels par mètre (texture)
const PENALTY_SPOT = new THREE.Vector3(0, 0, 11);
// Plusieurs positions de coup franc (x, z) : un point différent est tiré à chaque tir
const FREEKICK_SPOTS = [
  [-14, 22], [-5, 19], [2, 21], [8, 24], [15, 19], [-18, 25],
].map(([x, z]) => new THREE.Vector3(x, 0, z));
const GOALIE_HOME_Z = 0.6;
const WALL_DISTANCE = 10.5;     // distance du mur (règlement : 9,15 m)
const WALL_TOP = 2.0;           // hauteur que la balle doit franchir au-dessus du mur (m)
const WALL_SPACING = 0.75;      // espace entre joueurs du mur
const MAX_DRAG_PX = 240;              // glisser de 240 px = puissance maximale
const AIM_REF_PX = 180;               // glisser de 180 px = viseur au maximum sur le but
const GOALIE_REACTION = [0.18, 0.3];  // temps de réaction du gardien (s)
const GOALIE_NOISE = 0.45;            // erreur de lecture du tir (m)
const GOALIE_WRONG_WAY = 0.2;         // probabilité qu'il plonge du mauvais côté
const INSTRUCTIONS = {
  ready: 'Clique sur le ballon, puis glisse vers le bas pour tirer',
  aim: 'Relâche pour tirer : la flèche part dans le sens opposé à ton geste',
  flight: 'Tir en cours…',
  done: 'Clique sur le ballon pour tirer tout de suite',
};

// Poteaux et barre transversale : segments de collision au niveau de la ligne de but
const GOAL_SEGMENTS = [
  [new THREE.Vector3(-GOAL.halfWidth, 0, 0), new THREE.Vector3(-GOAL.halfWidth, GOAL.height, 0)],
  [new THREE.Vector3(GOAL.halfWidth, 0, 0), new THREE.Vector3(GOAL.halfWidth, GOAL.height, 0)],
  [new THREE.Vector3(-GOAL.halfWidth, GOAL.height, 0), new THREE.Vector3(GOAL.halfWidth, GOAL.height, 0)],
];

// ---------------------------------------------------------------------------
// Éléments du DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const dom = {
  instruction: $('instruction'),
  message: $('message'),
  goals: $('goals'),
  shots: $('shots'),
  fillPower: $('fillPower'),
  powerValue: $('powerValue'),
  arrow: $('arrow'),
  arrowLine: $('arrowLine'),
  arrowHead: $('arrowHead'),
  loading: $('loading'),
  wallBtn: $('toggleWall'),
};

// ---------------------------------------------------------------------------
// État du jeu
// ---------------------------------------------------------------------------
const state = {
  mode: 'penalty',
  phase: 'ready',   // ready | aim | flight | done
  spot: PENALTY_SPOT.clone(), // position du ballon pour le tir en cours
  wallOn: true,     // mur présent (coup franc uniquement)
  power: 0.5,       // dernier tir : puissance (0..1), cible sur le but, effet (-1..1)
  aimX: 0,
  aimY: 0.9,
  curl: 0,
  goals: 0,
  shots: 0,
};

// Geste de tir en cours (clic sur le ballon + glisser)
const drag = {
  active: false,
  startX: 0, startY: 0,   // point de départ du geste (écran)
  x: 0, y: 0,             // position actuelle du curseur (écran)
  cx: 0, cy: 0,           // centre du ballon à l'écran
  power: 0,
  aimX: 0, aimY: 0.9,
  curl: 0,
};
const raycaster = new THREE.Raycaster();
const _pointer = new THREE.Vector2();
const _camRight = new THREE.Vector3();

let ready = false;
let ball = createBall(PENALTY_SPOT);
let shot = null;            // données du tir en cours
let shooter = null;
let goalieChar = null;
const wall = [];            // { char, base, y, vy, jumpTimer, active }
const goalie = {            // état physique et IA du gardien
  x: 0, y: 0, vx: 0, vy: 0,
  lean: 0, dirX: 0,
  active: false, waiting: false, wait: 0,
  tCross: 0.8, targetX: 0,
};

// Vecteurs temporaires (évite les allocations dans la boucle)
const _tmp = new THREE.Vector3();
const _ga = new THREE.Vector3();
const _gb = new THREE.Vector3();
const _gh = new THREE.Vector3();
const _wa = new THREE.Vector3();
const _wb = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _cl = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Rendu et scène
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ccfff);
scene.fog = new THREE.Fog(0x9ccfff, 120, 260);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
const camPos = new THREE.Vector3(0, 2.9, 18.5);
const camLook = new THREE.Vector3(0, 1.1, 0);
camera.position.copy(camPos);
camera.lookAt(camLook);

scene.add(new THREE.HemisphereLight(0xdfefff, 0x3d7a33, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-12, 30, 22);
sun.target.position.set(0, 0, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 100 });
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun, sun.target);

// Terrain (texture dessinée sur canvas : bandes d'herbe + marquages)
function makePitchTexture() {
  const { ppm, halfW, zMin } = PITCH;
  const W = halfW * 2 * ppm;
  const H = (PITCH.zMax - zMin) * ppm;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  // Bandes d'herbe
  for (let i = 0; i < 14; i++) {
    g.fillStyle = i % 2 ? '#3f9a3a' : '#48a843';
    g.fillRect(0, i * 5 * ppm, W, 5 * ppm);
  }

  // Conversion mètres -> pixels : x=-40 à gauche, z=-10 en haut
  const px = (x) => (x + halfW) * ppm;
  const py = (z) => (z - zMin) * ppm;

  g.strokeStyle = '#ffffff';
  g.fillStyle = '#ffffff';
  g.lineWidth = 4;

  const line = (x1, z1, x2, z2) => {
    g.beginPath();
    g.moveTo(px(x1), py(z1));
    g.lineTo(px(x2), py(z2));
    g.stroke();
  };
  const rect = (x1, z1, x2, z2) => g.strokeRect(px(x1), py(z1), (x2 - x1) * ppm, (z2 - z1) * ppm);

  line(-40, 0, 40, 0);                 // ligne de but
  rect(-20.16, 0, 20.16, 16.5);        // surface de réparation
  rect(-9.16, 0, 9.16, 5.5);           // petite surface

  // Point de penalty et arc de 9,15 m hors de la surface
  g.beginPath();
  g.arc(px(0), py(11), 0.25 * ppm, 0, Math.PI * 2);
  g.fill();
  const a0 = Math.asin(5.5 / 9.15);
  g.beginPath();
  g.arc(px(0), py(11), 9.15 * ppm, a0, Math.PI - a0);
  g.stroke();

  // Ligne médiane et rond central (en haut du terrain)
  line(-40, 52.5, 40, 52.5);
  g.beginPath();
  g.arc(px(0), py(52.5), 9.15 * ppm, 0, Math.PI * 2);
  g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function buildPitch() {
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(PITCH.halfW * 2, PITCH.zMax - PITCH.zMin),
    new THREE.MeshStandardMaterial({ map: makePitchTexture(), roughness: 0.9 }),
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.set(0, 0, (PITCH.zMax + PITCH.zMin) / 2);
  pitch.receiveShadow = true;
  scene.add(pitch);

  // Sol autour du terrain
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0x2f6d2b, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);
}

// Filet : texture de losanges transparents
function makeNetTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(64, 64);
  g.moveTo(64, 0); g.lineTo(0, 64);
  g.moveTo(0, 32); g.lineTo(64, 32);
  g.moveTo(32, 0); g.lineTo(32, 64);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, 3);
  return t;
}

function buildGoal() {
  const group = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });

  const postGeo = new THREE.CylinderGeometry(GOAL.postRadius, GOAL.postRadius, GOAL.height, 12);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, white);
    post.position.set(sx * GOAL.halfWidth, GOAL.height / 2, 0);
    post.castShadow = true;
    group.add(post);
  }
  const bar = new THREE.Mesh(
    new THREE.CylinderGeometry(GOAL.postRadius, GOAL.postRadius, GOAL.halfWidth * 2, 12),
    white,
  );
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, GOAL.height, 0);
  bar.castShadow = true;
  group.add(bar);

  const netMat = new THREE.MeshBasicMaterial({
    map: makeNetTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(GOAL.halfWidth * 2, GOAL.height), netMat);
  back.position.set(0, GOAL.height / 2, -GOAL.depth);
  group.add(back);

  const top = new THREE.Mesh(new THREE.PlaneGeometry(GOAL.halfWidth * 2, GOAL.depth), netMat);
  top.rotation.x = Math.PI / 2;
  top.position.set(0, GOAL.height, -GOAL.depth / 2);
  group.add(top);

  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(GOAL.depth, GOAL.height), netMat);
    side.rotation.y = Math.PI / 2;
    side.position.set(sx * GOAL.halfWidth, GOAL.height / 2, -GOAL.depth / 2);
    group.add(side);
  }
  scene.add(group);
}

// Ballon : texture blanche avec des taches noires
function makeBallTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#111111';
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    g.arc(Math.random() * 512, Math.random() * 256, 18 + Math.random() * 12, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const ballMesh = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_RADIUS, 24, 16),
  new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.5 }),
);
ballMesh.castShadow = true;
scene.add(ballMesh);


buildPitch();
buildGoal();

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
let lastSpotIndex = -1;

/** Position du ballon pour le prochain tir. Coup franc : un endroit différent à chaque fois. */
function pickSpot() {
  if (state.mode === 'penalty') {
    lastSpotIndex = -1;
    return PENALTY_SPOT.clone();
  }
  let i;
  do {
    i = Math.floor(Math.random() * FREEKICK_SPOTS.length);
  } while (i === lastSpotIndex && FREEKICK_SPOTS.length > 1);
  lastSpotIndex = i;
  return FREEKICK_SPOTS[i].clone();
}

/** Direction horizontale (x, 0, z) du point `pos` vers le centre du but. */
function dirToGoal(pos) {
  return new THREE.Vector3(-pos.x, 0, -pos.z).normalize();
}

function gaussian() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function setPhase(phase) {
  state.phase = phase;
  state.t = 0;
  dom.instruction.textContent = INSTRUCTIONS[phase];
}

function showMessage(text, isGoal) {
  dom.message.textContent = text;
  dom.message.className = `show ${isGoal ? 'goal' : 'miss'}`;
}

// ---------------------------------------------------------------------------
// Mise en place : balle, tireur, mur, gardien
// ---------------------------------------------------------------------------
function resetFormation(spot = pickSpot()) {
  state.spot = spot;
  ball = createBall(spot);
  ballMesh.position.copy(spot);
  ballMesh.quaternion.identity();
  shot = null;
  dom.message.className = '';
  dom.message.textContent = '';

  // Tireur : derrière la balle, face au but
  const toGoal = dirToGoal(spot);
  // Légèrement décalé sur le côté pour ne pas cacher le ballon à la caméra
  const side = new THREE.Vector3(-toGoal.z, 0, toGoal.x);
  const shooterPos = spot.clone().addScaledVector(toGoal, -1.4).addScaledVector(side, 0.9);
  shooter.setPosition(shooterPos.x, 0, shooterPos.z);
  shooter.setFacing(toGoal);
  shooter.kickTimer = 0;
  shooter.play('idle');

  // Mur : à 9,15 m de la balle, face à la balle (coup franc seulement)
  const lat = new THREE.Vector3(-toGoal.z, 0, toGoal.x);
  const center = spot.clone().addScaledVector(toGoal, WALL_DISTANCE);
  wall.forEach((w, i) => {
    w.active = state.mode === 'freekick' && state.wallOn;
    w.char.root.visible = w.active;
    w.base.copy(center).addScaledVector(lat, (i - (wall.length - 1) / 2) * WALL_SPACING);
    w.base.y = 0;
    w.y = 0;
    w.vy = 0;
    w.jumpTimer = -1;
    w.char.setPosition(w.base.x, 0, w.base.z);
    w.char.setFacing(_tmp.subVectors(spot, w.base));
    w.char.play('idle');
  });

  // Gardien : sur la ligne, face au tireur
  Object.assign(goalie, { x: 0, y: 0, vx: 0, vy: 0, lean: 0, dirX: 0, active: false, waiting: false, wait: 0 });
  goalieChar.setPosition(0, 0, GOALIE_HOME_Z);
  goalieChar.setFacing(_tmp.subVectors(spot, goalieChar.root.position));
  goalieChar.play('idle');

  updateWallButton();
}

/** Le bouton « Mur » n'apparaît qu'en coup franc. */
function updateWallButton() {
  dom.wallBtn.hidden = state.mode !== 'freekick';
  dom.wallBtn.textContent = state.wallOn ? 'Mur : oui' : 'Mur : non';
}

dom.wallBtn.addEventListener('click', () => {
  if (!ready || state.phase === 'flight') return;
  cancelNext();
  state.wallOn = !state.wallOn;
  resetFormation(state.spot.clone()); // on garde le même endroit de tir
  setPhase('ready');
});

// ---------------------------------------------------------------------------
// Gardien : lecture du tir, plongeon physique
// ---------------------------------------------------------------------------
/** Le gardien choisit un côté à partir de la prédiction du tir (avec erreur). */
function decideGoalie(pred) {
  const predX = pred ? pred.pos.x : 0;
  let target = predX + gaussian() * GOALIE_NOISE;
  if (Math.random() < GOALIE_WRONG_WAY) {
    target = -Math.sign(predX || 1) * (1.2 + Math.random() * 2);
  }
  goalie.tCross = pred ? pred.t : 0.8;
  goalie.targetX = THREE.MathUtils.clamp(target, -GOAL.halfWidth - 0.4, GOAL.halfWidth + 0.4);
  goalie.dirX = Math.abs(target) < 0.6 ? 0 : Math.sign(target);
  goalie.waiting = goalie.dirX !== 0;
  goalie.wait = THREE.MathUtils.lerp(GOALIE_REACTION[0], GOALIE_REACTION[1], Math.random());
}

function startDive() {
  const remaining = Math.max(0.2, goalie.tCross - (shot ? shot.time : 0));
  const dist = goalie.targetX - goalie.x;
  goalie.vx = THREE.MathUtils.clamp(dist / remaining, -9, 9);
  goalie.vy = 2.8;
  goalie.active = true;
}

function updateGoalie(dt) {
  const K = goalie;
  if (K.waiting) {
    K.wait -= dt;
    if (K.wait <= 0) {
      K.waiting = false;
      startDive();
    }
  }
  if (K.active) {
    K.vy -= G * dt;
    K.x += K.vx * dt;
    K.y += K.vy * dt;
    if (K.y <= 0) {
      K.y = 0;
      K.vy = 0;
      K.vx *= Math.exp(-6 * dt); // freine en touchant le sol
    }
    K.lean = Math.min(1.35, K.lean + dt * 5); // se couche progressivement
    K.x = THREE.MathUtils.clamp(K.x, -GOAL.halfWidth - 1.6, GOAL.halfWidth + 1.6);
  }
  goalieChar.setPosition(K.x, K.y, GOALIE_HOME_Z);
  goalieChar.root.rotation.z = -K.dirX * K.lean; // rotation autour de l'axe Z (couché sur le côté)
  goalieChar.play(K.active && K.y > 0.05 ? 'fall' : 'idle');
  goalieChar.update(dt);
}

/** Segment représentant le corps et les bras du gardien (capsule). */
function goalieSegment() {
  const K = goalie;
  _ga.set(K.x, K.y, GOALIE_HOME_Z);
  _gh.set(K.dirX * Math.sin(K.lean), Math.cos(K.lean), 0);
  _gb.copy(_ga).addScaledVector(_gh, 1.85);
  return { a: _ga, b: _gb };
}

// ---------------------------------------------------------------------------
// Mur : sauts physiques
// ---------------------------------------------------------------------------
function updateWall(dt) {
  for (const w of wall) {
    if (!w.active) continue;
    if (w.jumpTimer >= 0) {
      w.jumpTimer -= dt;
      if (w.jumpTimer < 0) {
        w.vy = 3.6 + Math.random() * 0.8;   // saut de 0,6 à 0,9 m
        w.char.play('jump', { once: true });
      }
    }
    if (w.vy !== 0 || w.y > 0) {
      w.vy -= G * dt;
      w.y += w.vy * dt;
      if (w.y <= 0) {
        w.y = 0;
        w.vy = 0;
        w.char.play('idle');
      }
    }
    w.char.setPosition(w.base.x, w.y, w.base.z);
    w.char.update(dt);
  }
}

// ---------------------------------------------------------------------------
// Tir
// ---------------------------------------------------------------------------
function kick() {
  const origin = ball.pos.clone();
  const dirH = new THREE.Vector3(state.aimX - origin.x, 0, -origin.z).normalize();
  const speed = 14 + state.power * 20;                     // 14 à 34 m/s
  const hasWall = wall.some((w) => w.active);
  const obstacle = hasWall ? { dist: WALL_DISTANCE, top: WALL_TOP } : null;
  const angle = solveLaunchAngle(origin, dirH, speed, state.aimY, obstacle);

  ball.vel.set(
    dirH.x * speed * Math.cos(angle),
    speed * Math.sin(angle),
    dirH.z * speed * Math.cos(angle),
  );
  ball.spin.set(0, -state.curl * MAX_SPIN, 0); // effet : rotation autour de l'axe vertical

  // Le gardien lit le tir (trajectoire prédite avec l'effet)
  const pred = predictCrossing(ball.pos, ball.vel, ball.spin, 3);
  shot = {
    time: 0,
    still: 0,
    crossed: false,
    done: false,
    result: null,
    isGoal: false,
    touched: { wall: false, keeper: false, post: false },
  };
  decideGoalie(pred);

  for (const w of wall) {
    if (w.active) w.jumpTimer = 0.08 + Math.random() * 0.12;
  }
  shooter.play('attack-kick-right', { once: true, fade: 0.08 });
  shooter.kickTimer = 1.0;
  setPhase('flight');
}

function labelFor() {
  if (shot.touched.keeper) return 'ARRÊT';
  if (shot.touched.wall) return 'MUR';
  if (shot.touched.post) return 'POTEAU';
  return 'RATÉ';
}

function assignResult(isGoal) {
  if (shot.result) return;
  shot.isGoal = isGoal;
  shot.result = isGoal ? 'BUT !' : labelFor();
  state.shots++;
  if (isGoal) state.goals++;
  dom.goals.textContent = state.goals;
  dom.shots.textContent = state.shots;
  showMessage(shot.result, isGoal);
}

/** Un pas de physique (sous-pas) : collisions, filet, franchissement de la ligne. */
function stepFlight(h) {
  const prevZ = ball.pos.z;
  integrate(ball, h);

  for (const [a, b] of GOAL_SEGMENTS) {
    if (collideSegment(ball, a, b, GOAL.postRadius, 0.6)) shot.touched.post = true;
  }

  for (const w of wall) {
    if (!w.active) continue;
    _wa.set(w.base.x, w.y + 0.1, w.base.z);
    _wb.set(w.base.x, w.y + 1.75, w.base.z);
    if (collideSegment(ball, _wa, _wb, 0.28, 0.4)) shot.touched.wall = true;
  }

  const seg = goalieSegment();
  if (collideSegment(ball, seg.a, seg.b, 0.42, 0.55)) shot.touched.keeper = true;

  // Filet : la balle s'arrête au fond
  const netZ = -GOAL.depth + BALL_RADIUS;
  if (ball.pos.z < netZ) {
    ball.pos.z = netZ;
    if (ball.vel.z < 0) ball.vel.z *= -0.3;
    ball.vel.x *= 0.5;
    ball.vel.y *= 0.5;
  }

  // Franchissement de la ligne de but
  if (!shot.crossed && prevZ > 0 && ball.pos.z <= 0) {
    shot.crossed = true;
    const inFrame = Math.abs(ball.pos.x) < GOAL.halfWidth && ball.pos.y < GOAL.height;
    assignResult(inFrame);
  }

  // Hors jeu
  if (Math.abs(ball.pos.x) > 60 || ball.pos.z > 90 || ball.pos.y > 60) {
    assignResult(false);
    shot.done = true;
  }

  // Balle immobile au sol
  const speed = ball.vel.length();
  if (ball.pos.y <= BALL_RADIUS + 1e-3 && speed < 0.3) shot.still += h;
  else shot.still = 0;
  if (shot.still > 0.8 || shot.time > 7) shot.done = true;

  shot.time += h;
}

// Nouveau coup franc (ou penalty) proposé automatiquement après un tir
const NEXT_SHOT_DELAY_MS = 3000;
let nextTimer = null;

function scheduleNext() {
  cancelNext();
  nextTimer = setTimeout(() => {
    nextTimer = null;
    resetFormation(); // nouvel endroit de tir (coup franc)
    setPhase('ready');
  }, NEXT_SHOT_DELAY_MS);
}

function cancelNext() {
  if (nextTimer !== null) {
    clearTimeout(nextTimer);
    nextTimer = null;
  }
}

function finishShot() {
  assignResult(false);
  setPhase('done');
  scheduleNext();
  dom.instruction.textContent = 'Nouveau tir dans quelques secondes… ou clique sur le ballon pour tirer tout de suite';
}

// ---------------------------------------------------------------------------
// Caméra et interface
// ---------------------------------------------------------------------------
function updateCamera(dt) {
  const k = 1 - Math.exp(-dt * 3);
  let tp;
  let tl;
  if (state.phase === 'flight' && shot) {
    // Suit la balle
    tp = _cp.set(ball.pos.x * 0.4, 1.8 + Math.max(0, ball.pos.y) * 0.5, Math.max(ball.pos.z + 7, 7));
    tl = _cl.copy(ball.pos);
  } else {
    // Derrière le tireur, vue vers le but
    const toGoal = dirToGoal(state.spot);
    tp = _cp.copy(state.spot).addScaledVector(toGoal, -7.5);
    tp.y = 2.9;
    tl = _cl.set(0, 1.1, 0);
  }
  camPos.lerp(tp, k);
  camLook.lerp(tl, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

/** Projette un point 3D sur l'écran (pixels). */
function projectToScreen(x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(camera);
  return {
    x: ((v.x + 1) / 2) * window.innerWidth,
    y: ((1 - v.y) / 2) * window.innerHeight,
  };
}

/**
 * Trouve la position x du but (à la hauteur `height`) qui se projette à l'écran
 * exactement dans la direction (ux, uy) depuis le centre du ballon.
 * Ainsi la flèche pointe précisément là où le tir va. Renvoie null si impossible.
 */
function aimXFromArrow(ux, uy, height) {
  const LEFT = -20;
  const RIGHT = 20;
  const P1 = projectToScreen(LEFT, height, 0);
  const P2 = projectToScreen(RIGHT, height, 0);
  const Dx = P2.x - P1.x;
  const Dy = P2.y - P1.y;
  // Résout : centre_ballon + s·(ux, uy) = P1 + t·(Dx, Dy)
  const Rx = P1.x - drag.cx;
  const Ry = P1.y - drag.cy;
  const det = -ux * Dy + Dx * uy;
  if (Math.abs(det) < 1e-6) return null;
  const s = (-Dy * Rx + Dx * Ry) / det;
  const t = (ux * Ry - uy * Rx) / det;
  if (s <= 0) return null; // la flèche pointe à l'opposé du but
  return THREE.MathUtils.clamp(LEFT + (RIGHT - LEFT) * t, LEFT, RIGHT);
}

/** Calcule puissance, direction et hauteur à partir du glisser, et met à jour la flèche. */
function updateAim() {
  const dx = drag.x - drag.startX;
  const dy = drag.y - drag.startY;
  const len = Math.hypot(dx, dy);

  drag.power = THREE.MathUtils.clamp(len / MAX_DRAG_PX, 0, 1);
  // Le tir part dans le sens OPPOSÉ au geste
  const ux = len > 0 ? -dx / len : 0;
  const uy = len > 0 ? -dy / len : 0;
  drag.aimY = 0.15 + THREE.MathUtils.clamp(dy / AIM_REF_PX, 0, 1) * (GOAL.height - 0.25);

  // Direction : le point visé sur le but est celui dont la projection est sur la flèche
  const gx = aimXFromArrow(ux, uy, drag.aimY);
  drag.aimX = gx !== null
    ? gx
    : THREE.MathUtils.clamp(-dx / AIM_REF_PX, -1, 1) * (GOAL.halfWidth + 0.5);

  // Flèche : part du ballon, dans le sens opposé au geste, longueur = puissance
  const length = 30 + drag.power * 220;
  const tipX = drag.cx + ux * length;
  const tipY = drag.cy + uy * length;
  const px = -uy;
  const py = ux;
  dom.arrowLine.setAttribute('x1', drag.cx);
  dom.arrowLine.setAttribute('y1', drag.cy);
  dom.arrowLine.setAttribute('x2', tipX);
  dom.arrowLine.setAttribute('y2', tipY);
  dom.arrowHead.setAttribute('points', [
    `${tipX},${tipY}`,
    `${tipX - ux * 18 + px * 10},${tipY - uy * 18 + py * 10}`,
    `${tipX - ux * 18 - px * 10},${tipY - uy * 18 - py * 10}`,
  ].join(' '));
  dom.arrow.classList.toggle('hidden', len < 4);

  dom.fillPower.style.width = `${drag.power * 100}%`;
  dom.powerValue.textContent = `${Math.round(drag.power * 100)} %`;

}

function updateHUD() {
  if (state.phase === 'aim') return; // géré par updateAim pendant le geste
  const shown = state.phase === 'ready' ? 0 : state.power;
  dom.fillPower.style.width = `${shown * 100}%`;
  dom.powerValue.textContent = `${Math.round(shown * 100)} %`;
}

// Clic sur le ballon : début du geste de tir
function onPointerDown(e) {
  if (!ready || e.button !== 0 || e.target.closest('button')) return;
  if (state.phase !== 'ready' && state.phase !== 'done') return;

  // Le clic doit toucher le ballon
  _pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(_pointer, camera);
  const hit = raycaster.intersectObject(ballMesh, false)[0];
  if (!hit) return;

  // Effet : point touché sur le ballon, côté droit ou gauche (-1 à 1)
  _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
  const offset = _tmp.subVectors(hit.point, ballMesh.position).dot(_camRight) / BALL_RADIUS;
  drag.curl = THREE.MathUtils.clamp(offset, -1, 1);

  if (state.phase === 'done') {
    cancelNext();
    resetFormation();
  }

  // Centre du ballon à l'écran (point d'où part la flèche)
  const p = ballMesh.position.clone().project(camera);
  drag.cx = ((p.x + 1) / 2) * window.innerWidth;
  drag.cy = ((1 - p.y) / 2) * window.innerHeight;

  drag.active = true;
  drag.startX = drag.x = e.clientX;
  drag.startY = drag.y = e.clientY;
  drag.power = 0;
  setPhase('aim');
  updateAim();
}

window.addEventListener('pointerdown', onPointerDown);

window.addEventListener('pointermove', (e) => {
  if (!drag.active) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  updateAim();
});

// Relâcher : le tir part (si le geste est assez long)
function onPointerUp() {
  if (!drag.active) return;
  drag.active = false;
  dom.arrow.classList.add('hidden');

  if (drag.power < 0.08) {
    dom.fillPower.style.width = '0%';
    dom.powerValue.textContent = '0 %';
    setPhase('ready');
    return;
  }
  state.power = drag.power;
  state.aimX = drag.aimX;
  state.aimY = drag.aimY;
  state.curl = drag.curl;
  kick();
}

window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!ready || state.phase === 'flight') return;
    cancelNext();
    state.mode = btn.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    resetFormation();
    setPhase('ready');
  });
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Boucle principale
// ---------------------------------------------------------------------------
let last = performance.now();

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (ready) {
    state.t += dt;

    if (state.phase === 'flight') {
      // Sous-pas de 1/240 s pour que la balle ne traverse pas les obstacles
      const steps = Math.ceil(dt * 240);
      const h = dt / steps;
      for (let i = 0; i < steps && !shot.done; i++) stepFlight(h);
      ballMesh.position.copy(ball.pos);

      const w = ball.spin.length();
      if (w > 0) {
        _axis.copy(ball.spin).divideScalar(w);
        ballMesh.rotateOnWorldAxis(_axis, w * dt);
      }
      if (shot.done) finishShot();
    }

    updateGoalie(dt);
    updateWall(dt);
    shooter.update(dt);
    if (shooter.kickTimer > 0) {
      shooter.kickTimer -= dt;
      if (shooter.kickTimer <= 0) shooter.play('idle');
    }
    updateHUD();
    updateCamera(dt);
  }

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Chargement des personnages
// ---------------------------------------------------------------------------
const WALL_MODELS = [
  'character-male-d.glb',
  'character-male-e.glb',
  'character-male-f.glb',
];

async function init() {
  try {
    const [shooterT, keeperT, ...wallT] = await Promise.all([
      loadCharacterTemplate('character-male-c.glb'),
      loadCharacterTemplate('character-soldier.glb'),
      ...WALL_MODELS.map(loadCharacterTemplate),
    ]);

    shooter = new Character(shooterT);
    scene.add(shooter.root);

    wallT.forEach((tpl) => {
      const char = new Character(tpl, { tint: 0xbcd8ff }); // maillot bleu clair
      scene.add(char.root);
      wall.push({ char, base: new THREE.Vector3(), y: 0, vy: 0, jumpTimer: -1, active: false });
    });

    goalieChar = new Character(keeperT, { tint: 0xffe27a }); // gardien en jaune
    goalieChar.root.rotation.order = 'YXZ'; // yaw puis roulis : le plongeon se fait dans le repère du joueur
    scene.add(goalieChar.root);

    ready = true;
    resetFormation();
    setPhase('ready');
    dom.loading.classList.add('hidden');
  } catch (err) {
    console.error(err);
    dom.loading.textContent =
      'Erreur de chargement des personnages. Lance le jeu avec un serveur local (voir README.md).';
  }
}

init();
requestAnimationFrame(tick);
