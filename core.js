/* Lollop core: world generation, traffic and the rules of movement.
   Pure logic with no DOM, so it can be tested with plain node. */
(function (root) {
'use strict';

const HALF = 4;            // playable columns run from -4 to 4
const SPAN = 32;           // traffic loops round x from -16 to 16
const MIN_ROW = -3;        // furthest back the fox can go
const SWEPT = HALF + 1;    // carried this far out on a boat, the fox is swept away
const ZONE_LEN = 46;       // rows in a zone, give or take a safe strip
const ZONES = ['country', 'town', 'future'];
const ZONE_NAMES = { country: 'Countryside', town: 'High street', future: 'The year 2200' };
const HOP = 0.14;          // seconds for one hop
const LOLLOP = 0.28;       // seconds for a two-row lollop
const LOLLOP_EVERY = 15;   // new rows needed to recharge the lollop
const SWITCH = 0.3;        // share of a hop after which the fox counts as in the row it is hopping to

/* ---------- Random numbers ---------- */
function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909);
  return (h ^ h >>> 16) >>> 0;
}
function mix(a, b) {
  let h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x632BE5AB | 0, 0xC2B2AE35);
  h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D); h ^= h >>> 15; h = Math.imul(h, 0x846CA68B); h ^= h >>> 16;
  return h >>> 0;
}
const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dailySeed = (d) => hashStr('lollop-' + dateKey(d || new Date()));
function randomSeed() {
  try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch { return (Math.random() * 4294967296) >>> 0; }
}
const wrap = (x) => ((x + SPAN / 2) % SPAN + SPAN) % SPAN - SPAN / 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const diff = (r) => clamp(r / 320, 0, 1);   // 0 at the start, 1 by row 320
function pick(rng, list) {
  let total = 0; for (const it of list) total += it.w;
  let x = rng() * total;
  for (const it of list) { x -= it.w; if (x <= 0) return it; }
  return list[list.length - 1];
}

/* ---------- What lives in each zone ---------- */
const VEHICLES = {
  country: [{ kind: 'car', len: 1.15, spd: 1, w: 4 }, { kind: 'van', len: 1.75, spd: 0.95, w: 2 },
    { kind: 'tractor', len: 1.5, spd: 0.6, w: 2 }, { kind: 'lorry', len: 2.7, spd: 0.8, w: 1.2 }],
  town: [{ kind: 'car', len: 1.15, spd: 1, w: 4 }, { kind: 'cab', len: 1.3, spd: 1.05, w: 3 },
    { kind: 'bus', len: 2.8, spd: 0.85, w: 2 }, { kind: 'van', len: 1.75, spd: 0.95, w: 1.5 }],
  future: [{ kind: 'hover', len: 1.25, spd: 1.2, w: 4 }, { kind: 'pod', len: 0.9, spd: 1.4, w: 2 },
    { kind: 'hoverbus', len: 2.6, spd: 0.95, w: 1.6 }],
};
const OBSTACLES = {
  country: [{ kind: 'tree', w: 5 }, { kind: 'pine', w: 2 }, { kind: 'hedge', w: 2.5 }, { kind: 'rock', w: 1.5 }, { kind: 'hay', w: 1.5 }, { kind: 'sheep', w: 1.2 }],
  town: [{ kind: 'lamp', w: 2.5 }, { kind: 'postbox', w: 2 }, { kind: 'bollard', w: 2 }, { kind: 'bench', w: 1.5 }, { kind: 'planter', w: 2 }, { kind: 'bin', w: 1.5 }],
  future: [{ kind: 'pylon', w: 2 }, { kind: 'holotree', w: 3 }, { kind: 'bot', w: 1.5 }, { kind: 'crystal', w: 2 }, { kind: 'dome', w: 1.2 }],
};
const BOATS = { country: { kind: 'log', min: 2.2, max: 3.6 }, town: { kind: 'narrowboat', min: 3.2, max: 4.6 }, future: { kind: 'raft', min: 2.2, max: 3.3 } };
const DENSITY = { country: 0.27, town: 0.2, future: 0.22 };
const HAZARDS = {
  country: [{ t: 'road', w: 0.42 }, { t: 'water', w: 0.38 }, { t: 'rail', w: 0.2 }],
  town: [{ t: 'road', w: 0.55 }, { t: 'rail', w: 0.22 }, { t: 'water', w: 0.23 }],
  future: [{ t: 'road', w: 0.45 }, { t: 'rail', w: 0.25 }, { t: 'water', w: 0.3 }],
};

/* ---------- World ---------- */
function createWorld(seed) {
  const W = { seed: seed >>> 0, rows: [], pre: [] };
  W.g = { rng: mulberry(mix(seed, 0x51ED)), next: 0, plan: [], req: [0], zone: 0, zoneEnd: ZONE_LEN, lastHazard: false, lastType: null, prev: null, boatDir: 1 };
  // Behind the start: three open rows, then a solid treeline
  for (let i = 1; i <= 9; i++) {
    const r = -i, rng = mulberry(mix(W.seed, r));
    const obs = new Array(2 * HALF + 1).fill(null);
    for (let c = -HALF; c <= HALF; c++) {
      if (r < MIN_ROW || (Math.abs(c) >= 2 && rng() < 0.45)) obs[c + HALF] = rng() < 0.7 ? 'tree' : 'pine';
    }
    W.pre.push({ r, type: 'grass', zone: 'country', obs, chips: [], seed: mix(W.seed, r + 7777) });
  }
  return W;
}

function row(W, r) {
  if (r < 0) return W.pre[Math.min(-r, W.pre.length) - 1];
  while (W.g.next <= r) genRow(W);
  return W.rows[r];
}

function planNext(W, r) {
  const g = W.g, rng = g.rng, d = diff(r);
  if (r === 0) {
    for (let i = 0; i < 4; i++) g.plan.push({ type: 'grass', zone: 'country', start: true, zoneStart: i === 0 });
    g.lastHazard = false;
    return;
  }
  if (g.lastHazard) {
    let n = 1 + (rng() < 0.45 ? 1 : 0) + (rng() < 0.12 ? 1 : 0);
    let zoneStart = false;
    if (r >= g.zoneEnd) { g.zone = (g.zone + 1) % ZONES.length; g.zoneEnd = r + ZONE_LEN; n = Math.max(n, 2); zoneStart = true; }
    const zone = ZONES[g.zone];
    for (let i = 0; i < n; i++) g.plan.push({ type: 'grass', zone, zoneStart: zoneStart && i === 0 });
    g.lastHazard = false;
    return;
  }
  const zone = ZONES[g.zone];
  let h = pick(rng, HAZARDS[zone]).t;
  if (h === g.lastType && rng() < 0.6) h = pick(rng, HAZARDS[zone]).t;
  g.lastType = h;
  g.lastHazard = true;
  if (h === 'road') {
    const max = zone === 'country' ? 3 : 4;
    let n = 1 + Math.floor(rng() * (1.6 + 2.2 * d + (zone === 'country' ? 0 : 0.8)));
    n = clamp(n, 1, max);
    for (let i = 0; i < n; i++) g.plan.push({ type: 'road', zone });
  } else if (h === 'rail') {
    const n = rng() < 0.25 + 0.25 * d ? 2 : 1;
    for (let i = 0; i < n; i++) g.plan.push({ type: 'rail', zone });
  } else {
    const cap = zone === 'town' ? 2 : 3;
    const n = clamp(1 + Math.floor(rng() * (1.7 + 1.5 * d)), 1, cap);
    let pads = zone !== 'town' && rng() < (zone === 'country' ? 0.42 : 0.35);
    for (let i = 0; i < n; i++) {
      g.plan.push({ type: 'water', sub: pads ? 'pads' : 'boats', zone });
      if (pads) pads = rng() < 0.3;   // pads may follow pads; once on boats, it stays boats
    }
  }
}

function genRow(W) {
  const g = W.g, r = g.next++;
  if (!g.plan.length) planNext(W, r);
  const spec = g.plan.shift();
  if (!g.plan.length) planNext(W, r + 1);   // look one row ahead, so a row can prepare for what follows
  const L = makeRow(W, r, spec, g.plan[0]);
  W.rows[r] = L;
  g.prev = L;
}

function makeRow(W, r, spec, next) {
  const g = W.g, rng = mulberry(mix(W.seed, r)), d = diff(r), zone = spec.zone;
  const L = { r, type: spec.type, zone, seed: mix(W.seed, r + 7777), chips: [] };
  if (spec.zoneStart) L.zoneStart = true;
  const prev = g.prev;
  if (spec.type === 'grass') {
    // Keep open the exits of the last row the fox could walk along (roads and rails carry them across)
    const req = new Set(prev && !(prev.type === 'water' && prev.sub === 'boats') ? g.req : []);
    const obs = new Array(2 * HALF + 1).fill(null);
    const afterBoats = prev && prev.type === 'water' && prev.sub === 'boats';
    let dens = DENSITY[zone] * (0.85 + 0.35 * d);
    if (spec.start) dens = 0.3;
    let placed = 0;
    for (let c = -HALF; c <= HALF; c++) {
      if (req.has(c)) continue;
      if (spec.start && Math.abs(c) < 2) continue;
      if (afterBoats && placed >= 2) continue;
      if (rng() < dens) { obs[c + HALF] = pick(rng, OBSTACLES[zone]).kind; placed++; }
    }
    if (obs.every(Boolean)) obs[HALF] = null;
    const segments = () => {
      const out = []; let seg = [];
      for (let c = -HALF; c <= HALF + 1; c++) {
        if (c <= HALF && !obs[c + HALF]) { seg.push(c); continue; }
        if (seg.length) { out.push(seg); seg = []; }
      }
      return out;
    };
    // Before water, every run of open cells must reach the middle five columns, so nobody
    // is left boarding a boat at the very edge of the river
    const toWater = next && next.type === 'water';
    if (toWater) {
      for (let guard = 0; guard < 9; guard++) {
        const bad = segments().find((sg) => sg.every((c) => Math.abs(c) > 2));
        if (!bad) break;
        const inner = bad[0] > 0 ? bad[0] - 1 : bad[bad.length - 1] + 1;   // the obstacle walling it in
        obs[inner + HALF] = null;
      }
    }
    // Each run of open cells gets one exit that the next row must keep open
    const exits = segments().map((sg) => {
      const pool = toWater ? sg.filter((c) => Math.abs(c) <= 2) : sg;
      return pool[Math.floor(rng() * pool.length)];
    });
    g.req = exits;
    L.obs = obs;
    if (r >= 5) for (let c = -HALF; c <= HALF; c++) if (!obs[c + HALF] && rng() < 0.028) L.chips.push(c);
  } else if (spec.type === 'road') {
    const list = VEHICLES[zone];
    const main = pick(rng, list);
    const speed = Math.min(6.4, (1.7 + rng() * 1.5) * (1 + 0.55 * d) * main.spd);
    const gmin = Math.max(2.4, speed * 0.62 + 1.0);
    const kinds = [];
    const maxN = Math.max(1, Math.floor(SPAN / (main.len + gmin)));
    let n = clamp(Math.round(maxN * (0.35 + 0.35 * d + rng() * 0.25)), 1, maxN);
    for (let i = 0; i < n; i++) {
      const k = rng() < 0.7 ? main : pick(rng, list);
      kinds.push(k);
    }
    let total = () => kinds.reduce((s, k) => s + k.len, 0) + kinds.length * gmin;
    while (kinds.length > 1 && total() > SPAN) kinds.pop();
    const free = SPAN - total();
    const cuts = kinds.map(() => rng());
    const cs = cuts.reduce((a, b) => a + b, 0) || 1;
    let x = rng() * SPAN;
    L.objs = kinds.map((k, i) => {
      const o = { x0: wrap(x + k.len / 2), len: k.len, kind: k.kind };
      x += k.len + gmin + free * cuts[i] / cs;
      return o;
    });
    L.dir = rng() < 0.5 ? 1 : -1;
    L.speed = speed;
    L.gmin = gmin;
    if (r >= 5) for (let c = -HALF; c <= HALF; c++) if (rng() < 0.015) L.chips.push(c);
  } else if (spec.type === 'rail') {
    const cars = 3 + Math.floor(rng() * 3);
    const speed = 22 + rng() * 8 + d * 6 + (zone === 'future' ? 6 : 0);
    const len = cars * 3.2;
    const warn = 1.5;
    const pass = (SPAN + len) / speed;
    const idle = Math.max(1.8, 2.2 + rng() * 3.5 - d * 0.8);
    const period = warn + pass + idle;
    L.rail = { dir: rng() < 0.5 ? 1 : -1, speed, cars, len, warn, pass, idle, period, off: rng() * period };
  } else if (spec.sub === 'pads') {
    L.sub = 'pads';
    const set = new Set(g.req);
    for (let c = -2; c <= 2; c++) if (rng() < 0.32) set.add(c);   // pads stay in the middle five columns
    while (set.size < 2) set.add(Math.floor(rng() * 5) - 2);
    L.pads = [...set].sort((a, b) => a - b);
    g.req = L.pads.slice();
  } else {
    L.sub = 'boats';
    const B = BOATS[zone];
    const speed = (0.8 + rng() * 0.9) * (1 + 0.45 * d);
    // Boats until the average gap between them sits between 1.6 and 3.2 cells
    const want = 1.9 + rng() * 0.9 + d * 0.4;
    const lens = [];
    let sumLen = 0;
    while (sumLen + lens.length * want < SPAN) { const len = B.min + rng() * (B.max - B.min); lens.push(len); sumLen += len; }
    let avg = (SPAN - sumLen) / lens.length;
    while (avg < 1.6 && lens.length > 2) { sumLen -= lens.pop(); avg = (SPAN - sumLen) / lens.length; }
    while (avg > 3.2) { const len = B.min + rng() * (B.max - B.min); lens.push(len); sumLen += len; avg = (SPAN - sumLen) / lens.length; }
    // Vary each gap a little, then scale so the loop closes exactly
    const wts = lens.map(() => 0.7 + rng() * 0.6);
    const wsum = wts.reduce((a, b) => a + b, 0);
    const gaps = wts.map((w) => (SPAN - sumLen) * w / wsum);
    let x = rng() * SPAN;
    L.objs = lens.map((len, i) => { const o = { x0: wrap(x + len / 2), len, kind: B.kind }; x += len + gaps[i]; return o; });
    L.gaps = gaps;
    L.dir = prev && prev.type === 'water' && prev.sub === 'boats' ? -prev.dir : (rng() < 0.5 ? 1 : -1);
    L.speed = speed;
    g.req = [];
  }
  return L;
}

/* ---------- Traffic over time ---------- */
const objX = (L, i, t) => wrap(L.objs[i].x0 + L.dir * L.speed * t);

function train(L, t) {
  const R = L.rail, ph = ((t + R.off) % R.period + R.period) % R.period;
  if (ph < R.warn) return { warn: true, on: false, phase: ph, until: R.warn - ph };
  const s = (ph - R.warn) * R.speed;
  if (s > SPAN + R.len) return { warn: false, on: false, phase: ph, until: R.period - ph + R.warn };
  const front = -R.dir * SPAN / 2 + R.dir * s;
  return { warn: true, on: true, phase: ph, front, x: front - R.dir * R.len / 2, len: R.len };
}

/* What would hit the fox at x on row r at time t, if anything. hw is the fox's half width. */
function hazard(W, x, r, t, hw) {
  hw = hw == null ? 0.28 : hw;
  const L = row(W, r);
  if (L.type === 'road') {
    for (let i = 0; i < L.objs.length; i++) {
      if (Math.abs(x - objX(L, i, t)) < L.objs[i].len / 2 - 0.08 + hw) return { kind: 'car', vehicle: L.objs[i].kind, i };
    }
  } else if (L.type === 'rail') {
    const T = train(L, t);
    if (T.on && Math.abs(x - T.x) < T.len / 2 + hw) return { kind: 'train' };
  }
  return null;
}

function boatAt(L, x, t) {
  for (let i = 0; i < L.objs.length; i++) if (Math.abs(x - objX(L, i, t)) <= L.objs[i].len / 2 - 0.05) return i;
  return -1;
}

function blocked(W, col, r) {
  if (col < -HALF || col > HALF || r < MIN_ROW) return true;
  const L = row(W, r);
  return L.type === 'grass' && !!L.obs[col + HALF];
}

/* Where a move would take the fox, or null if something is in the way. */
function plan(W, p, dir) {
  let dr = 0, dx = 0;
  if (dir === 'up') dr = 1; else if (dir === 'down') dr = -1; else if (dir === 'lollop') dr = 2;
  else if (dir === 'left') dx = -1; else if (dir === 'right') dx = 1; else return null;
  const r = p.r + dr;
  if (r < MIN_ROW) return null;
  const T = row(W, r);
  const x = T.type === 'water' && T.sub === 'boats' ? p.x + dx : Math.round(p.x + dx);
  const c = Math.round(x);
  if (c < -HALF || c > HALF) return null;
  if (T.type === 'grass' && T.obs[c + HALF]) return null;
  return { x, r, lollop: dir === 'lollop' };
}

/* What the fox lands on at the end of a hop. */
function land(W, x, r, t) {
  const L = row(W, r);
  if (L.type !== 'water') return { on: 'ground', x: Math.round(x) };
  if (L.sub === 'pads') { const c = Math.round(x); return L.pads.includes(c) ? { on: 'pad', x: c } : { on: 'water', x }; }
  const i = boatAt(L, x, t);
  return i < 0 ? { on: 'water', x } : { on: 'boat', x, i, off: x - objX(L, i, t) };
}

const chipAt = (W, x, r) => { const L = row(W, r); return r >= 0 && L.chips.includes(Math.round(x)); };

const Core = { HALF, SPAN, MIN_ROW, SWEPT, ZONES, ZONE_NAMES, HOP, LOLLOP, LOLLOP_EVERY, SWITCH, VEHICLES, BOATS,
  mulberry, hashStr, mix, dateKey, dailySeed, randomSeed, wrap, diff,
  createWorld, row, objX, train, hazard, boatAt, blocked, plan, land, chipAt };
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
