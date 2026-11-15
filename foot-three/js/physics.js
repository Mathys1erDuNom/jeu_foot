import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Physique de la balle (unités SI : mètres, secondes, kilogrammes)
// - gravité
// - traînée aérodynamique  F = ½ ρ Cd A v²
// - effet Magnus (courbe / effet) à partir de la rotation de la balle
// - rebonds et frottement de roulement au sol
// - collisions avec des segments (poteaux, barre, joueurs du mur, gardien)
// ---------------------------------------------------------------------------

export const G = 9.81;
export const BALL_RADIUS = 0.11;

const BALL_MASS = 0.43;
const AIR_DENSITY = 1.2;
const DRAG_COEF = 0.25;
const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
const K_DRAG = (0.5 * AIR_DENSITY * DRAG_COEF * BALL_AREA) / BALL_MASS;
const K_LIFT = (0.5 * AIR_DENSITY * BALL_AREA) / BALL_MASS;

/** Vitesse de rotation maximale (rad/s) pour l'effet. */
export const MAX_SPIN = 110;

export const GOAL = {
  halfWidth: 3.66,   // un but fait 7.32 m de large
  height: 2.44,     // et 2.44 m de haut
  depth: 2.0,       // profondeur du filet
  postRadius: 0.06,
};

const ZERO = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _n = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _magnus = new THREE.Vector3();

export function createBall(position) {
  return {
    pos: position.clone(),
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
  };
}

/** Accélération de la balle : gravité + traînée + Magnus. Résultat dans `out`. */
function acceleration(vel, spin, out) {
  const speed = vel.length();
  out.copy(vel).multiplyScalar(-K_DRAG * speed);
  out.y -= G;

  const w = spin.length();
  if (w > 0 && speed > 0.5) {
    // Coefficient de portance qui augmente avec le rapport rotation / vitesse
    const spinRatio = (BALL_RADIUS * w) / speed;
    const lift = Math.min(0.4, 0.25 * spinRatio);
    _magnus.crossVectors(spin, vel).multiplyScalar((K_LIFT * lift * speed) / w);
    out.add(_magnus);
  }
  return out;
}

/** Avance la balle d'un pas de temps `dt` (intégration semi-implicite d'Euler). */
export function integrate(ball, dt) {
  acceleration(ball.vel, ball.spin, _acc);
  ball.vel.addScaledVector(_acc, dt);
  ball.pos.addScaledVector(ball.vel, dt);
  ball.spin.multiplyScalar(Math.exp(-0.2 * dt));

  // Contact avec le sol
  if (ball.pos.y <= BALL_RADIUS) {
    ball.pos.y = BALL_RADIUS;
    if (ball.vel.y < 0) {
      const impact = -ball.vel.y;
      ball.vel.y = impact > 0.8 ? impact * 0.5 : 0; // rebond amorti
      ball.vel.x *= 0.85;                           // perte d'énergie au contact
      ball.vel.z *= 0.85;
    }
    // Frottement de roulement (~1.2 m/s²)
    const hs = Math.hypot(ball.vel.x, ball.vel.z);
    if (hs > 0) {
      const k = Math.max(0, hs - 1.2 * dt) / hs;
      ball.vel.x *= k;
      ball.vel.z *= k;
    }
    ball.spin.multiplyScalar(Math.exp(-2 * dt));
  }
}

/**
 * Collision balle / segment [a, b] de rayon `radius`.
 * Si contact : repousse la balle et réfléchit la vitesse (coefficient `restitution`).
 * Un segment réduit à un point (a === b) représente une sphère.
 */
export function collideSegment(ball, a, b, radius, restitution = 0.5) {
  _ab.subVectors(b, a);
  const len2 = _ab.lengthSq();
  _ap.subVectors(ball.pos, a);
  const t = len2 > 0 ? THREE.MathUtils.clamp(_ap.dot(_ab) / len2, 0, 1) : 0;
  _closest.copy(a).addScaledVector(_ab, t);
  _n.subVectors(ball.pos, _closest);

  const d = _n.length();
  const minDist = radius + BALL_RADIUS;
  if (d >= minDist || d < 1e-6) return false;

  _n.divideScalar(d);
  ball.pos.copy(_closest).addScaledVector(_n, minDist);
  const vn = ball.vel.dot(_n);
  if (vn < 0) ball.vel.addScaledVector(_n, -(1 + restitution) * vn);
  return true;
}

/**
 * Simule la balle (sans collisions) jusqu'à ce qu'elle franchisse le plan
 * de la ligne de but (z = 0). Renvoie { t, pos } ou null.
 */
export function predictCrossing(pos, vel, spin, maxTime = 3) {
  const ball = { pos: pos.clone(), vel: vel.clone(), spin: spin.clone() };
  const dt = 1 / 240;
  for (let t = 0; t < maxTime; t += dt) {
    const prevZ = ball.pos.z;
    integrate(ball, dt);
    if (prevZ > 0 && ball.pos.z <= 0) return { t: t + dt, pos: ball.pos.clone() };
  }
  return null;
}

/**
 * Trouve l'angle de tir (en radians) qui fait passer la balle à la hauteur
 * `targetY` sur la ligne de but, en tenant compte de la traînée de l'air.
 * La direction horizontale est fixée par `dirH`.
 */
export function solveLaunchAngle(origin, dirH, speed, targetY) {
  let best = { err: Infinity, angle: 0 };
  for (let deg = -2; deg <= 45; deg += 0.25) {
    const a = THREE.MathUtils.degToRad(deg);
    const vel = new THREE.Vector3(
      dirH.x * speed * Math.cos(a),
      speed * Math.sin(a),
      dirH.z * speed * Math.cos(a),
    );
    const hit = predictCrossing(origin, vel, ZERO, 2.5);
    if (!hit) continue;
    const err = Math.abs(hit.pos.y - targetY);
    if (err < best.err) best = { err, angle: a };
  }
  return best.angle;
}
