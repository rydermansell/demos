// Gonzalez Tree Service: scroll-driven 3D drone flight.
// Realism pass: leaf-card foliage, textured bark/lawn/siding, grass blades, cloud sky,
// warm key + cool fill lighting with soft shadows. Camera follows `getP()`; a slow idle drift keeps it alive.
import * as THREE from '../lib/three.module.min.js';

export function initStory({ canvas, stage, getP, T, mobile, hud }) {
  const { N } = T;

  const v = (x, y, z) => new THREE.Vector3(x, y, z), v2 = (x, z) => new THREE.Vector2(x, z);
  // ---------------------------------------------------------------- noise + random
  function hash3(x, y, z) { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683); h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
  function vnoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf), L = (a, b, t) => a + (b - a) * t, c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
    return L(L(L(c(0,0,0), c(1,0,0), u), L(c(0,1,0), c(1,1,0), u), v), L(L(c(0,0,1), c(1,0,1), u), L(c(0,1,1), c(1,1,1), u), v), w) * 2 - 1;
  }
  const fbm = (x, z, o = 5) => { let a = 0, amp = 1, f = 1, n = 0; for (let i = 0; i < o; i++) { a += amp * vnoise(x * f, 0.37 * i, z * f); n += amp; amp *= .5; f *= 2.03; } return a / n; };
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const R = (a, b) => a + (b - a) * rnd();
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const C = h => new THREE.Color(h);

  // ---------------------------------------------------------------- world layout
  const S1 = new THREE.Vector2(0, 0), S3 = new THREE.Vector2(78, 46), S4 = new THREE.Vector2(-96, 64);
  const SITES = [[S1, 36, 62], [S3, 22, 44], [S4, 34, 58]];
  function flatW(x, z) { let w = 1; for (const [s, r0, r1] of SITES) w = Math.min(w, sstep(r0, r1, Math.hypot(x - s.x, z - s.y))); return w; }
  function height(x, z) { return (fbm(x * .0075, z * .0075) * 26 + fbm(x * .03, z * .03, 3) * 3.2 + 6) * flatW(x, z); }

  // ---------------------------------------------------------------- renderer / scene
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let PR = Math.min(devicePixelRatio || 1, mobile ? 1.25 : 1.75); const PR_MIN = 1; renderer.setPixelRatio(PR);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
  const ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(0xc99b78, .0042); scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(50, 1, .3, 1800);

  const U = { time: { value: 0 }, wind: { value: 1 } };
  function windy(mat, amt = 1) {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uTime = U.time; sh.uniforms.uWind = U.wind;
      sh.vertexShader = 'uniform float uTime; uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 ip = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
        #endif
        float hg = max(position.y, 0.0);
        float sw = sin(uTime * 1.25 + ip.x * .21 + ip.z * .17) * .7 + sin(uTime * 3.1 + ip.x * .53 + position.x * .8 + position.z * .6) * .3;
        transformed.x += sw * hg * hg * ${(0.0016 * amt).toFixed(5)} * uWind;
        transformed.z += sw * hg * hg * ${(0.0011 * amt).toFixed(5)} * uWind;`);
    };
    return mat;
  }

  // ---------------------------------------------------------------- procedural textures (canvas)
  function canvasTex(w, h, draw, srgb = true, rep = null) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = ANISO;
    if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]); }
    return t;
  }
  const leafTex = canvasTex(256, 256, (g) => {
    for (let i = 0; i < 110; i++) {
      const a = rnd() * 6.283, r = Math.sqrt(rnd()) * 96, x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r, l = R(11, 20), wd = l * R(.42, .55);
      const hue = R(78, 112), sat = R(34, 56), lit = R(38, 62) - r * .06;
      g.save(); g.translate(x, y); g.rotate(rnd() * 6.283);
      g.fillStyle = `hsl(${hue},${sat}%,${lit}%)`; g.beginPath(); g.ellipse(0, 0, wd, l, 0, 0, 6.283); g.fill();
      g.strokeStyle = `hsla(${hue},${sat + 5}%,${lit + 14}%,.55)`; g.lineWidth = 1; g.beginPath(); g.moveTo(0, -l * .9); g.lineTo(0, l * .9); g.stroke(); g.restore();
    }
  });
  const barkTex = canvasTex(128, 512, (g, w, h) => {
    g.fillStyle = '#8a7461'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) { const x = R(0, w), y0 = R(-40, h), len = R(30, 160), wd = R(1.5, 5);
      g.strokeStyle = rnd() < .65 ? `rgba(28,20,14,${R(.35, .75)})` : `rgba(160,140,118,${R(.15, .35)})`; g.lineWidth = wd; g.beginPath(); g.moveTo(x, y0);
      for (let y = y0; y < y0 + len; y += 10) g.lineTo(x + Math.sin(y * .05 + i) * 3, y); g.stroke(); }
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${rnd() < .5 ? '20,14,10' : '150,135,110'},${R(.1, .3)})`; g.fillRect(R(0, w), R(0, h), R(1, 3), R(1, 3)); }
  }, true, [2, 2]);
  const groundTex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = 'rgb(225,225,215)'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) { const x = R(0, w), y = R(0, h), l = R(3, 9), a = R(-.5, .5) - 1.57, k = R(150, 255);
      g.strokeStyle = `rgba(${k * .85 | 0},${k | 0},${k * .7 | 0},${R(.25, .6)})`; g.lineWidth = R(.6, 1.6); g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(90,80,60,${R(.08, .2)})`; g.beginPath(); g.arc(R(0, w), R(0, h), R(4, 18), 0, 6.283); g.fill(); }
  }, true, [150, 150]);
  const sidingTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#ece6d8'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) { const gr = g.createLinearGradient(0, y, 0, y + 16); gr.addColorStop(0, 'rgba(255,255,255,.25)'); gr.addColorStop(.8, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(60,50,40,.35)'); g.fillStyle = gr; g.fillRect(0, y, w, 16); }
  }, true, [5, 2.4]);
  const roofTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#3b3e42'; g.fillRect(0, 0, w, h);
    for (let row = 0; row < 16; row++) for (let col = 0; col < 9; col++) { const x = col * 32 + (row % 2) * 16, y = row * 16, k = R(45, 75) | 0;
      g.fillStyle = `rgb(${k},${k + 2},${k + 6})`; g.fillRect(x + 1, y + 1, 30, 14); g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x, y + 13, 32, 3); }
  }, true, [3, 3]);

  // ---------------------------------------------------------------- geometry helpers
  function paint(g, fn) { const p = g.attributes.position, n = g.attributes.normal, a = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) { fn(c, p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i)); a[i*3] = c.r; a[i*3+1] = c.g; a[i*3+2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; }
  function merge(geos) {
    let nv = 0, ni = 0; for (const g of geos) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni); let vo = 0, io = 0;
    for (const g of geos) { const cnt = g.attributes.position.count;
      pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3); col.set(g.attributes.color.array, vo * 3); if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
      if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo; io += g.index.count; } else { for (let i = 0; i < cnt; i++) idx[io + i] = vo + i; io += cnt; }
      vo += cnt; g.dispose(); }
    const m = new THREE.BufferGeometry(); m.setAttribute('position', new THREE.BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    m.setAttribute('color', new THREE.BufferAttribute(col, 3)); m.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); m.setIndex(new THREE.BufferAttribute(idx, 1)); m.computeBoundingSphere(); return m;
  }
  // a foliage cluster made of leaf cards; normals point out from the cluster centre so light wraps softly like a real canopy
  function leafCluster(cx, cy, cz, r, n, size, hexA, hexB) {
    const pos = [], nor = [], col = [], uv = [], idx = [], ca = C(hexA), cb = C(hexB), tmp = new THREE.Color(), q = new THREE.Quaternion(), e = new THREE.Euler(), vv3 = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, a = rnd() * 6.283, rr = Math.cbrt(rnd()) * r, s = Math.sqrt(1 - u * u);
      const ox = Math.cos(a) * s * rr, oy = u * rr * .8, oz = Math.sin(a) * s * rr, len = Math.hypot(ox, oy, oz) || 1;
      const nx = ox / len, ny = (oy / len) * .8 + .2, nz = oz / len, nl = Math.hypot(nx, ny, nz);
      const sz = size * R(.75, 1.25); e.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28); q.setFromEuler(e);
      const out = Math.max(0, ny / nl); tmp.copy(ca).lerp(cb, rnd()).multiplyScalar((.72 + .28 * (rr / r)) * (.85 + .15 * out));
      const b = pos.length / 3;
      [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]].forEach(([x, y, uu, vv]) => {
        vv3.set(x * sz * .5, y * sz * .5, 0).applyQuaternion(q); pos.push(cx + ox + vv3.x, cy + oy + vv3.y, cz + oz + vv3.z);
        nor.push(nx / nl, ny / nl, nz / nl); col.push(tmp.r, tmp.g, tmp.b); uv.push(uu, vv); });
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); return g;
  }
  function barkG(g, hex = 0xb8a693) { const b = C(hex); return paint(g, (c, x, y, z, nx) => c.copy(b).multiplyScalar(.9 + .25 * Math.max(0, nx))); }

  // phones: Lambert shading for matte foliage/ground (a fraction of the per-pixel cost of PBR, nearly identical on rough surfaces)
  const MAT = o => { if (mobile) { const q = Object.assign({}, o); delete q.roughness; delete q.metalness; return new THREE.MeshLambertMaterial(q); } return new THREE.MeshStandardMaterial(o); };
  // ---------------------------------------------------------------- materials
  const leafMat = windy(MAT({ map: leafTex, alphaTest: .38, alphaToCoverage: true, side: THREE.DoubleSide, vertexColors: true, roughness: .78, metalness: 0, emissive: 0x1a2e0d, emissiveIntensity: .55 }));
  const heroLeafMat = windy(MAT({ map: leafTex, alphaTest: .38, alphaToCoverage: true, side: THREE.DoubleSide, vertexColors: true, roughness: .72, metalness: 0, emissive: 0x2a4414, emissiveIntensity: .6 }), .45);
  const barkMat = MAT({ map: barkTex, bumpMap: barkTex, bumpScale: 3, vertexColors: true, roughness: .95 });

  // ---------------------------------------------------------------- terrain
  const TS = 760, SEG = mobile ? 140 : 220;
  const tg = new THREE.PlaneGeometry(TS, TS, SEG, SEG); tg.rotateX(-Math.PI / 2);
  { const p = tg.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, height(p.getX(i), p.getZ(i))); tg.computeVertexNormals(); }
  const grassA = C(0x5d7c3c), grassB = C(0x77954a), lawn = C(0x7a9e48), forestC = C(0x34502b), dirt = C(0x7a5f40), dirt2 = C(0x957652), rock = C(0x6b685c);
  paint(tg, (c, x, y, z, nx, ny) => {
    const d1 = Math.hypot(x - S1.x, z - S1.y), d3 = Math.hypot(x - S3.x, z - S3.y), d4 = Math.hypot(x - S4.x, z - S4.y), md = Math.min(d1, d3, d4);
    const n = fbm(x * .05, z * .05, 3) * .5 + .5;
    c.copy(grassA).lerp(grassB, n);
    const lw = 1 - sstep(24, 40, Math.min(d1, d3)); c.lerp(lawn, lw * .75);
    if (lw > 0) c.multiplyScalar(1 + Math.sin((x * .7 + z * .7) * .9) * .045 * lw);           // mowing stripes
    c.lerp(forestC, sstep(42, 80, md) * .8);
    const dw = 1 - sstep(18, 32, d4); c.lerp(dirt, dw * (.65 + .35 * n)); c.lerp(dirt2, dw * Math.max(0, vnoise(x * .3, 1, z * .3)) * .5);
    c.lerp(rock, Math.max(0, .55 - ny) * 1.6);
    c.multiplyScalar(1.12);
  });
  const terrain = new THREE.Mesh(tg, MAT({ map: groundTex, vertexColors: true, roughness: 1, metalness: 0 }));
  terrain.receiveShadow = true; scene.add(terrain);

  // ---------------------------------------------------------------- forest (instanced leaf-card trees)
  const trunkG = barkG(new THREE.CylinderGeometry(.14, .3, 5, 7).translate(0, 2.5, 0));
  const decidLeaves = merge([leafCluster(0, 6.2, 0, 2.3, mobile ? 18 : 26, 1.9, 0x5f8a3e, 0x3d6a2c), leafCluster(1.3, 5.1, .6, 1.8, mobile ? 12 : 18, 1.7, 0x6a9444, 0x46733a),
    leafCluster(-1.2, 5.4, -.7, 1.8, mobile ? 12 : 18, 1.7, 0x557f38, 0x36602b), leafCluster(.2, 7.7, .2, 1.6, mobile ? 10 : 14, 1.6, 0x76a04c, 0x4f7d3c)]);
  const conifG = merge([barkG(new THREE.CylinderGeometry(.1, .22, 3, 6).translate(0, 1.5, 0), 0x6e5a48),
    ...[[2.5, 3.4, 2.4], [2, 3.1, 4.4], [1.5, 2.8, 6.2], [.95, 2.4, 7.8]].map(([r, h, y]) => { const g = new THREE.ConeGeometry(r, h, 9, 3); g.translate(0, y, 0);
      const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const k = 1 + vnoise(p.getX(i) * 2.2, p.getY(i) * 1.3, p.getZ(i) * 2.2) * .18; p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); } g.computeVertexNormals();
      const b = C(0x2b4d31); return paint(g, (c, x, yy, z, nx, ny) => c.copy(b).multiplyScalar(.55 + .6 * Math.max(0, ny) + .12 * nx)); })]);
  const conifMat = windy(MAT({ vertexColors: true, roughness: .9 }));
  const COUNT = mobile ? 650 : 1500, insts = [[], []];
  const keep = (x, z) => Math.hypot(x - S1.x, z - S1.y) > 46 && Math.hypot(x - S3.x, z - S3.y) > 30 && Math.hypot(x - S4.x, z - S4.y) > 42;
  for (let i = 0; i < COUNT * 3 && insts[0].length + insts[1].length < COUNT; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 340, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!keep(x, z)) continue; if (fbm(x * .02, z * .02, 2) < -.25 && rnd() < .6) continue;
    insts[rnd() < .35 ? 1 : 0].push([x, z, R(.85, 1.55)]);
  }
  [[-32, -30, 1.4], [-20, -38, 1.5], [22, -34, 1.6], [36, -18, 1.3], [-44, 6, 1.4], [46, 22, 1.3], [64, 26, 1.4], [96, 60, 1.5], [88, 30, 1.2], [-78, 40, 1.5], [-118, 70, 1.4]]
    .forEach(([x, z, s], i) => insts[i % 3 === 0 ? 1 : 0].push([x, z, s]));
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  function plant(list, geo, mat, shadow, sd) {
    seed = sd; const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([x, z, s], i) => { dummy.position.set(x, height(x, z) - .25, z); dummy.rotation.set(R(-.04, .04), R(0, 6.28), R(-.04, .04)); dummy.scale.set(s * R(.9, 1.1), s * R(.9, 1.2), s * R(.9, 1.1)); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
      const lv = R(.8, 1.1); tint.setRGB(lv * R(.92, 1.08), lv * R(.95, 1.05), lv * R(.85, 1)); im.setColorAt(i, tint); });
    im.castShadow = shadow; im.receiveShadow = true; scene.add(im); return im;
  }
  // trunks and canopies share a seed so each canopy sits on its own trunk
  plant(insts[0], trunkG, barkMat, !mobile, 4242); plant(insts[0], decidLeaves, leafMat, !mobile, 4242); plant(insts[1], conifG, conifMat, !mobile, 999);
  seed = 31337;

  // ---------------------------------------------------------------- hero trees
  function bigTree(sc = 1, leafA = 0x6a9444, leafB = 0x3e6b2e, dens = 1) {
    const gs = [], fs = [], up = new THREE.Vector3(0, 1, 0);
    const tr = new THREE.CylinderGeometry(.55, 1.0, 8, 16, 10, false); tr.translate(0, 4, 0);
    { const p = tr.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i), fl = y < 1 ? (1 - y) * .35 : 0;
        p.setX(i, p.getX(i) * (1 + fl) + Math.sin(y * .35) * .22); p.setZ(i, p.getZ(i) * (1 + fl) + Math.cos(y * .28) * .12); } tr.computeVertexNormals(); }
    gs.push(barkG(tr));
    const NB = 9, ends = [];
    for (let i = 0; i < NB; i++) {
      const a = i / NB * Math.PI * 2 + R(-.3, .3), y0 = R(5.2, 7.8), len = R(4.6, 6.8), dir = new THREE.Vector3(Math.cos(a) * .82, R(.45, .85), Math.sin(a) * .82).normalize();
      const b = new THREE.CylinderGeometry(.12, .38, len, 9, 3); b.translate(0, len / 2, 0); b.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir)); b.translate(Math.sin(y0 * .35) * .22, y0, 0); gs.push(barkG(b));
      const end = dir.clone().multiplyScalar(len).add(new THREE.Vector3(0, y0, 0)); ends.push(end);
      for (let t = 0; t < 2; t++) { const td = dir.clone().add(new THREE.Vector3(R(-.6, .6), R(0, .5), R(-.6, .6))).normalize(), tl = R(1.6, 2.6);
        const tw = new THREE.CylinderGeometry(.04, .1, tl, 6); tw.translate(0, tl / 2, 0); tw.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, td)); tw.translate(end.x - dir.x * .8, end.y - dir.y * .8, end.z - dir.z * .8); gs.push(barkG(tw)); }
    }
    const nC = Math.round(60 * dens);
    ends.forEach(e => { for (let k = 0; k < 2; k++) fs.push(leafCluster(e.x + R(-1.2, 1.2), e.y + R(-.2, 1.6), e.z + R(-1.2, 1.2), R(2.2, 3.0), nC, R(1.5, 1.9), leafA, leafB)); });
    for (let k = 0; k < 7; k++) fs.push(leafCluster(R(-3, 3), R(11, 14.5), R(-3, 3), R(2.8, 3.8), Math.round(nC * 1.3), R(1.6, 2.0), leafA, leafB));
    const grp = new THREE.Group();
    const bm = new THREE.Mesh(merge(gs), barkMat), fm = new THREE.Mesh(merge(fs), heroLeafMat);
    [bm, fm].forEach(m => { m.castShadow = true; m.receiveShadow = true; grp.add(m); }); grp.scale.setScalar(sc); return grp;
  }
  const oak = bigTree(1.12, 0x77a04a, 0x416e30, mobile ? .55 : 1); oak.position.set(5, 0, 3); oak.rotation.set(0, .4, .075); scene.add(oak);
  const oak2 = bigTree(.95, 0x6a9444, 0x3a6a2c, mobile ? .3 : .7); oak2.position.set(-31, 0, -19); oak2.rotation.y = 1.3; scene.add(oak2);

  // ---------------------------------------------------------------- grass blades near the camera stops
  {
    const bg = new THREE.BufferGeometry(), w = .045, h = 1;
    bg.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, -w * .55, h * .55, 0, w * .55, h * .55, 0, 0, h, 0], 3));
    bg.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, .2, 0, 1, .2, 0, 1, .2, 0, 1, .2, 0, 1, .2], 3));
    const base = C(0x34501f), tip = C(0xa3bf62), mid = base.clone().lerp(tip, .55);
    bg.setAttribute('color', new THREE.Float32BufferAttribute([...base.toArray(), ...base.toArray(), ...mid.toArray(), ...mid.toArray(), ...tip.toArray()], 3));
    bg.setIndex([0, 1, 3, 0, 3, 2, 2, 3, 4]);
    const gm = windy(MAT({ vertexColors: true, side: THREE.DoubleSide, roughness: .9 }), 60);
    const spots = [[S1, 33, mobile ? 4000 : 18000], [S3, 21, mobile ? 1800 : 7000], [S4, 36, mobile ? 600 : 2500]];
    const total = spots.reduce((a, s) => a + s[2], 0), im = new THREE.InstancedMesh(bg, gm, total); let n = 0;
    const blocked = (x, z) => { const hx = x + 15, hz = z + 5; const lx = hx * Math.cos(.3) - hz * Math.sin(.3), lz = hx * Math.sin(.3) + hz * Math.cos(.3);
      if (Math.abs(lx) < 7.6 && lz > -5.6 && lz < 7.6) return true; if (Math.hypot(x - 5, z - 3) < 1.3) return true;
      const dx = x + 6, dz = z - 13, ax = dx * Math.cos(.3) - dz * Math.sin(.3), az = dx * Math.sin(.3) + dz * Math.cos(.3); return Math.abs(ax) < 2.8 && Math.abs(az) < 15; };
    for (const [c, r, cnt] of spots) for (let i = 0; i < cnt; i++) {
      const a = rnd() * 6.283, rr = (c === S4 ? 26 + rnd() * 10 : Math.sqrt(rnd()) * r), x = c.x + Math.cos(a) * rr, z = c.y + Math.sin(a) * rr;
      if (c === S1 && blocked(x, z)) continue;
      dummy.position.set(x, height(x, z), z); dummy.rotation.set(R(-.25, .25), R(0, 6.28), R(-.25, .25)); const s = R(.28, .62); dummy.scale.set(R(.8, 1.4), s, 1); dummy.updateMatrix(); im.setMatrixAt(n, dummy.matrix);
      const lv = R(.75, 1.1); tint.setRGB(lv, lv * R(.95, 1.05), lv * R(.8, 1)); im.setColorAt(n, tint); n++;
    }
    im.count = n; im.receiveShadow = true; scene.add(im);
  }

  // ---------------------------------------------------------------- house
  const house = new THREE.Group();
  const std = (hex, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: hex, roughness: .85 }, o));
  const add = (g, m, x, y, z, parent = house) => { const me = new THREE.Mesh(g, m); me.position.set(x, y, z); me.castShadow = true; me.receiveShadow = true; parent.add(me); return me; };
  const trim = std(0xf6f3ec, { roughness: .7 });
  add(new THREE.BoxGeometry(13, 5.6, 9.5), new THREE.MeshStandardMaterial({ map: sidingTex, roughness: .9 }), 0, 2.8, 0);
  add(new THREE.BoxGeometry(13.3, .5, 9.8), std(0x9a948a), 0, .25, 0);
  { const sh = new THREE.Shape(); sh.moveTo(-7.5, 0); sh.lineTo(0, 3.9); sh.lineTo(7.5, 0); sh.lineTo(-7.5, 0);
    const rg = new THREE.ExtrudeGeometry(sh, { depth: 10.8, bevelEnabled: false }); rg.translate(0, 0, -5.4);
    const uv = rg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * .12, uv.getY(i) * .12);
    add(rg, new THREE.MeshStandardMaterial({ map: roofTex, roughness: .8 }), 0, 5.6, 0); }
  add(new THREE.BoxGeometry(1.1, 3.2, 1.1), std(0x8a5340), 3.6, 8.2, -1.5);
  const winMat = std(0xffc46b, { emissive: 0xffb54a, emissiveIntensity: 1.6, roughness: .3 });
  const winAt = (x, y, z, side) => { add(side ? new THREE.BoxGeometry(.1, 1.5, 1.6) : new THREE.BoxGeometry(1.6, 1.5, .1), winMat, x, y, z);
    add(side ? new THREE.BoxGeometry(.08, 1.8, 1.9) : new THREE.BoxGeometry(1.9, 1.8, .08), trim, x - (side ? .02 : 0), y, z - (side ? 0 : .02));
    add(side ? new THREE.BoxGeometry(.14, .08, 1.6) : new THREE.BoxGeometry(1.6, .08, .14), trim, x, y, z); };
  [-4.3, -1.4, 4.3].forEach(x => winAt(x, 3, 4.8, false)); [-3, 0, 3].forEach(z => winAt(6.55, 3, z, true));
  add(new THREE.BoxGeometry(1.3, 2.5, .14), std(0x6b3f2a), 1.6, 1.5, 4.82); add(new THREE.BoxGeometry(1.6, 2.7, .1), trim, 1.6, 1.5, 4.79);
  add(new THREE.BoxGeometry(14.5, .22, 2.8), std(0x9c958b), 0, .12, 6.2);
  [-6.5, 6.5].forEach(x => add(new THREE.BoxGeometry(.18, 5.6, .18), trim, x, 2.8, 4.8));
  house.position.set(-15, 0, -5); house.rotation.y = .3; scene.add(house);
  { const dg = new THREE.PlaneGeometry(5.2, 30); dg.rotateX(-Math.PI / 2); const dw = new THREE.Mesh(dg, std(0x86837b, { roughness: 1 })); dw.position.set(-6, .07, 13); dw.rotation.y = .3; dw.receiveShadow = true; scene.add(dw); }

  // ---------------------------------------------------------------- storm site: fallen tree on a fence
  const storm = new THREE.Group(); storm.position.set(S3.x, 0, S3.y); scene.add(storm);
  { const gs = [], fs = [];
    const t = new THREE.CylinderGeometry(.42, .82, 17, 14, 6); t.rotateZ(Math.PI / 2 - .05); t.translate(0, .75, 0); gs.push(barkG(t));
    const rp = new THREE.CylinderGeometry(2.6, 2.3, .9, 18, 2); rp.rotateZ(Math.PI / 2); rp.translate(8.8, 2, 0);
    { const p = rp.attributes.position; for (let i = 0; i < p.count; i++) { const k = 1 + vnoise(p.getY(i) * 1.5, p.getZ(i) * 1.5, 3) * .2; p.setY(i, (p.getY(i) - 2) * k + 2); p.setZ(i, p.getZ(i) * k); } rp.computeVertexNormals(); }
    gs.push(paint(rp, (c, x, y, z) => c.set(0x7a5a3e).multiplyScalar(.55 + .3 * (vnoise(y * 2, z * 2, 1) * .5 + .5))));
    for (let i = 0; i < 7; i++) { const b = new THREE.CylinderGeometry(.08, .22, R(2.5, 4.5), 7); b.rotateZ(R(-1.2, 1.2)); b.rotateX(R(-1.2, 1.2)); b.translate(R(-7, 6), R(.8, 1.8), R(-1.5, 1.5)); gs.push(barkG(b)); }
    for (let i = 0; i < 9; i++) fs.push(leafCluster(R(-9.5, -2), R(.9, 2.4), R(-2.8, 2.8), R(1.4, 2.4), mobile ? 30 : 46, 1.5, 0x5b8a3c, 0x3b662a));
    for (let i = 0; i < 14; i++) { const b = new THREE.CylinderGeometry(.05, .12, R(1.2, 2.6), 6); b.rotateZ(Math.PI / 2 + R(-.4, .4)); b.rotateY(R(0, 6.28)); b.translate(R(-12, 12), .15, R(-9, 9)); gs.push(barkG(b, 0x9a8470)); }
    const snag = new THREE.CylinderGeometry(.35, .62, 4.2, 12); snag.translate(9.5, 2.1, 3.8); gs.push(barkG(snag));
    const bm = new THREE.Mesh(merge(gs), barkMat), fm = new THREE.Mesh(merge(fs), leafMat);
    [bm, fm].forEach(m => { m.castShadow = true; m.receiveShadow = true; storm.add(m); }); storm.rotation.y = -.5;
    const t2 = bigTree(.9, 0x5f8a3e, 0x34602a, mobile ? .3 : .7); t2.position.set(-14, 0, -12); storm.add(t2);
    const fwood = std(0xd9d2c3, { roughness: .8 }); for (let i = 0; i < 14; i++) { const pst = add(new THREE.BoxGeometry(.14, 1.3, .14), fwood, -12 + i * 2, .65, 7.5, storm); if (i === 6 || i === 7) { pst.rotation.z = i === 6 ? .5 : -.4; pst.position.y = .45; } }
    add(new THREE.BoxGeometry(11, .14, .1), fwood, -6.5, 1.1, 7.5, storm); add(new THREE.BoxGeometry(11, .14, .1), fwood, 8.5, 1.1, 7.5, storm);
  }

  // ---------------------------------------------------------------- clearing site: stumps, brush, chipper, truck
  const clr = new THREE.Group(); clr.position.set(S4.x, 0, S4.y); scene.add(clr);
  { const gs = [], fs = [];
    for (let i = 0; i < 26; i++) { const a = R(0, 6.28), r = Math.sqrt(rnd()) * 22, x = Math.cos(a) * r, z = Math.sin(a) * r, rr = R(.28, .62);
      const s = new THREE.CylinderGeometry(rr, rr * 1.18, R(.3, .55), 12); s.translate(x, .2, z);
      gs.push(paint(s, (c, px, py, pz, nx, ny) => ny > .9 ? c.set(0xe2c08a) : c.set(0x8f7a66))); }
    for (let k = 0; k < 4; k++) { const cx = R(-16, 16), cz = R(-16, -6); for (let i = 0; i < 5; i++) fs.push(leafCluster(cx + R(-2.4, 2.4), R(.5, 1.5), cz + R(-1.6, 1.6), R(1.2, 2), mobile ? 26 : 40, 1.4, 0x6c7d40, 0x485a2c)); }
    for (let i = 0; i < 9; i++) { const l = new THREE.CylinderGeometry(.32, .36, 4.4, 12); l.rotateZ(Math.PI / 2); l.translate(10, .35 + Math.floor(i / 4) * .62, 6 + (i % 4) * .66 - Math.floor(i / 4) * .33);
      gs.push(paint(l, (c, x, y, z, nx) => Math.abs(nx) > .9 ? c.set(0xe2c08a) : c.set(0x8f7a66))); }
    const bm = new THREE.Mesh(merge(gs), barkMat), fm = new THREE.Mesh(merge(fs), leafMat);
    [bm, fm].forEach(m => { m.castShadow = true; m.receiveShadow = true; clr.add(m); });
    const yel = std(0xf2b20e, { roughness: .38, metalness: .15 }), blk = std(0x151719, { roughness: .7 }), stl = std(0x3a3d40, { roughness: .45, metalness: .5 });
    const ch = new THREE.Group(); ch.position.set(-4, 0, 9); ch.rotation.y = -.7; clr.add(ch);
    add(new THREE.BoxGeometry(2.6, 1.5, 1.8), yel, 0, 1.25, 0, ch);
    add(new THREE.BoxGeometry(1.5, 1.1, 1.9), yel, -1.9, 1.35, 0, ch).rotation.z = .35;
    add(new THREE.BoxGeometry(1.4, .9, 1.7), stl, 1.6, 1.6, 0, ch);
    { const c = add(new THREE.CylinderGeometry(.28, .32, 2.6, 14), yel, 1.8, 2.9, 0, ch); c.rotation.z = -.55; }
    [[.2, 1.05], [.2, -1.05]].forEach(([x, z]) => { const w = add(new THREE.CylinderGeometry(.5, .5, .38, 20), blk, x, .5, z, ch); w.rotation.x = Math.PI / 2; });
    add(new THREE.BoxGeometry(2.4, .14, .14), stl, 2.8, .7, 0, ch);
    const tk = new THREE.Group(); tk.position.set(4.5, 0, 13); tk.rotation.y = -.7; clr.add(tk);
    const body = std(0x253239, { roughness: .28, metalness: .45 }), glass = std(0x141a20, { roughness: .08, metalness: .7 });
    add(new THREE.BoxGeometry(5.6, 1.0, 2.1), body, 0, 1.0, 0, tk); add(new THREE.BoxGeometry(2.3, 1.0, 2.0), body, .6, 1.95, 0, tk);
    add(new THREE.BoxGeometry(2.0, .7, 2.04), glass, .6, 2.05, 0, tk);
    [[-1.9, 1.05], [-1.9, -1.05], [1.8, 1.05], [1.8, -1.05]].forEach(([x, z]) => { const w = add(new THREE.CylinderGeometry(.45, .45, .34, 20), blk, x, .45, z, tk); w.rotation.x = Math.PI / 2; });
  }


  // tileable cloud noise baked once (the sky used to compute 10 octaves of noise per pixel per frame)
  const cloudTex = (() => { const Nn = 256, d = new Uint8Array(Nn * Nn * 4);
    const tn = (x, y, P) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf), m = a => ((a % P) + P) % P;
      const h = (i, j) => hash3(m(xi + i), m(yi + j), P); return (h(0, 0) * (1 - u) + h(1, 0) * u) * (1 - w) + (h(0, 1) * (1 - u) + h(1, 1) * u) * w; };
    for (let y = 0; y < Nn; y++) for (let x = 0; x < Nn; x++) { let a = 0, amp = .5, P = 6; for (let o = 0; o < 6; o++) { a += amp * tn(x / Nn * P, y / Nn * P, P); amp *= .5; P *= 2; }
      const v = Math.min(255, Math.max(0, a * 255)) | 0; d.set([v, v, v, 255], (y * Nn + x) * 4); }
    const t = new THREE.DataTexture(d, Nn, Nn); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true; return t; })();
  // ---------------------------------------------------------------- sky with clouds, lights, rain
  const skyU = { top: { value: C(0x46679a) }, hor: { value: C(0xf2b77a) }, sunC: { value: C(0xffd2a0) }, sunDir: { value: new THREE.Vector3() }, flash: { value: 0 },
    cov: { value: .55 }, cdark: { value: 0 }, uTime: U.time, cTex: { value: cloudTex } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), new THREE.ShaderMaterial({ uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }',
    fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sunC; uniform vec3 sunDir; uniform float flash; uniform float cov; uniform float cdark; uniform float uTime; uniform sampler2D cTex; varying vec3 vW;
      float fb(vec2 p){ return texture2D(cTex, p * .16).r; }
      void main(){ vec3 d = normalize(vW - cameraPosition); float h = max(d.y, 0.); vec3 sd = normalize(sunDir);
        vec3 c = mix(hor, top, pow(h, .48)); float s = max(dot(d, sd), 0.);
        c += sunC * (pow(s, 1200.) * 8. + pow(s, 14.) * .5 + pow(s, 3.) * .14);
        if (d.y > 0.) { vec2 uv = d.xz / (d.y + .14) * 1.3 + vec2(uTime * .006, 0.);
          float f = fb(uv), cl = smoothstep(cov, cov + .28, f) * smoothstep(.0, .22, d.y);
          float lit = fb(uv + sd.xz * .08); vec3 cc = mix(hor * 1.08, vec3(1.), .35) * mix(1., .55, cdark) * (.8 + .35 * (f - lit) * 4.);
          cc += sunC * pow(s, 5.) * .55 * (1. - cdark);
          c = mix(c, cc, cl * .92); }
        c = mix(c, hor, smoothstep(.02, -.06, d.y)); c += vec3(.75, .8, .95) * flash;
        gl_FragColor = vec4(c, 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  sky.renderOrder = -1; scene.add(sky);
  const hemi = new THREE.HemisphereLight(0xa9c0dc, 0x3a4a2a, .9); scene.add(hemi);
  const fill = new THREE.DirectionalLight(0x8eaed6, .45); scene.add(fill, fill.target);
  const sun = new THREE.DirectionalLight(0xffd2a0, 2.6); sun.castShadow = true;
  const SM = mobile ? 1536 : 4096; sun.shadow.mapSize.set(SM, SM); const sc = sun.shadow.camera; sc.left = -42; sc.right = 42; sc.top = 42; sc.bottom = -42; sc.near = 1; sc.far = 420;
  sun.shadow.bias = -.00025; sun.shadow.normalBias = .035;
  scene.add(sun, sun.target);
  const RN = mobile ? 1800 : 3200, rp = new Float32Array(RN * 6), re = new Float32Array(RN * 2);
  for (let i = 0; i < RN; i++) { const x = R(-35, 35), y = R(0, 40), z = R(-35, 35); rp.set([x, y, z, x, y, z], i * 6); re[i * 2 + 1] = 1; }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3)); rg.setAttribute('aEnd', new THREE.BufferAttribute(re, 1));
  const rainU = { uTime: { value: 0 }, uOp: { value: 0 } };
  const rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({ uniforms: rainU, transparent: true, depthWrite: false, fog: false,
    vertexShader: 'uniform float uTime; attribute float aEnd; varying float vE; void main(){ vec3 p = position; p.y = mod(p.y - uTime * 26., 40.) - 12.; p.y += aEnd * 1.1; p.x += aEnd * .22; vE = aEnd; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.); }',
    fragmentShader: 'uniform float uOp; varying float vE; void main(){ gl_FragColor = vec4(.8,.85,.92, uOp * .42 * (1. - vE * .7)); }' }));
  rain.frustumCulled = false; scene.add(rain);

  // ---------------------------------------------------------------- moods (golden hour, storm, morning)
  const MOODS = [
    { top: 0x3c5f95, hor: 0xf3b37c, sunC: 0xffc78a, sunI: 3.3, sunDir: [.55, .27, -.79], hs: 0xbcd0e6, hg: 0x5d6b3c, hI: 1.25, fillI: .65, fog: 0xd2a684, fd: .0036, exp: 1.04, wind: 1, cov: .56, cdark: 0 },
    { top: 0x353f4b, hor: 0x737c87, sunC: 0xaab5c3, sunI: .9, sunDir: [-.3, .6, -.4], hs: 0xa8b4c2, hg: 0x46503e, hI: 1.45, fillI: .35, fog: 0x69737d, fd: .0062, exp: 1.0, wind: 3.4, cov: .28, cdark: .85 },
    { top: 0x5a8fc8, hor: 0xf3d8b2, sunC: 0xfff0d2, sunI: 2.9, sunDir: [.5, .45, -.62], hs: 0xbad2ea, hg: 0x4f5e36, hI: 1.0, fillI: .5, fog: 0xc2cdd2, fd: .0031, exp: 1.06, wind: .8, cov: .6, cdark: 0 },
  ].map(m => ({ ...m, top: C(m.top), hor: C(m.hor), sunC: C(m.sunC), hs: C(m.hs), hg: C(m.hg), fog: C(m.fog), sunDir: new THREE.Vector3(...m.sunDir).normalize() }));
  const tmpV = new THREE.Vector3();
  function applyMood(m, flash) {
    const i = Math.min(1, Math.floor(m)), t = Math.min(1, m - i), a = MOODS[i], b = MOODS[i + 1], L = (x, y) => x + (y - x) * t;
    skyU.top.value.copy(a.top).lerp(b.top, t); skyU.hor.value.copy(a.hor).lerp(b.hor, t); skyU.sunC.value.copy(a.sunC).lerp(b.sunC, t); skyU.flash.value = flash * .9;
    skyU.cov.value = L(a.cov, b.cov); skyU.cdark.value = L(a.cdark, b.cdark);
    tmpV.copy(a.sunDir).lerp(b.sunDir, t).normalize(); skyU.sunDir.value.copy(tmpV);
    sun.color.copy(a.sunC).lerp(b.sunC, t); sun.intensity = L(a.sunI, b.sunI); fill.intensity = L(a.fillI, b.fillI);
    hemi.color.copy(a.hs).lerp(b.hs, t); hemi.groundColor.copy(a.hg).lerp(b.hg, t); hemi.intensity = L(a.hI, b.hI) + flash * 2.4;
    fog.color.copy(a.fog).lerp(b.fog, t); fog.density = L(a.fd, b.fd);
    renderer.toneMappingExposure = L(a.exp, b.exp); U.wind.value = L(a.wind, b.wind);
    winMat.emissiveIntensity = 1.6 * (1 - Math.max(0, m - 1)) + .2;
    return tmpV;
  }


  // ---------------------------------------------------------------- LIDAR-style scan: a glowing ring sweeps up the subject and maps it as points
  scene.updateMatrixWorld(true);
  function sample(objs, max) { const pts = [], v3 = new THREE.Vector3();
    objs.forEach(o => o.traverse(m => { if (!m.isMesh || m.isInstancedMesh) return; const pa = m.geometry.attributes.position; for (let i = 0; i < pa.count; i += 1) pts.push([pa, i, m.matrixWorld]); }));
    const out = new Float32Array(Math.min(max, pts.length) * 3); for (let i = 0; i < out.length / 3; i++) { const [pa, j, mw] = pts[Math.floor(rnd() * pts.length)]; v3.fromBufferAttribute(pa, j).applyMatrix4(mw); out.set([v3.x, v3.y, v3.z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(out, 3)); return g; }
  const scanU = { uScan: { value: -99 }, uAlpha: { value: 0 }, uSize: { value: 1.45 }, uPR: { value: PR }, uCol: { value: C(0xffe39a) } };
  const scanMat = new THREE.ShaderMaterial({ uniforms: scanU, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: 'uniform float uScan; uniform float uAlpha; uniform float uSize; uniform float uPR; varying float vA; void main(){ vec4 wp = modelMatrix * vec4(position, 1.); float d = uScan - wp.y; vA = (d > 0. ? .28 + .72 * exp(-d * 1.4) : 0.) * uAlpha; vec4 mv = viewMatrix * wp; gl_Position = projectionMatrix * mv; gl_PointSize = uSize * uPR * (1. + 1.6 * exp(-abs(d) * 2.)) * (55. / max(1., -mv.z)); }',
    fragmentShader: 'uniform vec3 uCol; varying float vA; void main(){ vec2 c = gl_PointCoord - .5; float r = dot(c, c); if (r > .25 || vA < .01) discard; gl_FragColor = vec4(mix(uCol, vec3(1.), .45 * (1. - r * 4.)) * (1. + vA), vA * (1. - r * 4.)); }' });
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd65a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const ringMat2 = ringMat.clone();
  const SUBJ = [
    { objs: [oak, house], c: v2(5, 3), y0: 0, y1: 18.5, r: 10 },
    { objs: [oak], c: v2(5, 3), y0: 6, y1: 18.5, r: 9 },
    { objs: [storm], c: S3, y0: 0, y1: 6, r: 13 },
    { objs: [clr], c: S4, y0: 0, y1: 4.5, r: 25 },
  ].map(s => { const pts = new THREE.Points(sample(s.objs, mobile ? 2600 : 7000), scanMat); pts.visible = false; pts.frustumCulled = false; scene.add(pts);
    const ring = new THREE.Mesh(new THREE.RingGeometry(s.r * .985, s.r, 128), ringMat); ring.rotation.x = -Math.PI / 2; ring.position.set(s.c.x, 0, s.c.y); ring.visible = false; scene.add(ring);
    const halo = new THREE.Mesh(new THREE.RingGeometry(s.r * 1.02, s.r * 1.06, 128), ringMat2); halo.rotation.x = -Math.PI / 2; halo.position.set(s.c.x, 0, s.c.y); halo.visible = false; scene.add(halo);
    return { ...s, pts, ring, halo }; });
  let scanI = -1, scanT0 = 0;
  function land(step) { const i = step >= 0 && step < STOP_SUBJ.length ? STOP_SUBJ[step] : -1; SUBJ.forEach(s => { s.pts.visible = s.ring.visible = s.halo.visible = false; }); if (i < 0 || i >= SUBJ.length) { scanI = -1; return; } scanI = i; scanT0 = U.time.value + .15; }
  function scanFrame(tt) {
    if (scanI < 0) return; const s = SUBJ[scanI], e = (tt - scanT0) / 1.6;
    if (e > 2.6) { s.pts.visible = s.ring.visible = s.halo.visible = false; scanI = -1; return; }
    const k = Math.max(0, Math.min(1, e)), ke = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2, y = s.y0 + (s.y1 - s.y0) * ke;
    s.pts.visible = s.ring.visible = s.halo.visible = e > 0; scanU.uScan.value = e < 1 ? y : 1e3; scanU.uAlpha.value = e < 1 ? 1 : Math.max(0, 1 - (e - 1) / 1.6) * .8;
    s.ring.position.y = s.halo.position.y = y; ringMat.opacity = e < 1 ? .9 * Math.sin(Math.PI * Math.min(1, e * 1.1)) ** .4 : 0; ringMat2.opacity = ringMat.opacity * .35;
  }

  // ---------------------------------------------------------------- shots
  const s3 = (x, y, z) => v(S3.x + x, y, S3.y + z), s4 = (x, y, z) => v(S4.x + x, y, S4.y + z);
  const SHOTS = [
    { a: [v(70, 96, 210), v(0, 6, 0)], b: [v(52, 70, 160), v(-2, 6, 0)] },                        // intro: aerial approach
    { a: [v(29, 2.6, 30), v(3, 9.5, 3)], b: [v(21, 2.2, 25), v(1, 10.5, 2)] },                     // 1 removal: low under the oak, house in frame
    { a: [v(27, 9, 21), v(4, 11, 3)], b: [v(22, 21, 17), v(3, 16, 2)] },                           // 2 trimming: rise alongside the canopy
    { a: [s3(-14, 3.2, 15), s3(0, 1.2, 0)], b: [s3(-9, 2.6, 10), s3(2, 1.4, 0)] },                  // 3 storm
    { a: [s4(34, 16, 36), s4(0, 0, 2)], b: [s4(22, 34, 26), s4(-2, 0, -2)] },                       // 4 clearing
  ];
  const END = [s4(28, 92, 120), s4(-10, 0, -20)];
  const ease = { io: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, sine: t => -(Math.cos(Math.PI * t) - 1) / 2 };
  const P = v(0, 0, 0), Lk = v(0, 0, 0);
  // Stops: opening aerial, then one fixed pose per chapter (removal, storm, clearing). getP() runs from -1 (aerial) to N-1.
  // Flights follow a terrain-aware altitude profile: one climb then one descent, or a single glide for short hops.
  // The page eases the timeline once; nothing here adds a second easing, so speed changes stay gentle.
  const at = (sh, u) => { const e = ease.sine(u); return [sh.a[0].clone().lerp(sh.b[0], e), sh.a[1].clone().lerp(sh.b[1], e)]; };
  const STOPS = [at(SHOTS[0], .45), at(SHOTS[1], .3), at(SHOTS[3], .42), at(SHOTS[4], .42)];
  const STOP_MOOD = [0, 0, 1, 2], STOP_SUBJ = [0, 2, 3];
  STOPS.forEach(([pos]) => { pos.y = Math.max(pos.y, height(pos.x, pos.z) + 1.8); });
  const LEGS = STOPS.slice(0, -1).map(([a], i) => { const b = STOPS[i + 1][0]; let mx = -1e9;
    for (let j = 1; j < 40; j++) { const e = j / 40; if (e < .08 || e > .92) continue; mx = Math.max(mx, height(a.x + (b.x - a.x) * e, a.z + (b.z - a.z) * e)); }
    const far = Math.hypot(b.x - a.x, b.z - a.z); return { cruise: Math.max(mx + 14 + far * .04, Math.min(a.y, b.y) + 6), far }; });
  const sm = x => x * x * (3 - 2 * x);
  function pose(p) {
    const s = Math.min(STOPS.length - 1, Math.max(0, p + 1)), i = Math.min(STOPS.length - 2, Math.floor(s)), t = s - i;
    const A = STOPS[i], B = STOPS[i + 1], leg = LEGS[i], yA = A[0].y, yB = B[0].y;
    P.lerpVectors(A[0], B[0], t);
    if (leg.cruise > Math.max(yA, yB) + 3) P.y = t < .5 ? yA + (leg.cruise - yA) * sm(t * 2) : leg.cruise + (yB - leg.cruise) * sm(t * 2 - 1);
    else P.y = yA + (yB - yA) * t;
    P.y = Math.max(P.y, height(P.x, P.z) + 1.8);
    const h = Math.sin(Math.PI * t), big = Math.min(1, leg.far / 60);
    Lk.lerpVectors(A[1], B[1], t); Lk.y += h * Math.min(5, leg.far * .02);
    const roll = h * (i % 2 ? .1 : -.1) * big, fovK = h * big * .8;
    const mood = STOP_MOOD[i] + (STOP_MOOD[i + 1] - STOP_MOOD[i]) * t, storm = Math.abs(s - 2) < .03;
    return { roll, fovK, mood, storm };
  }

  // ---------------------------------------------------------------- loop
  const cp = v(70, 96, 210), cl = v(0, 6, 0); let cRoll = 0, cFov = 0, last = performance.now(), running = false, raf = 0, W = 0, H = 0, wasStorm = false, flashT = -9;
  function resize() { const w = stage.clientWidth, h = stage.clientHeight; if (w === W && h === H) return; W = w; H = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  const drift = v(0, 0, 0), up = v(-1, .5, -1), dirV = v(0, 0, 0), sunDirLast = v(0, 0, 0); let curAnchor = null;
  const ANCH = [v2(-2, 0), S3, S4], anchorOf = l => { let b = ANCH[0], d = 1e9; for (const a of ANCH) { const dd = (a.x - l.x) ** 2 + (a.y - l.z) ** 2; if (dd < d) { d = dd; b = a; } } return b; }; let fc = 0, slow = 0, lastDrop = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame); const dt = Math.min(.05, (now - last) / 1000); last = now; const tt = (U.time.value += dt); rainU.uTime.value = tt;
    resize();
    const p = getP(), st = pose(p), k = 1 - Math.exp(-dt * 4.2);
    cp.lerp(P, k); cl.lerp(Lk, k); cRoll += (st.roll - cRoll) * k; cFov += (st.fovK - cFov) * k;
    const baseFov = camera.aspect < 1 ? 60 : 44; camera.fov = baseFov + cFov * 20; camera.updateProjectionMatrix();
    drift.set(Math.sin(tt * .21) * .8, 0, Math.cos(tt * .17) * .8).multiplyScalar(1 - Math.min(1, cFov * 3));   // slow living drift while resting
    camera.position.copy(cp).add(drift); const gy = height(camera.position.x, camera.position.z) + .6; if (camera.position.y < gy) camera.position.y += (gy - camera.position.y) * .25;
    camera.lookAt(cl); camera.rotateZ(cRoll);
    if (st.storm && !wasStorm) flashT = tt + .55; wasStorm = st.storm;                                                                  // lightning shortly after the storm shot lands
    const fe = tt - flashT, fl = fe < 0 ? 0 : Math.max(0, 1 - fe / .12) + (fe > .2 ? Math.max(0, .7 - (fe - .2) / .1) : 0);
    const sd = applyMood(Math.max(0, Math.min(2, st.mood)), st.mood > .5 && st.mood < 1.5 ? fl : 0);
    const an = anchorOf(Lk); if (an !== curAnchor || sunDirLast.distanceToSquared(sd) > 1e-6) { curAnchor = an; sunDirLast.copy(sd); sun.target.position.set(an.x, 0, an.y); sun.position.copy(sun.target.position).addScaledVector(sd, 180); sun.target.updateMatrixWorld(); renderer.shadowMap.needsUpdate = true; }
    fill.target.position.copy(cl); up.set(-sd.x, .5, -sd.z); fill.position.copy(cl).addScaledVector(up, 100);
    sky.position.copy(camera.position); rain.position.copy(camera.position); rainU.uOp.value = Math.max(0, 1 - Math.abs(st.mood - 1) * 1.6);
    scanFrame(tt);
    renderer.render(scene, camera);
    if (hud && (++fc % 6 === 0)) { hud.alt.textContent = Math.max(0, camera.position.y - height(camera.position.x, camera.position.z)).toFixed(1); camera.getWorldDirection(dirV); hud.hdg.textContent = String(Math.round((Math.atan2(dirV.x, -dirV.z) * 180 / Math.PI + 360) % 360)).padStart(3, '0'); }
    slow = slow * .95 + (dt > 1 / 50 ? 1 : 0) * .05; if (slow > .5 && PR > PR_MIN && tt - lastDrop > 1.2) { PR = Math.max(PR_MIN, PR - .15); renderer.setPixelRatio(PR); scanU.uPR.value = PR; W = 0; lastDrop = tt; slow = 0; }
  }

  // warm-up: compile every shader, upload every texture and buffer, and pre-render each shot once,
  // so no flight ever stalls on first-time GPU work (the main cause of hitches on phones)
  function warm(done) {
    const hidden = []; scene.traverse(o => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    [leafTex, barkTex, groundTex, sidingTex, roofTex, cloudTex].forEach(t => renderer.initTexture(t));
    renderer.compile(scene, camera);
    const poses = STOPS, moods = STOP_MOOD; let i = 0; resize();
    (function next() {
      if (i < poses.length) { camera.position.copy(poses[i][0]); camera.lookAt(poses[i][1]); applyMood(moods[i] || 0, 0); renderer.shadowMap.needsUpdate = true;
        const an = anchorOf(poses[i][1]); sun.target.position.set(an.x, 0, an.y); sun.position.copy(sun.target.position).addScaledVector(skyU.sunDir.value, 180); sun.target.updateMatrixWorld();
        renderer.render(scene, camera); i++; requestAnimationFrame(next); return; }
      hidden.forEach(o => { o.visible = false; }); curAnchor = null; done && done();
    })();
  }
  function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  { pose(getP()); cp.copy(P); cl.copy(Lk); resize(); }
  if (/[?&]perf\b/.test(location.search)) window.__st = { scene, renderer, camera, pose, P, Lk, height, NS: STOPS.length };
  return { start, stop, land, warm };
}
