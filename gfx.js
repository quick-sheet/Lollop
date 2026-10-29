/* Lollop graphics: a small WebGL 2 voxel renderer, the camera, the lighting for each time of day,
   and every model in the game. Everything is drawn from axis-aligned boxes. */
(function () {
'use strict';
const C = window.Core;
const G = {};

/* ---------- Colours ---------- */
const cache = {};
function col(hex) {
  let c = cache[hex];
  if (!c) { const n = parseInt(hex.slice(1), 16); c = cache[hex] = [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  return c;
}
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/* ---------- Times of day: one per colour theme ---------- */
const LIGHT = {
  day:      { sun: [1.0, 0.95, 0.84], sunK: 0.74, sky: [0.6, 0.64, 0.72], ground: [0.42, 0.4, 0.38], dir: [-0.42, 1, -0.3], night: 0, mono: [0, 0, 0, 0], clear: '#7FC6E8' },
  twilight: { sun: [0.62, 0.62, 0.95], sunK: 0.34, sky: [0.36, 0.4, 0.68], ground: [0.16, 0.15, 0.26], dir: [0.5, 1, -0.2], night: 0.85, mono: [0, 0, 0, 0], clear: '#0F1528' },
  red:      { sun: [1, 1, 1], sunK: 0.3, sky: [0.36, 0.36, 0.36], ground: [0.14, 0.14, 0.14], dir: [0.5, 1, -0.2], night: 1, mono: [1.0, 0.24, 0.16, 1], clear: '#0C0404' },
  amber:    { sun: [1, 0.9, 0.75], sunK: 0.3, sky: [0.38, 0.34, 0.3], ground: [0.16, 0.13, 0.1], dir: [0.5, 1, -0.2], night: 1, mono: [1.0, 0.66, 0.3, 0.9], clear: '#0D0904' },
  sea:      { sun: [0.6, 0.85, 0.95], sunK: 0.36, sky: [0.24, 0.42, 0.5], ground: [0.08, 0.15, 0.18], dir: [0.45, 1, -0.25], night: 0.9, mono: [0, 0, 0, 0], clear: '#06121A' },
  aurora:   { sun: [0.6, 0.98, 0.76], sunK: 0.32, sky: [0.24, 0.46, 0.36], ground: [0.08, 0.15, 0.12], dir: [0.45, 1, -0.25], night: 0.9, mono: [0, 0, 0, 0], clear: '#07110D' },
  dusk:     { sun: [1.0, 0.62, 0.55], sunK: 0.62, sky: [0.62, 0.46, 0.66], ground: [0.32, 0.22, 0.3], dir: [-0.85, 0.75, -0.2], night: 0.5, mono: [0, 0, 0, 0], clear: '#110D1A' },
};
let L = LIGHT.day, NIGHT = 0;

/* ---------- WebGL ---------- */
let gl, cv, progMain, progDepth, progGlow, vaoBox, vaoGlow, instBuf, glowBuf, shadowFbo, shadowTex, SHADOW = 2048, shadowsOn = true;
const MAXB = 20000, MAXG = 2000;
const inst = new Float32Array(MAXB * 10);
const glowAdd = new Float32Array(MAXG * 10), glowMix = new Float32Array(400 * 10);
let nb = 0, nga = 0, ngm = 0;

const VS_BOX = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN;
layout(location=2) in vec3 iC; layout(location=3) in vec3 iS; layout(location=4) in vec4 iCol;
uniform mat4 uVP; uniform mat4 uLVP;
out vec3 vN; out vec4 vCol; out vec3 vL;
void main() {
  vec3 w = iC + aP * iS;
  vN = aN; vCol = iCol;
  vec4 l = uLVP * vec4(w, 1.0); vL = l.xyz * 0.5 + 0.5;
  gl_Position = uVP * vec4(w, 1.0);
}`;
const FS_BOX = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 vN; in vec4 vCol; in vec3 vL;
uniform sampler2DShadow uSh; uniform float uTex; uniform float uShOn;
uniform vec3 uDir; uniform vec3 uSun; uniform vec3 uSky; uniform vec3 uGnd; uniform vec4 uMono;
out vec4 o;
float shadow() {
  if (uShOn < 0.5 || vL.x < 0.0 || vL.x > 1.0 || vL.y < 0.0 || vL.y > 1.0 || vL.z > 1.0) return 1.0;
  vec3 p = vL; p.z -= 0.0012;
  float s = texture(uSh, p + vec3(-uTex, -uTex, 0.0) * 0.6) + texture(uSh, p + vec3(uTex, -uTex, 0.0) * 0.6)
          + texture(uSh, p + vec3(-uTex, uTex, 0.0) * 0.6) + texture(uSh, p + vec3(uTex, uTex, 0.0) * 0.6);
  return s * 0.25;
}
void main() {
  vec3 n = normalize(vN);
  float ndl = max(dot(n, uDir), 0.0);
  float s = ndl > 0.0 ? shadow() : 1.0;
  vec3 amb = mix(uGnd, uSky, n.y * 0.5 + 0.5);
  vec3 c = vCol.rgb * (amb + uSun * ndl * mix(0.28, 1.0, s));
  c = mix(c, vCol.rgb * 1.12, clamp(vCol.a, 0.0, 1.0));
  float lum = dot(c, vec3(0.3, 0.59, 0.11));
  c = mix(c, lum * uMono.rgb * 1.25, uMono.a);
  o = vec4(c, 1.0);
}`;
const VS_DEPTH = `#version 300 es
layout(location=0) in vec3 aP; layout(location=2) in vec3 iC; layout(location=3) in vec3 iS;
uniform mat4 uLVP;
void main() { gl_Position = uLVP * vec4(iC + aP * iS, 1.0); }`;
const FS_DEPTH = `#version 300 es
precision mediump float;
void main() {}`;
const VS_GLOW = `#version 300 es
layout(location=0) in vec2 aQ;
layout(location=1) in vec4 iA; layout(location=2) in vec4 iB; layout(location=3) in vec2 iT;
uniform mat4 uVP; uniform vec3 uR; uniform vec3 uU;
out vec2 vQ; out vec4 vCol; out vec2 vT;
void main() {
  vec3 off = iT.x > 0.5 && iT.x < 1.5 ? (uR * aQ.x + uU * aQ.y) : vec3(aQ.x, 0.0, -aQ.y);
  vQ = aQ; vCol = iB; vT = iT;
  gl_Position = uVP * vec4(iA.xyz + off * iA.w, 1.0);
}`;
const FS_GLOW = `#version 300 es
precision highp float;
in vec2 vQ; in vec4 vCol; in vec2 vT;
uniform vec4 uMono;
out vec4 o;
void main() {
  float d = length(vQ), a;
  if (vT.x > 1.5) {
    if (d > 1.0 || d < 0.74) discard;
    float ang = atan(vQ.x, vQ.y) / 6.2831853 + 0.5;
    float on = step(1.0 - vT.y, ang);
    float edge = smoothstep(1.0, 0.94, d) * smoothstep(0.74, 0.8, d);
    a = edge * mix(0.28, 1.0, on);
  } else {
    float k = max(0.0, 1.0 - d * d);
    a = k * k;
  }
  vec3 c = vCol.rgb;
  float lum = dot(c, vec3(0.3, 0.59, 0.11));
  c = mix(c, lum * uMono.rgb * 1.25, uMono.a);
  a *= vCol.a;
  o = vec4(c * a, a);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

function cubeData() {
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const out = [];
  for (const [n, u, v] of faces) {
    const corner = (a, b) => [0, 1, 2].map((i) => n[i] * 0.5 + u[i] * a * 0.5 + v[i] * b * 0.5);
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) out.push(...corner(a, b), ...n);
  }
  return new Float32Array(out);
}

G.init = function (canvas) {
  cv = canvas;
  try {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) return false;
    progMain = program(VS_BOX, FS_BOX);
    progDepth = program(VS_DEPTH, FS_DEPTH);
    progGlow = program(VS_GLOW, FS_GLOW);
  } catch (e) { console.warn(e); return false; }

  vaoBox = gl.createVertexArray();
  gl.bindVertexArray(vaoBox);
  const cb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cb);
  gl.bufferData(gl.ARRAY_BUFFER, cubeData(), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
  [[2, 3, 0], [3, 3, 12], [4, 4, 24]].forEach(([loc, size, off]) => {
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, off); gl.vertexAttribDivisor(loc, 1);
  });

  vaoGlow = gl.createVertexArray();
  gl.bindVertexArray(vaoGlow);
  const qb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, qb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  glowBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf);
  gl.bufferData(gl.ARRAY_BUFFER, glowAdd.byteLength, gl.DYNAMIC_DRAW);
  [[1, 4, 0], [2, 4, 16], [3, 2, 32]].forEach(([loc, size, off]) => {
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, off); gl.vertexAttribDivisor(loc, 1);
  });
  gl.bindVertexArray(null);

  makeShadow(gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 4096 ? 2048 : 1024);
  return true;
};

function makeShadow(size) {
  try {
    SHADOW = size;
    if (shadowTex) gl.deleteTexture(shadowTex);
    if (shadowFbo) gl.deleteFramebuffer(shadowFbo);
    shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    shadowsOn = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  } catch { shadowsOn = false; }
}
G.lowerQuality = function () { if (SHADOW > 1024) makeShadow(1024); };

/* ---------- Maths ---------- */
function ortho(l, r, b, t, n, f) { return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]); }
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function lookAt(e, c, up) {
  const z = norm([e[0] - c[0], e[1] - c[1], e[2] - c[2]]), x = norm(cross(up, z)), y = cross(z, x);
  return { m: new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1]), x, y, z };
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

/* ---------- Building a frame ---------- */
function box(cx, cy, cz, sx, sy, sz, c, e) {
  if (nb >= MAXB) return;
  const o = nb++ * 10;
  inst[o] = cx; inst[o + 1] = cy; inst[o + 2] = cz; inst[o + 3] = sx; inst[o + 4] = sy; inst[o + 5] = sz;
  inst[o + 6] = c[0]; inst[o + 7] = c[1]; inst[o + 8] = c[2]; inst[o + 9] = e || 0;
}
// Glows: kind 0 lies on the ground, 1 faces the camera, 2 is the lollop ring (p = charge, 0 to 1)
function glow(x, y, z, rad, c, a, kind, p, mixed) {
  const arr = mixed ? glowMix : glowAdd;
  const n = mixed ? ngm : nga;
  if (n >= (mixed ? 400 : MAXG) || a <= 0.01) return;
  const o = n * 10;
  arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = rad;
  arr[o + 4] = c[0]; arr[o + 5] = c[1]; arr[o + 6] = c[2]; arr[o + 7] = a; arr[o + 8] = kind || 0; arr[o + 9] = p || 0;
  if (mixed) ngm++; else nga++;
}

// The current model: origin, quarter turns (0 faces +z, 1 faces +x, 2 faces -z, 3 faces -x) and scale
let MX = 0, MY = 0, MZ = 0, MK = 0, SX = 1, SY = 1, SZ = 1, DIM = 1;
function m(x, y, z, k, sx, sy, sz) { MX = x; MY = y; MZ = z; MK = ((k || 0) % 4 + 4) % 4; SX = sx || 1; SY = sy || 1; SZ = sz || 1; }
// A box in model space: centred on x and z, standing on y0
function b(x, y0, z, w, h, d, c, e) {
  x *= SX; z *= SZ; w *= SX; d *= SZ; const cy = (y0 + h / 2) * SY; h *= SY;
  let wx, wz, sw, sd;
  if (MK === 0) { wx = x; wz = z; sw = w; sd = d; }
  else if (MK === 1) { wx = z; wz = -x; sw = d; sd = w; }
  else if (MK === 2) { wx = -x; wz = -z; sw = w; sd = d; }
  else { wx = -z; wz = x; sw = d; sd = w; }
  box(MX + wx, MY + cy, MZ + wz, sw, h, sd, DIM === 1 ? c : shade(c, DIM), e);
}
// World position of a point in model space (for lights)
function mp(x, y, z) {
  x *= SX; z *= SZ;
  if (MK === 0) return [MX + x, MY + y * SY, MZ + z];
  if (MK === 1) return [MX + z, MY + y * SY, MZ - x];
  if (MK === 2) return [MX - x, MY + y * SY, MZ - z];
  return [MX - z, MY + y * SY, MZ + x];
}
const h01 = (a, b) => C.mix(a, b) / 4294967296;

/* ---------- Palette ---------- */
const P = {
  grassA: col('#A2DA5E'), grassB: col('#97D153'), dirt: col('#8B6A45'),
  paveA: col('#BFBAB0'), paveB: col('#B5B0A6'), kerb: col('#DEDAD2'),
  plazaA: col('#DADFEE'), plazaB: col('#CFD5E8'), gridDay: col('#B4BEDF'), neon: col('#58E8FF'), pink: col('#FF4FD8'),
  roadC: col('#5B5E66'), roadT: col('#474A52'), roadF: col('#1C2036'), line: col('#F4F4F0'), yellowLine: col('#F2C94C'),
  gravel: col('#8E857A'), gravelT: col('#7C7670'), sleeper: col('#5E4630'), steel: col('#C3C8D0'), railF: col('#22263C'),
  river: col('#58B9EC'), canal: col('#4C8E8C'), flux: col('#7A55F0'),
  trunk: col('#7A5230'), leaf: col('#57B947'), leaf2: col('#6CCB57'), leafD: col('#3F9A3B'), pine: col('#2F8A4A'), pine2: col('#3BA058'),
  hedge: col('#3E8E41'), hedge2: col('#4FA052'), rock: col('#A3A3A0'), rock2: col('#B9B9B4'), hay: col('#E7C24A'), hayD: col('#CDA735'),
  wool: col('#F6F5EE'), woolTop: col('#FFFFFF'), black: col('#2A2A2E'),
  lamp: col('#2E3B33'), bulb: col('#FFE6A3'), post: col('#D7262C'), postD: col('#B71E24'), slot: col('#1B1B1B'),
  bench: col('#9C6B3D'), metal: col('#3A3D44'), planter: col('#8C7E6F'), soil: col('#5B4634'), bin: col('#2F5E3A'), binD: col('#244A2D'), white: col('#F2F2EE'),
  pylon: col('#F4F6FB'), holo: col('#2EC4B6'), holoIn: col('#B3FFF2'), botBody: col('#F0F3F8'), visor: col('#1C1F2B'), crystal: col('#B26BFF'), crystal2: col('#E1A6FF'), domeW: col('#DCE6F5'),
  fox: col('#F07B2E'), foxD: col('#C85A1E'), foxW: col('#FFF4E4'), foxK: col('#2A1E1A'),
  tyre: col('#26262A'), glass: col('#3A4A5E'), glassD: col('#1E2433'), headlight: col('#FFF3C4'), tail: col('#E53935'), amber: col('#FFB547'), warm: col('#FFD27A'),
  cab: col('#1C1C21'), bus: col('#D8262E'), busD: col('#B11E25'), cream: col('#F1E6CF'), tractor: col('#D63B2B'), wood: col('#A0703F'),
  log: col('#8B5A2B'), logEnd: col('#D2A16A'), lily: col('#4CAF50'), lily2: col('#3E9142'), flower: col('#FF8FB1'),
  raft: col('#E8F1FF'), disc: col('#D9E4FF'),
  gull: col('#FAFAFA'), gullWing: col('#B0BEC5'), gullTip: col('#37474F'), beak: col('#F5C518'), feet: col('#FF9800'),
  tray: col('#E53935'), fry: col('#F7C948'),
  signal: col('#30333A'), red: col('#FF3B30'),
};
const CAR_COLS = ['#E94F4F', '#4F8FE9', '#F2C94C', '#6FCF97', '#F2994A', '#BB6BD9', '#F4F4F4', '#56CCF2', '#3D5A80'].map(col);
const HOVER_COLS = ['#F4F7FF', '#FF7AD9', '#7AF0FF', '#B9A4FF', '#FFE27A'].map(col);
const VAN_COLS = ['#F4F4F4', '#3E6FB0', '#2E7D4F', '#C9C9C9'].map(col);
const BOAT_COLS = ['#2E5E3E', '#7A2232', '#233A6B', '#2B4F55'].map(col);
const BRICK = ['#B5543C', '#C46A4A', '#D9B48F', '#ECE6DA', '#9AA7B3', '#A9473A'].map(col);
const TOWER = ['#2A2F48', '#33395A', '#252940', '#3B3260'].map(col);

/* ---------- Ground ---------- */
const TOP = { grass: 0, road: -0.06, rail: -0.02, water: -0.32 };
G.TOP = TOP;
const EDGE = C.HALF + 0.5, FAR = 22;
function strip(r, top, c, edgeDim) {
  const d = edgeDim == null ? 0.74 : edgeDim;
  const h = top + 1.2;
  box(0, top - h / 2, r, EDGE * 2, h, 1, c);
  const ec = shade(c, d), w = FAR - EDGE;
  box(-EDGE - w / 2, top - h / 2, r, w, h, 1, ec);
  box(EDGE + w / 2, top - h / 2, r, w, h, 1, ec);
}

function drawGround(W, Lr, t) {
  const r = Lr.r, z = Lr.zone, odd = (r & 1) === 1;
  if (Lr.type === 'grass') {
    const c = z === 'country' ? (odd ? P.grassA : P.grassB) : z === 'town' ? (odd ? P.paveA : P.paveB) : (odd ? P.plazaA : P.plazaB);
    strip(r, 0, c);
    if (z === 'town') {
      // paving joints
      for (let x = -EDGE + 1; x < EDGE; x += 1) box(x, 0.004, r, 0.03, 0.01, 1, shade(c, 0.92));
      const prev = C.row(W, r - 1), next = C.row(W, r + 1);
      if (prev.type === 'road') box(0, 0.01, r - 0.46, FAR * 2, 0.04, 0.08, P.kerb);
      if (next.type === 'road') box(0, 0.01, r + 0.46, FAR * 2, 0.04, 0.08, P.kerb);
    } else if (z === 'future') {
      const g = NIGHT > 0.3 ? P.neon : P.gridDay, ge = NIGHT > 0.3 ? 0.25 + 0.4 * NIGHT : 0;
      box(0, 0.002, r - 0.49, EDGE * 2, 0.01, 0.025, g, ge);
      for (let x = -EDGE; x <= EDGE + 0.01; x += 1) box(x, 0.002, r, 0.025, 0.01, 1, g, ge);
    }
  } else if (Lr.type === 'road') {
    const c = z === 'country' ? P.roadC : z === 'town' ? P.roadT : P.roadF;
    strip(r, TOP.road, c, 0.78);
    const next = C.row(W, r + 1);
    if (next.type === 'road') {
      const lc = z === 'future' ? P.neon : P.line;
      for (let x = -FAR + 0.5; x < FAR; x += 1.6) box(x, TOP.road + 0.005, r + 0.5, 0.7, 0.012, 0.07, lc, z === 'future' ? 0.6 + 0.4 * NIGHT : 0);
    }
    if (z === 'future') {
      const prev = C.row(W, r - 1);
      if (prev.type !== 'road') box(0, TOP.road + 0.005, r - 0.47, FAR * 2, 0.012, 0.04, P.pink, 0.8);
      if (next.type !== 'road') box(0, TOP.road + 0.005, r + 0.47, FAR * 2, 0.012, 0.04, P.pink, 0.8);
    }
  } else if (Lr.type === 'rail') {
    if (z === 'future') {
      strip(r, TOP.rail, P.railF, 0.85);
      box(0, TOP.rail + 0.04, r, FAR * 2, 0.08, 0.16, P.neon, 0.55 + 0.45 * NIGHT);
      box(0, TOP.rail + 0.01, r - 0.3, FAR * 2, 0.02, 0.05, P.pink, 0.6);
      box(0, TOP.rail + 0.01, r + 0.3, FAR * 2, 0.02, 0.05, P.pink, 0.6);
    } else {
      strip(r, TOP.rail, z === 'town' ? P.gravelT : P.gravel, 0.85);
      for (let x = -FAR + 0.25; x < FAR; x += 0.55) box(x, TOP.rail, r, 0.2, 0.05, 0.86, P.sleeper);
      box(0, TOP.rail + 0.05, r - 0.24, FAR * 2, 0.07, 0.07, P.steel);
      box(0, TOP.rail + 0.05, r + 0.24, FAR * 2, 0.07, 0.07, P.steel);
    }
    drawSignal(Lr, t);
  } else {
    const c = z === 'country' ? P.river : z === 'town' ? P.canal : P.flux;
    strip(r, TOP.water, c, 0.85);
    // drifting glints
    const sp = (Lr.speed || 0.5) * (Lr.dir || 1) * 0.5;
    for (let i = 0; i < 6; i++) {
      const gx = C.wrap(h01(Lr.seed, i) * 32 + sp * t);
      box(gx, TOP.water + 0.004, r - 0.3 + h01(Lr.seed, i + 9) * 0.6, 0.5 + h01(Lr.seed, i + 3) * 0.6, 0.01, 0.05, shade(c, 1.25), z === 'future' ? 0.7 : 0.2);
    }
    if (z === 'future') box(0, TOP.water + 0.002, r, EDGE * 2, 0.004, 0.96, c, 0.12 + 0.45 * NIGHT);
  }
}

function drawSignal(Lr, t) {
  const T = C.train(Lr, t);
  const flash = T.warn ? (Math.floor(t * 4) & 1) : -1;
  m(EDGE + 0.45, TOP.rail, Lr.r - 0.42, 0);
  if (Lr.zone === 'future') {
    b(0, 0, 0, 0.14, 1.1, 0.14, P.pylon);
    b(0, 1.0, 0, 0.3, 0.2, 0.2, P.visor);
    b(0, 1.05, 0.105, 0.22, 0.08, 0.01, T.warn ? P.pink : P.neon, 1);
    if (T.warn) glow(MX, 1.1, MZ, 0.9, P.pink, 0.35 + 0.4 * NIGHT, 1);
    return;
  }
  b(0, 0, 0, 0.12, 1.12, 0.12, P.signal);
  b(0, 0.98, 0, 0.42, 0.16, 0.12, P.signal);
  b(-0.12, 1.0, 0.065, 0.11, 0.11, 0.02, flash === 0 ? P.red : shade(P.red, 0.35), flash === 0 ? 1 : 0);
  b(0.12, 1.0, 0.065, 0.11, 0.11, 0.02, flash === 1 ? P.red : shade(P.red, 0.35), flash === 1 ? 1 : 0);
  b(0, 0.55, 0.065, 0.36, 0.08, 0.02, P.white);
  if (flash >= 0) glow(MX + (flash ? 0.12 : -0.12), 1.05, MZ + 0.1, 0.7, P.red, 0.5 + 0.4 * NIGHT, 1);
  // a barrier arm in town
  if (Lr.zone === 'town') {
    const down = T.warn ? 1 : 0;
    if (down) for (let i = 0; i < 6; i++) box(EDGE - 0.1 - i * 0.32, 0.55, Lr.r - 0.42, 0.32, 0.06, 0.06, i & 1 ? P.red : P.white);
    else box(EDGE + 0.45, 1.25, Lr.r - 0.42, 0.06, 0.5, 0.06, P.white);
  }
}

/* ---------- Things that stand on the ground ---------- */
function obstacle(kind, x, z, seed, t) {
  const v = h01(seed, x * 7 + 3);
  m(x, 0, z, 0);
  switch (kind) {
    case 'tree': {
      const tall = v > 0.5;
      b(0, 0, 0, 0.22, 0.4, 0.22, P.trunk);
      b(0, 0.4, 0, 0.8, tall ? 0.9 : 0.58, 0.8, v > 0.25 ? P.leaf : P.leafD);
      b(0, tall ? 1.3 : 0.98, 0, 0.56, 0.3, 0.56, P.leaf2);
      break;
    }
    case 'pine':
      b(0, 0, 0, 0.18, 0.3, 0.18, P.trunk);
      b(0, 0.3, 0, 0.82, 0.36, 0.82, P.pine); b(0, 0.66, 0, 0.62, 0.36, 0.62, P.pine2);
      b(0, 1.02, 0, 0.42, 0.34, 0.42, P.pine); b(0, 1.36, 0, 0.18, 0.2, 0.18, P.pine2);
      break;
    case 'hedge':
      b(0, 0, 0, 0.94, 0.56, 0.84, P.hedge); b(0, 0.56, 0, 0.86, 0.1, 0.76, P.hedge2);
      if (v > 0.6) { b(0.2, 0.66, 0.1, 0.08, 0.06, 0.08, P.flower); b(-0.22, 0.66, -0.15, 0.08, 0.06, 0.08, P.white); }
      break;
    case 'rock':
      b(0.02, 0, 0, 0.66, 0.34, 0.6, P.rock); b(-0.08, 0.34, -0.04, 0.4, 0.18, 0.36, P.rock2);
      break;
    case 'hay':
      b(0, 0, 0, 0.8, 0.62, 0.8, P.hay); b(0, 0.14, 0, 0.82, 0.06, 0.82, P.hayD); b(0, 0.44, 0, 0.82, 0.06, 0.82, P.hayD);
      break;
    case 'sheep': {
      m(x, 0, z, Math.floor(v * 4));
      for (const [lx, lz] of [[-0.15, -0.18], [0.15, -0.18], [-0.15, 0.18], [0.15, 0.18]]) b(lx, 0, lz, 0.09, 0.2, 0.09, P.black);
      b(0, 0.18, 0, 0.54, 0.36, 0.62, P.wool); b(0, 0.54, -0.02, 0.42, 0.08, 0.48, P.woolTop);
      const nod = Math.sin(t * 1.3 + v * 9) > 0.7 ? -0.06 : 0;
      b(0, 0.3 + nod, 0.38, 0.24, 0.24, 0.2, P.black);
      b(-0.15, 0.44 + nod, 0.36, 0.08, 0.05, 0.1, P.black); b(0.15, 0.44 + nod, 0.36, 0.08, 0.05, 0.1, P.black);
      b(-0.06, 0.44 + nod, 0.48, 0.04, 0.04, 0.01, P.white); b(0.06, 0.44 + nod, 0.48, 0.04, 0.04, 0.01, P.white);
      break;
    }
    case 'lamp': {
      b(0, 0, 0, 0.22, 0.12, 0.22, P.lamp); b(0, 0.12, 0, 0.09, 1.46, 0.09, P.lamp);
      b(0, 1.52, 0.12, 0.07, 0.06, 0.3, P.lamp); b(0, 1.42, 0.28, 0.24, 0.12, 0.24, P.lamp);
      b(0, 1.34, 0.28, 0.17, 0.08, 0.17, P.bulb, 0.25 + NIGHT);
      if (NIGHT > 0) { const q = mp(0, 1.3, 0.28); glow(q[0], 0.03, q[2], 1.9, P.warm, 0.42 * NIGHT, 0); glow(q[0], q[1], q[2], 0.55, P.warm, 0.5 * NIGHT, 1); }
      break;
    }
    case 'postbox':
      b(0, 0, 0, 0.42, 0.08, 0.42, P.slot); b(0, 0.08, 0, 0.36, 0.7, 0.36, P.post);
      b(0, 0.78, 0, 0.44, 0.1, 0.44, P.postD); b(0, 0.88, 0, 0.3, 0.06, 0.3, P.postD);
      b(0, 0.58, 0.18, 0.2, 0.04, 0.02, P.slot);
      break;
    case 'bollard':
      b(0, 0, 0, 0.18, 0.52, 0.18, P.black); b(0, 0.36, 0, 0.2, 0.07, 0.2, P.white);
      break;
    case 'bench':
      b(-0.33, 0, 0, 0.06, 0.24, 0.36, P.metal); b(0.33, 0, 0, 0.06, 0.24, 0.36, P.metal);
      b(0, 0.24, 0.02, 0.86, 0.06, 0.34, P.bench); b(0, 0.3, -0.16, 0.86, 0.24, 0.05, P.bench);
      break;
    case 'planter':
      b(0, 0, 0, 0.74, 0.34, 0.74, P.planter); b(0, 0.34, 0, 0.66, 0.02, 0.66, P.soil);
      b(0, 0.34, 0, 0.1, 0.3, 0.1, P.trunk); b(0, 0.6, 0, 0.5, 0.42, 0.5, P.leaf);
      break;
    case 'bin':
      b(0, 0, 0, 0.38, 0.6, 0.38, P.bin); b(0, 0.6, 0, 0.42, 0.06, 0.42, P.binD);
      break;
    case 'pylon':
      b(0, 0, 0, 0.3, 1.6, 0.3, P.pylon); b(0, 1.15, 0, 0.32, 0.12, 0.32, P.neon, 1); b(0, 1.6, 0, 0.14, 0.14, 0.14, P.pink, 1);
      glow(MX, 1.67, MZ, 0.45, P.pink, 0.3 + 0.5 * NIGHT, 1);
      break;
    case 'holotree':
      b(0, 0, 0, 0.14, 0.4, 0.14, P.pylon); b(0, 0.4, 0, 0.72, 0.68, 0.72, P.holo, 0.12 + 0.4 * NIGHT);
      b(0, 0.58, 0, 0.42, 0.42, 0.42, P.holoIn, 0.3 + 0.5 * NIGHT);
      if (NIGHT > 0) glow(MX, 0.03, MZ, 1.1, P.holo, 0.35 * NIGHT, 0);
      break;
    case 'bot': {
      m(x, 0, z, Math.floor(v * 4) & 1 ? 2 : 0);
      b(0, 0, 0, 0.44, 0.12, 0.44, P.metal); b(0, 0.12, 0, 0.42, 0.42, 0.36, P.botBody);
      b(0, 0.32, 0.18, 0.3, 0.12, 0.01, P.visor);
      const blink = Math.sin(t * 2 + v * 20) > 0.95 ? 0.01 : 0.05;
      b(0, 0.35, 0.186, 0.16, blink, 0.01, P.neon, 1);
      b(0.12, 0.54, 0, 0.03, 0.18, 0.03, P.rock); b(0.12, 0.72, 0, 0.06, 0.06, 0.06, P.pink, 1);
      break;
    }
    case 'crystal':
      b(0, 0, 0, 0.5, 0.12, 0.5, P.plazaA); b(0, 0.12, 0, 0.32, 0.7, 0.32, P.crystal, 0.45); b(0.14, 0.12, 0.1, 0.18, 0.42, 0.18, P.crystal2, 0.5);
      if (NIGHT > 0) glow(MX, 0.03, MZ, 0.9, P.crystal, 0.35 * NIGHT, 0);
      break;
    case 'dome':
      b(0, 0, 0, 0.8, 0.3, 0.8, P.domeW); b(0, 0.3, 0, 0.6, 0.18, 0.6, P.domeW); b(0, 0.48, 0, 0.36, 0.12, 0.36, P.neon, 0.6);
      break;
  }
}

/* Scenery beyond the edges: woods in the country, terraces on the high street, towers in the future */
function scenery(Lr, t) {
  if (Lr.type !== 'grass' || Lr.r < -9) return;
  const z = Lr.zone, r = Lr.r, s = Lr.seed;
  for (const side of [-1, 1]) {
    if (z === 'country') {
      for (let i = 0; i < 6; i++) {
        const x = side * (EDGE + 0.6 + i * 1.7 + h01(s, side * 10 + i) * 0.8);
        if (h01(s, side * 20 + i) < 0.55) obstacle(h01(s, side * 30 + i) < 0.7 ? 'tree' : 'pine', x, r + (h01(s, i + 40) - 0.5) * 0.3, s, t);
        else if (h01(s, side * 50 + i) < 0.25) obstacle('hedge', x, r, s, t);
      }
    } else if (z === 'town') {
      const hs = C.mix(s, side), storeys = 2 + (hs % 3 === 0 ? 1 : 0), h = storeys * 0.9;
      const brick = BRICK[hs % BRICK.length], x0 = side * (EDGE + 0.55), depth = 3.4, cx = x0 + side * depth / 2;
      box(cx, h / 2, r, depth, h, 1.0, brick);
      box(cx, h + 0.06, r, depth + 0.1, 0.12, 1.02, shade(brick, 0.8));
      box(cx + side * 0.4, h + 0.32, r, depth - 1.2, 0.42, 0.98, col('#4A4F57'));
      if (hs % 4 === 1) box(cx + side * 0.9, h + 0.7, r + 0.25, 0.3, 0.5, 0.3, shade(brick, 0.85));
      const face = x0 - side * 0.01;
      for (let f = 0; f < storeys; f++) {
        const lit = NIGHT > 0 && (C.mix(hs, f) % 3 !== 0);
        const door = f === 0 && (hs % 2 === 0);
        if (door) { box(face, 0.36, r + 0.1, 0.06, 0.72, 0.36, BRICK[(hs >>> 3) % BRICK.length] === brick ? col('#2E4A7A') : col('#1E5C3A')); continue; }
        box(face, f * 0.9 + 0.5, r, 0.05, 0.5, 0.48, P.white);
        box(face - side * 0.012, f * 0.9 + 0.5, r, 0.05, 0.42, 0.38, lit ? P.warm : P.glass, lit ? 0.8 * NIGHT : 0);
        if (lit && side === -1) glow(face - side * 0.3, f * 0.9 + 0.55, r, 0.5, P.warm, 0.18 * NIGHT, 1);
      }
      // a second row of rooftops further out
      box(side * (EDGE + 5.5), 1.2, r, 3, 2.4 + (hs % 5) * 0.3, 1, shade(BRICK[(hs >>> 5) % BRICK.length], 0.85));
    } else {
      const hs = C.mix(s, side * 3);
      if (hs % 3 !== 0) {
        const hgt = 1.6 + (hs % 7) * 0.55, x = side * (EDGE + 1.2 + (hs >>> 4) % 3 * 0.6), c = TOWER[hs % TOWER.length];
        box(x, hgt / 2, r, 1.3, hgt, 0.9, c);
        for (let y = 0.5; y < hgt - 0.2; y += 0.55) box(x - side * 0.66, y, r, 0.02, 0.12, 0.7, (hs >>> 7) % 2 ? P.neon : P.pink, 0.55 + 0.45 * NIGHT);
        box(x, hgt + 0.06, r, 0.2, 0.12, 0.2, P.pink, 1);
      } else obstacle('holotree', side * (EDGE + 1.4), r, s, t);
      const hs2 = C.mix(s, side * 9), hgt2 = 2.5 + (hs2 % 9) * 0.6, x2 = side * (EDGE + 4.5);
      box(x2, hgt2 / 2, r, 2.2, hgt2, 1, shade(TOWER[hs2 % TOWER.length], 0.9));
      if (hs2 % 2) box(x2 - side * 1.11, hgt2 * 0.6, r, 0.02, hgt2 * 0.5, 0.15, P.neon, 0.7);
    }
  }
}

/* ---------- Vehicles ---------- */
function lights(L) {
  // headlights and tail lights; at night, a pool of light ahead
  b(-0.22, 0.2, L / 2, 0.14, 0.08, 0.02, P.headlight, 0.35 + NIGHT);
  b(0.22, 0.2, L / 2, 0.14, 0.08, 0.02, P.headlight, 0.35 + NIGHT);
  b(-0.24, 0.22, -L / 2, 0.12, 0.07, 0.02, P.tail, 0.3 + NIGHT * 0.7);
  b(0.24, 0.22, -L / 2, 0.12, 0.07, 0.02, P.tail, 0.3 + NIGHT * 0.7);
  if (NIGHT > 0) { const q = mp(0, 0, L / 2 + 1.1); glow(q[0], TOP.road + 0.03, q[2], 1.25, P.headlight, 0.38 * NIGHT, 0); }
}
function wheels(L, w, back) {
  const zf = L / 2 - 0.22, zb = -(back != null ? back : L / 2 - 0.22);
  for (const zz of [zf, zb]) { b(-w, 0, zz, 0.1, 0.2, 0.22, P.tyre); b(w, 0, zz, 0.1, 0.2, 0.22, P.tyre); }
}
function vehicle(kind, x, r, dir, len, seed, t) {
  const k = dir > 0 ? 1 : 3, y = TOP.road, L = len - 0.1, v = h01(seed, 1);
  m(x, y, r, k);
  switch (kind) {
    case 'car': {
      const c = CAR_COLS[Math.floor(v * CAR_COLS.length)];
      wheels(L, 0.31);
      b(0, 0.1, 0, 0.66, 0.28, L, c);
      b(0, 0.38, -0.06, 0.56, 0.2, L * 0.52, P.glass);
      b(0, 0.58, -0.06, 0.58, 0.06, L * 0.56, c);
      lights(L);
      break;
    }
    case 'cab':
      wheels(L, 0.31);
      b(0, 0.1, 0, 0.68, 0.3, L, P.cab);
      b(0, 0.4, -0.04, 0.6, 0.28, L * 0.6, P.glassD);
      b(0, 0.68, -0.04, 0.62, 0.06, L * 0.64, P.cab);
      b(0, 0.74, 0.08, 0.2, 0.07, 0.1, P.amber, 0.45 + NIGHT * 0.6);
      b(0, 0.3, L / 2 - 0.01, 0.34, 0.12, 0.02, col('#9EA3AA'));
      lights(L);
      break;
    case 'bus':
      wheels(L, 0.36, L / 2 - 0.5);
      b(0, 0.12, 0, 0.8, 0.6, L, P.bus);
      b(0, 0.48, 0.05, 0.82, 0.18, L - 0.5, NIGHT > 0 ? P.warm : P.glass, NIGHT * 0.7);
      b(0, 0.72, 0, 0.82, 0.05, L, P.cream);
      b(0, 0.77, 0, 0.8, 0.56, L - 0.08, P.bus);
      b(0, 0.98, 0, 0.82, 0.2, L - 0.3, NIGHT > 0 ? P.warm : P.glass, NIGHT * 0.7);
      b(0, 1.33, 0, 0.74, 0.05, L - 0.16, P.busD);
      b(0, 0.32, L / 2 - 0.01, 0.6, 0.3, 0.02, P.glass);
      b(0, 1.16, L / 2 - 0.02, 0.5, 0.1, 0.02, P.amber, 0.6 + NIGHT * 0.4);
      lights(L);
      break;
    case 'van': {
      const c = VAN_COLS[Math.floor(v * VAN_COLS.length)];
      wheels(L, 0.32);
      b(0, 0.1, -0.15, 0.72, 0.72, L - 0.3, c);
      b(0, 0.1, L / 2 - 0.2, 0.7, 0.4, 0.4, c);
      b(0, 0.5, L / 2 - 0.34, 0.64, 0.24, 0.2, P.glass);
      lights(L);
      break;
    }
    case 'tractor':
      b(-0.36, 0, -0.25, 0.16, 0.5, 0.48, P.tyre); b(0.36, 0, -0.25, 0.16, 0.5, 0.48, P.tyre);
      b(-0.3, 0, 0.42, 0.12, 0.26, 0.26, P.tyre); b(0.3, 0, 0.42, 0.12, 0.26, 0.26, P.tyre);
      b(0, 0.22, 0.2, 0.4, 0.28, 0.8, P.tractor);
      b(0, 0.24, -0.25, 0.56, 0.24, 0.46, P.tractor);
      b(0, 0.48, -0.25, 0.5, 0.4, 0.42, P.glass);
      b(0, 0.88, -0.25, 0.58, 0.05, 0.5, P.tractor);
      b(0.12, 0.5, 0.42, 0.05, 0.28, 0.05, P.black);
      b(0, 0.32, 0.6, 0.3, 0.1, 0.02, P.headlight, 0.3 + NIGHT);
      if (NIGHT > 0) { const q = mp(0, 0, 1.5); glow(q[0], TOP.road + 0.03, q[2], 1.0, P.headlight, 0.32 * NIGHT, 0); }
      break;
    case 'lorry':
      wheels(L, 0.34);
      b(0, 0.1, L / 2 - 0.32, 0.76, 0.66, 0.6, col('#3F6FB5'));
      b(0, 0.46, L / 2 - 0.02, 0.66, 0.24, 0.02, P.glass);
      b(0, 0.22, -0.32, 0.78, 0.12, L - 0.68, P.wood);
      for (let i = 0; i < 3; i++) b(0, 0.34, -0.32 - (L - 0.9) / 2 + 0.28 + i * ((L - 0.9) / 3), 0.68, 0.36, (L - 0.9) / 3 - 0.06, P.hay);
      lights(L);
      break;
    case 'hover': case 'pod': {
      const c = HOVER_COLS[Math.floor(v * HOVER_COLS.length)], bob = Math.sin(t * 3 + v * 10) * 0.03;
      const w = kind === 'pod' ? 0.5 : 0.66, hh = kind === 'pod' ? 0.3 : 0.22;
      b(0, 0.3 + bob, 0, w, hh, L, c);
      b(0, 0.3 + hh + bob, -0.05, w - 0.16, 0.18, L * 0.5, P.glassD);
      b(0, 0.24 + bob, 0, w - 0.14, 0.04, L * 0.8, P.neon, 1);
      b(0, 0.36 + bob, L / 2, w - 0.2, 0.06, 0.02, P.headlight, 0.5 + NIGHT);
      b(0, 0.36 + bob, -L / 2, w - 0.2, 0.05, 0.02, P.pink, 1);
      glow(MX, TOP.road + 0.03, MZ, 0.75, P.neon, 0.25 + 0.4 * NIGHT, 0);
      if (NIGHT > 0) { const q = mp(0, 0, L / 2 + 1); glow(q[0], TOP.road + 0.03, q[2], 1.1, P.headlight, 0.3 * NIGHT, 0); }
      break;
    }
    case 'hoverbus': {
      const bob = Math.sin(t * 2.4 + v * 10) * 0.025;
      b(0, 0.28 + bob, 0, 0.8, 0.62, L, P.raft);
      b(0, 0.6 + bob, 0, 0.82, 0.2, L - 0.4, P.glassD);
      b(0, 0.62 + bob, 0, 0.83, 0.04, L - 0.5, P.neon, 1);
      b(0, 0.4 + bob, 0, 0.82, 0.05, L, P.pink, 1);
      b(0, 0.22 + bob, 0, 0.6, 0.04, L * 0.85, P.neon, 1);
      glow(MX, TOP.road + 0.03, MZ, 1.3, P.neon, 0.25 + 0.4 * NIGHT, 0);
      break;
    }
  }
}

function drawTrain(Lr, t) {
  const T = C.train(Lr, t);
  if (!T.on) return;
  const R = Lr.rail, dir = R.dir, k = dir > 0 ? 1 : 3, fut = Lr.zone === 'future';
  const body = fut ? P.raft : Lr.zone === 'country' ? col('#2E6B3F') : col('#ECEFF1');
  const stripe = fut ? P.neon : Lr.zone === 'country' ? P.cream : col('#2F5DA8');
  for (let i = 0; i < R.cars; i++) {
    const cx = T.front - dir * (i * 3.2 + 1.6);
    if (Math.abs(cx) > FAR + 2) continue;
    m(cx, TOP.rail, Lr.r, k);
    const lift = fut ? 0.16 : 0;
    if (!fut) { b(-0.3, 0, 1.0, 0.12, 0.16, 0.4, P.tyre); b(0.3, 0, 1.0, 0.12, 0.16, 0.4, P.tyre); b(-0.3, 0, -1.0, 0.12, 0.16, 0.4, P.tyre); b(0.3, 0, -1.0, 0.12, 0.16, 0.4, P.tyre); }
    b(0, 0.12 + lift, 0, 0.88, 0.86, 3.0, body);
    b(0, 0.52 + lift, 0, 0.9, 0.24, 2.7, NIGHT > 0 ? P.warm : P.glass, NIGHT * 0.75);
    b(0, 0.32 + lift, 0, 0.9, 0.08, 3.0, stripe, fut ? 1 : 0);
    b(0, 0.98 + lift, 0, 0.8, 0.07, 2.9, fut ? P.domeW : col('#9AA1A8'));
    if (fut) b(0, 0.06, 0, 0.5, 0.05, 2.6, P.neon, 1);
    if (i === 0) {
      if (fut) { b(0, 0.12 + lift, 1.6, 0.8, 0.6, 0.3, body); b(0, 0.12 + lift, 1.85, 0.6, 0.36, 0.25, body); b(0, 0.5, 1.72, 0.7, 0.14, 0.04, P.neon, 1); }
      else b(0, 0.12, 1.5, 0.88, 0.62, 0.06, col('#F2C230'));
      b(-0.26, 0.26 + lift, 1.56 + (fut ? 0.4 : 0), 0.14, 0.1, 0.04, P.headlight, 1);
      b(0.26, 0.26 + lift, 1.56 + (fut ? 0.4 : 0), 0.14, 0.1, 0.04, P.headlight, 1);
      const q = mp(0, 0, 3.4);
      glow(q[0], TOP.rail + 0.04, q[2], 2.0, P.headlight, 0.2 + 0.4 * NIGHT, 0);
    }
    if (NIGHT > 0) glow(MX, 0.6, MZ, 1.8, P.warm, 0.12 * NIGHT, 1);
    if (fut) glow(MX, TOP.rail + 0.03, MZ, 1.8, P.neon, 0.25 + 0.3 * NIGHT, 0);
  }
}

/* ---------- On the water ---------- */
const BOAT_TOP = { log: 0.06, narrowboat: 0.36, raft: -0.1 };
G.BOAT_TOP = BOAT_TOP;
G.PAD_TOP = -0.25;
function boat(o, x, r, dir, seed, i, t) {
  const len = o.len;
  if (o.kind === 'log') {
    const bob = Math.sin(t * 2 + i) * 0.015;
    box(x, -0.17 + bob, r, len, 0.42, 0.7, P.log);
    box(x - len / 2 + 0.03, -0.17 + bob, r, 0.07, 0.36, 0.6, P.logEnd);
    box(x + len / 2 - 0.03, -0.17 + bob, r, 0.07, 0.36, 0.6, P.logEnd);
    box(x + len * 0.15, 0.045 + bob, r + 0.1, 0.4, 0.03, 0.08, shade(P.log, 0.8));
  } else if (o.kind === 'narrowboat') {
    const c = BOAT_COLS[C.mix(seed, i) % BOAT_COLS.length], hl = len - 0.1;
    m(x, -0.42, r, dir > 0 ? 1 : 3);
    b(0, 0, 0, 0.8, 0.4, hl, c);
    b(0, 0.4, 0, 0.82, 0.05, hl, col('#E8C547'));
    b(0, 0.4, -0.06, 0.64, 0.34, hl - 0.6, P.cream);
    b(0, 0.74, -0.06, 0.68, 0.04, hl - 0.5, c);
    for (let w = -hl / 2 + 0.55; w < hl / 2 - 0.6; w += 0.55) {
      b(0.325, 0.5, w, 0.02, 0.14, 0.2, NIGHT > 0 ? P.warm : P.glass, NIGHT * 0.8);
      b(-0.325, 0.5, w, 0.02, 0.14, 0.2, NIGHT > 0 ? P.warm : P.glass, NIGHT * 0.8);
    }
    b(0.12, 0.78, hl / 2 - 0.55, 0.08, 0.18, 0.08, P.black);
    b(-0.18, 0.78, -hl / 2 + 0.6, 0.14, 0.08, 0.14, col('#C0392B')); b(-0.18, 0.86, -hl / 2 + 0.6, 0.16, 0.06, 0.16, P.flower);
    b(0.16, 0.78, -hl / 2 + 0.9, 0.14, 0.08, 0.14, col('#2E7D32')); b(0.16, 0.86, -hl / 2 + 0.9, 0.16, 0.06, 0.16, P.fry);
    b(0, 0.4, hl / 2 - 0.12, 0.5, 0.1, 0.14, c);
  } else {
    const bob = Math.sin(t * 2.2 + i) * 0.02;
    box(x, -0.2 + bob, r, len, 0.2, 0.82, P.raft);
    box(x, -0.22 + bob, r, len + 0.04, 0.05, 0.86, P.neon, 1);
    box(x, -0.095 + bob, r, len - 0.3, 0.01, 0.5, P.gridDay);
    glow(x, TOP.water + 0.02, r, len * 0.55, P.neon, 0.3 + 0.35 * NIGHT, 0);
  }
}
function pad(x, r, zone, seed, t) {
  if (zone === 'future') {
    const bob = Math.sin(t * 2 + x) * 0.02;
    box(x, -0.3 + bob, r, 0.78, 0.08, 0.78, P.disc);
    box(x, -0.255 + bob, r, 0.5, 0.01, 0.5, P.neon, 0.8);
    glow(x, TOP.water + 0.02, r, 0.7, P.neon, 0.3 + 0.3 * NIGHT, 0);
    return;
  }
  box(x, -0.3, r, 0.8, 0.05, 0.8, P.lily);
  box(x + 0.2, -0.27, r + 0.2, 0.22, 0.01, 0.22, P.lily2);
  if (h01(seed, x) > 0.6) { box(x - 0.18, -0.25, r - 0.15, 0.12, 0.08, 0.12, P.flower); box(x - 0.18, -0.21, r - 0.15, 0.05, 0.04, 0.05, P.fry); }
}

/* ---------- The fox ---------- */
function fox(F, t) {
  m(F.x, F.y, F.z, F.k, 1.22 * (F.sx || 1), 1.22 * (F.sy || 1), 1.22 * (F.sz || 1));
  const step = F.leg || 0;
  for (const [lx, lz, s] of [[-0.12, 0.14, 1], [0.12, 0.14, -1], [-0.12, -0.16, -1], [0.12, -0.16, 1]]) b(lx, 0, lz + s * step * 0.05, 0.1, 0.16, 0.1, P.foxK);
  b(0, 0.14, -0.03, 0.38, 0.27, 0.5, P.fox);
  b(0, 0.14, 0.2, 0.26, 0.2, 0.08, P.foxW);
  b(0, 0.34, 0.18, 0.36, 0.28, 0.3, P.fox);
  b(0, 0.34, 0.36, 0.22, 0.12, 0.14, P.foxW);
  b(-0.13, 0.36, 0.25, 0.1, 0.14, 0.2, P.foxW); b(0.13, 0.36, 0.25, 0.1, 0.14, 0.2, P.foxW);
  b(0, 0.43, 0.44, 0.08, 0.06, 0.04, P.foxK);
  const blink = (Math.sin(t * 1.7) > 0.985) ? 0.015 : 0.06;
  b(-0.09, 0.49 - blink / 2 + 0.03, 0.335, 0.06, blink, 0.02, P.foxK); b(0.09, 0.49 - blink / 2 + 0.03, 0.335, 0.06, blink, 0.02, P.foxK);
  b(-0.11, 0.62, 0.17, 0.1, 0.12, 0.07, P.fox); b(0.11, 0.62, 0.17, 0.1, 0.12, 0.07, P.fox);
  b(-0.11, 0.73, 0.17, 0.1, 0.05, 0.07, P.foxK); b(0.11, 0.73, 0.17, 0.1, 0.05, 0.07, P.foxK);
  const sway = Math.sin(t * 4) * 0.025 + (F.tail || 0);
  b(sway * 0.5, 0.22, -0.34, 0.17, 0.15, 0.2, P.fox);
  b(sway, 0.28, -0.5, 0.2, 0.18, 0.14, P.fox);
  b(sway * 1.4, 0.32, -0.6, 0.16, 0.14, 0.08, P.foxW);
}

function gull(Q, t) {
  const flap = Math.sin(t * (Q.flap || 14)) * 0.14;
  m(Q.x, Q.y, Q.z, Q.face == null ? 2 : Q.face, 1.15, 1.15, 1.15);
  b(0, 0, 0, 0.3, 0.26, 0.56, P.gull);
  b(0, 0.16, 0.3, 0.22, 0.2, 0.2, P.gull);
  b(0, 0.18, 0.44, 0.07, 0.06, 0.14, P.beak); b(0, 0.15, 0.5, 0.05, 0.03, 0.03, P.red);
  b(-0.11, 0.26, 0.36, 0.02, 0.04, 0.04, P.foxK); b(0.11, 0.26, 0.36, 0.02, 0.04, 0.04, P.foxK);
  b(-0.42, 0.12 + flap, 0, 0.56, 0.05, 0.36, P.gullWing); b(0.42, 0.12 + flap, 0, 0.56, 0.05, 0.36, P.gullWing);
  b(-0.78, 0.12 + flap * 1.7, -0.02, 0.2, 0.05, 0.3, P.gullTip); b(0.78, 0.12 + flap * 1.7, -0.02, 0.2, 0.05, 0.3, P.gullTip);
  b(0, 0.06, -0.38, 0.2, 0.06, 0.16, P.gullWing);
  b(-0.08, -0.14, 0.05, 0.06, 0.14, 0.06, P.feet); b(0.08, -0.14, 0.05, 0.06, 0.14, 0.06, P.feet);
}

function chip(x, r, t) {
  const bob = 0.12 + Math.sin(t * 3 + x * 1.7 + r) * 0.05;
  m(x, bob, r, (Math.floor(t * 1.2 + r) & 1));
  b(0, 0, 0, 0.34, 0.14, 0.22, P.tray); b(0, 0.06, 0, 0.35, 0.03, 0.23, P.white);
  for (let i = 0; i < 4; i++) b(-0.1 + i * 0.065, 0.12, (i & 1 ? 0.03 : -0.03), 0.045, 0.2 + (i % 3) * 0.04, 0.045, P.fry);
  glow(x, 0.02, r, 0.45, P.fry, 0.15 + 0.35 * NIGHT, 0);
}

/* ---------- Camera ---------- */
const YAW = 0.3, PITCH = 0.98, DIST = 40;
let VP, LVP, camR, camU, halfW = 4.9, halfH = 9, aspect = 0.5;
G.resize = function (w, h, dpr) {
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  aspect = w / h;
  halfW = 4.4; halfH = halfW / aspect;
  if (halfH < 6.6) { halfH = 6.6; halfW = halfH * aspect; }
};
// Screen position (0 to 1, top left origin) of a world point, used to place labels
G.project = function (x, y, z) {
  if (!VP) return null;
  const v = [x, y, z, 1], o = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) o[r] = VP[r] * v[0] + VP[4 + r] * v[1] + VP[8 + r] * v[2] + VP[12 + r] * v[3];
  return { x: (o[0] / o[3]) * 0.5 + 0.5, y: 1 - ((o[1] / o[3]) * 0.5 + 0.5) };
};
// Rows the camera can see, given where it is looking
const ahead = () => halfH / Math.sin(PITCH) * 0.4;
G.rowsInView = function (camZ) {
  const c = camZ + ahead(), d = halfH / Math.sin(PITCH), side = halfW * Math.sin(YAW);
  return [Math.floor(c - d - side - 2), Math.ceil(c + d + side + 3)];
};

/* ---------- Theme ---------- */
G.setTheme = function (id) { L = LIGHT[id] || LIGHT.day; NIGHT = L.night; };
G.night = () => NIGHT;
G.clearColour = () => L.clear;

/* ---------- One frame ---------- */
G.render = function (S) {
  nb = 0; nga = 0; ngm = 0;
  const W = S.W, t = S.t, now = S.now;
  // camera: looks at a point ahead of the fox so the fox sits in the lower part of the screen
  const tx = S.cam.x * 0.45 + (S.shake ? S.shake[0] : 0), tz = S.cam.z + ahead() + (S.shake ? S.shake[1] : 0);
  const eye = [tx + Math.sin(YAW) * Math.cos(PITCH) * DIST, Math.sin(PITCH) * DIST, tz - Math.cos(YAW) * Math.cos(PITCH) * DIST];
  const view = lookAt(eye, [tx, 0, tz], [0, 1, 0]);
  VP = mul(ortho(-halfW, halfW, -halfH, halfH, 1, DIST * 2.4), view.m);
  camR = view.x; camU = view.y;
  const sd = norm(L.dir);
  const lc = [tx, 0, tz + 1], le = [lc[0] + sd[0] * 30, lc[1] + sd[1] * 30, lc[2] + sd[2] * 30];
  const lview = lookAt(le, lc, [0, 0, 1]);
  const ext = Math.max(halfW, halfH) * 1.25 + 2;
  LVP = mul(ortho(-ext, ext, -ext, ext, 1, 70), lview.m);

  const [r0, r1] = G.rowsInView(S.cam.z);
  for (let r = r1; r >= Math.max(r0, -9); r--) {
    const Lr = C.row(W, r);
    drawGround(W, Lr, t);
    if (Lr.type === 'grass') {
      for (let c = -C.HALF; c <= C.HALF; c++) {
        const k = Lr.obs[c + C.HALF];
        if (k) obstacle(k, c, r, Lr.seed, now);
      }
      scenery(Lr, now);
      for (const c of Lr.chips) if (!S.taken.has(r + ':' + c)) chip(c, r, now);
    } else if (Lr.type === 'road') {
      for (let i = 0; i < Lr.objs.length; i++) {
        const x = C.objX(Lr, i, t);
        if (Math.abs(x) < FAR) vehicle(Lr.objs[i].kind, x, r, Lr.dir, Lr.objs[i].len, C.mix(Lr.seed, i), now);
      }
      for (const c of Lr.chips) if (!S.taken.has(r + ':' + c)) chip(c, r, now);
    } else if (Lr.type === 'rail') {
      drawTrain(Lr, t);
    } else if (Lr.sub === 'pads') {
      for (const c of Lr.pads) pad(c, r, Lr.zone, Lr.seed, now);
    } else {
      for (let i = 0; i < Lr.objs.length; i++) {
        const x = C.objX(Lr, i, t);
        if (Math.abs(x) < FAR + 2) boat(Lr.objs[i], x, r, Lr.dir, Lr.seed, i, now);
      }
    }
  }
  if (S.fox && !S.fox.hidden) fox(S.fox, now);
  if (S.ring) glow(S.fox.x, S.fox.ringY + 0.02, S.fox.z, 0.62, S.ring.full ? P.fry : P.white, S.ring.full ? 0.95 : 0.6, 2, S.ring.p, true);
  if (S.gull) gull(S.gull, now);
  for (const p of S.parts) box(p.x, p.y, p.z, p.s, p.s, p.s, p.c, p.e || 0);

  // upload and draw
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, nb * 10);
  gl.bindVertexArray(vaoBox);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  if (shadowsOn) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, SHADOW, SHADOW);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(progDepth.p);
    gl.uniformMatrix4fv(progDepth.u.uLVP, false, LVP);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2.0, 3.0);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, nb);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  gl.viewport(0, 0, cv.width, cv.height);
  const cc = col(L.clear);
  gl.clearColor(cc[0], cc[1], cc[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  const u = progMain.u;
  gl.useProgram(progMain.p);
  gl.uniformMatrix4fv(u.uVP, false, VP);
  gl.uniformMatrix4fv(u.uLVP, false, LVP);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shadowTex);
  gl.uniform1i(u.uSh, 0);
  gl.uniform1f(u.uTex, 1 / SHADOW);
  gl.uniform1f(u.uShOn, shadowsOn ? 1 : 0);
  gl.uniform3fv(u.uDir, sd);
  gl.uniform3fv(u.uSun, L.sun.map((v) => v * L.sunK));
  gl.uniform3fv(u.uSky, L.sky);
  gl.uniform3fv(u.uGnd, L.ground);
  gl.uniform4fv(u.uMono, L.mono);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, nb);

  // glows
  if (nga || ngm) {
    gl.bindVertexArray(vaoGlow);
    gl.useProgram(progGlow.p);
    gl.uniformMatrix4fv(progGlow.u.uVP, false, VP);
    gl.uniform3fv(progGlow.u.uR, camR);
    gl.uniform3fv(progGlow.u.uU, camU);
    gl.uniform4fv(progGlow.u.uMono, L.mono);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf);
    if (nga) {
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, glowAdd, 0, nga * 10);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nga);
    }
    if (ngm) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, glowMix, 0, ngm * 10);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ngm);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
  gl.bindVertexArray(null);
  return nb;
};

G.lost = () => !gl || gl.isContextLost();
window.Gfx = G;
})();
