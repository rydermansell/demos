// Gonzalez Tree Service: scroll-driven 3D drone flight.
// Fast, aggressive swoops between chapters; slow cinematic drifts during each chapter.
import * as THREE from '../lib/three.module.min.js';

export function initStory({ canvas, stage, getP, T, mobile }) {
  const { IH, TL, HL, N } = T;

  // ---------------------------------------------------------------- noise
  function hash3(x, y, z) { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683); h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
  function vnoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf), L = (a, b, t) => a + (b - a) * t, c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
    return L(L(L(c(0,0,0), c(1,0,0), u), L(c(0,1,0), c(1,1,0), u), v), L(L(c(0,0,1), c(1,0,1), u), L(c(0,1,1), c(1,1,1), u), v), w) * 2 - 1;
  }
  const fbm = (x, z, o = 5) => { let a = 0, amp = 1, f = 1, n = 0; for (let i = 0; i < o; i++) { a += amp * vnoise(x * f, 0.37 * i, z * f); n += amp; amp *= .5; f *= 2.03; } return a / n; };
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const R = (a, b) => a + (b - a) * rnd();
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // ---------------------------------------------------------------- world layout
  const S1 = new THREE.Vector2(0, 0), S3 = new THREE.Vector2(78, 46), S4 = new THREE.Vector2(-96, 64);
  const SITES = [[S1, 36, 62], [S3, 22, 44], [S4, 34, 58]];
  function flatW(x, z) { let w = 1; for (const [s, r0, r1] of SITES) w = Math.min(w, sstep(r0, r1, Math.hypot(x - s.x, z - s.y))); return w; }
  function height(x, z) { return (fbm(x * .0075, z * .0075) * 26 + fbm(x * .03, z * .03, 3) * 3.2 + 6) * flatW(x, z); }

  // ---------------------------------------------------------------- renderer / scene
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.6 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(0xc99b78, .0042); scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(50, 1, .4, 1600);

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
        float sw = sin(uTime * 1.25 + ip.x * .21 + ip.z * .17) * .7 + sin(uTime * 2.9 + ip.x * .53 + position.x) * .3;
        transformed.x += sw * hg * hg * ${(0.0016 * amt).toFixed(5)} * uWind;
        transformed.z += sw * hg * hg * ${(0.0011 * amt).toFixed(5)} * uWind;`);
    };
    return mat;
  }

  // ---------------------------------------------------------------- geometry helpers
  const C = h => new THREE.Color(h);
  function paint(g, fn) { const p = g.attributes.position, n = g.attributes.normal, a = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) { fn(c, p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i)); a[i*3] = c.r; a[i*3+1] = c.g; a[i*3+2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; }
  function merge(geos) {
    let nv = 0, ni = 0; for (const g of geos) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni); let vo = 0, io = 0;
    for (const g of geos) { const cnt = g.attributes.position.count;
      pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3); col.set(g.attributes.color.array, vo * 3);
      if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo; io += g.index.count; } else { for (let i = 0; i < cnt; i++) idx[io + i] = vo + i; io += cnt; }
      vo += cnt; g.dispose(); }
    const m = new THREE.BufferGeometry(); m.setAttribute('position', new THREE.BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    m.setAttribute('color', new THREE.BufferAttribute(col, 3)); m.setIndex(new THREE.BufferAttribute(idx, 1)); m.computeBoundingSphere(); return m;
  }
  function blob(r, ws, hs, base, dark = .55, nz = .28) {
    const g = new THREE.SphereGeometry(r, ws, hs), p = g.attributes.position, v = new THREE.Vector3(), o = R(0, 99);
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); const n = v.clone().normalize(); const d = vnoise(n.x * 1.7 + o, n.y * 1.7, n.z * 1.7 + o) * .7 + vnoise(n.x * 4 + o, n.y * 4, n.z * 4) * .3;
      v.addScaledVector(n, d * r * nz); v.y *= .82; p.setXYZ(i, v.x, v.y, v.z); }
    g.computeVertexNormals();
    const b = C(base), hl = b.clone().offsetHSL(.01, .05, .07);
    return paint(g, (c, x, y, z, nx, ny) => { const t = (ny + 1) / 2; c.copy(b).lerp(hl, Math.max(0, ny) * .6).multiplyScalar(dark + (1 - dark) * t); });
  }
  function bark(g, hex = 0x4b3a2b) { const b = C(hex); return paint(g, (c, x, y, z, nx, ny, nz) => { c.copy(b).multiplyScalar(.75 + .35 * vnoise(x * 3, y * 6, z * 3) * .5 + .15 * Math.max(0, nx)); }); }
  function solid(g, hex) { const b = C(hex); return paint(g, c => c.copy(b)); }

  // ---------------------------------------------------------------- terrain
  const TS = 760, SEG = mobile ? 170 : 230;
  const tg = new THREE.PlaneGeometry(TS, TS, SEG, SEG); tg.rotateX(-Math.PI / 2);
  { const p = tg.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, height(p.getX(i), p.getZ(i))); tg.computeVertexNormals(); }
  const grassA = C(0x56743a), grassB = C(0x6b8a42), lawn = C(0x6f9445), forest = C(0x2d4426), dirt = C(0x6e5539), dirt2 = C(0x8a6d4b), rock = C(0x5b5a50);
  paint(tg, (c, x, y, z, nx, ny) => {
    const d1 = Math.hypot(x - S1.x, z - S1.y), d3 = Math.hypot(x - S3.x, z - S3.y), d4 = Math.hypot(x - S4.x, z - S4.y), md = Math.min(d1, d3, d4);
    const n = fbm(x * .05, z * .05, 3) * .5 + .5;
    c.copy(grassA).lerp(grassB, n);
    const lw = 1 - sstep(24, 40, Math.min(d1, d3)); c.lerp(lawn, lw * .7);
    if (lw > 0) c.multiplyScalar(1 + Math.sin(x * .9) * .035 * lw);                 // mowing stripes
    c.lerp(forest, sstep(42, 80, md) * .85);
    const dw = 1 - sstep(18, 32, d4); c.lerp(dirt, dw * (.65 + .35 * n)); c.lerp(dirt2, dw * Math.max(0, vnoise(x * .3, 1, z * .3)) * .5);
    c.lerp(rock, Math.max(0, .55 - ny) * 1.6);
  });
  const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  terrain.receiveShadow = true; scene.add(terrain);

  // ---------------------------------------------------------------- forest (instanced)
  const decid = merge([bark(new THREE.CylinderGeometry(.16, .3, 4.4, 6).translate(0, 2.2, 0)),
    blob(2.3, 9, 7, 0x3f6a33).translate(0, 5.6, 0), blob(1.8, 9, 7, 0x4a7638).translate(1.2, 4.8, .5),
    blob(1.7, 9, 7, 0x36602f).translate(-1.1, 5, -.6), blob(1.5, 8, 6, 0x4f7d3c).translate(.2, 7.1, .2)]);
  const conif = merge([bark(new THREE.CylinderGeometry(.1, .22, 3, 5).translate(0, 1.5, 0), 0x3b2c21),
    ...[[2.5, 3.4, 2.4], [2, 3.1, 4.4], [1.5, 2.8, 6.2], [.95, 2.4, 7.8]].map(([r, h, y]) => { const g = new THREE.ConeGeometry(r, h, 8, 2); g.translate(0, y, 0);
      const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const k = 1 + vnoise(p.getX(i) * 2, p.getY(i), p.getZ(i) * 2) * .14; p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); } g.computeVertexNormals();
      const b = C(0x24442c); return paint(g, (c, x, yy, z, nx, ny) => c.copy(b).multiplyScalar(.6 + .55 * Math.max(0, ny) + .12 * nx)); })]);
  const leafMat = windy(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .88, metalness: 0 }));
  const COUNT = mobile ? 1100 : 1700, insts = [[], []];
  const keep = (x, z) => Math.hypot(x - S1.x, z - S1.y) > 46 && Math.hypot(x - S3.x, z - S3.y) > 30 && Math.hypot(x - S4.x, z - S4.y) > 42;
  for (let i = 0; i < COUNT * 3 && insts[0].length + insts[1].length < COUNT; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 340, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!keep(x, z)) continue; const cl = fbm(x * .02, z * .02, 2); if (cl < -.25 && rnd() < .6) continue;
    insts[rnd() < .38 ? 1 : 0].push([x, z, R(.85, 1.55)]);
  }
  [[-32, -30, 1.4], [-20, -38, 1.5], [22, -34, 1.6], [36, -18, 1.3], [-44, 6, 1.4], [46, 22, 1.3], [64, 26, 1.4], [96, 60, 1.5], [88, 30, 1.2], [-78, 40, 1.5], [-118, 70, 1.4]]
    .forEach(([x, z, s], i) => insts[i % 3 === 0 ? 1 : 0].push([x, z, s]));
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  [decid, conif].forEach((g, k) => {
    const list = insts[k], im = new THREE.InstancedMesh(g, leafMat, list.length);
    list.forEach(([x, z, s], i) => { dummy.position.set(x, height(x, z) - .25, z); dummy.rotation.set(R(-.04, .04), R(0, 6.28), R(-.04, .04)); dummy.scale.set(s * R(.9, 1.1), s * R(.9, 1.2), s * R(.9, 1.1)); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
      const lv = R(.8, 1.08); tint.setRGB(lv * R(.92, 1.06), lv * R(.95, 1.05), lv * R(.85, 1)); im.setColorAt(i, tint); });
    im.castShadow = !mobile; im.receiveShadow = false; scene.add(im);
  });

  // ---------------------------------------------------------------- hero oak (leans toward the house)
  const barkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .95 });
  function bigTree(sc = 1, leafHex = 0x3f6b32, seedOff = 0) {
    const gs = [], fs = [], up = new THREE.Vector3(0, 1, 0);
    const tr = new THREE.CylinderGeometry(.55, .95, 8, 14, 8, false); tr.translate(0, 4, 0);
    { const p = tr.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setX(i, p.getX(i) + Math.sin(y * .35) * .22); p.setZ(i, p.getZ(i) + Math.cos(y * .28) * .12); } tr.computeVertexNormals(); }
    gs.push(bark(tr, 0x4d3b2b));
    const NB = 8;
    for (let i = 0; i < NB; i++) {
      const a = i / NB * Math.PI * 2 + R(-.3, .3), y0 = R(5.2, 7.6), len = R(4.6, 6.6), dir = new THREE.Vector3(Math.cos(a) * .82, R(.5, .85), Math.sin(a) * .82).normalize();
      const b = new THREE.CylinderGeometry(.13, .36, len, 8); b.translate(0, len / 2, 0); b.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir)); b.translate(Math.sin(y0 * .35) * .22, y0, 0); gs.push(bark(b, 0x4d3b2b));
      const end = dir.clone().multiplyScalar(len).add(new THREE.Vector3(0, y0, 0));
      for (let k = 0; k < 3; k++) fs.push(blob(R(2.0, 3.0), 14, 10, leafHex, .62).translate(end.x + R(-1.4, 1.4), end.y + R(-.4, 1.8), end.z + R(-1.4, 1.4)));
    }
    for (let k = 0; k < 9; k++) fs.push(blob(R(2.6, 3.8), 16, 12, leafHex, .62).translate(R(-3.4, 3.4), R(11, 14.5), R(-3.4, 3.4)));
    const grp = new THREE.Group();
    const bm = new THREE.Mesh(merge(gs), barkMat), fm = new THREE.Mesh(merge(fs), windy(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .86 }), .45));
    [bm, fm].forEach(m => { m.castShadow = true; m.receiveShadow = true; grp.add(m); }); grp.scale.setScalar(sc); return grp;
  }
  const oak = bigTree(1.12, 0x4f7d3a); oak.position.set(5, 0, 3); oak.rotation.set(0, .4, .075); scene.add(oak);

  // ---------------------------------------------------------------- house
  const house = new THREE.Group();
  const std = (hex, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: hex, roughness: .85 }, o));
  const add = (g, m, x, y, z, parent = house) => { const me = new THREE.Mesh(g, m); me.position.set(x, y, z); me.castShadow = true; me.receiveShadow = true; parent.add(me); return me; };
  add(new THREE.BoxGeometry(13, 5.6, 9.5), std(0xe7e0d0, { roughness: .9 }), 0, 2.8, 0);
  { const sh = new THREE.Shape(); sh.moveTo(-7.4, 0); sh.lineTo(0, 3.9); sh.lineTo(7.4, 0); sh.lineTo(-7.4, 0);
    const rg = new THREE.ExtrudeGeometry(sh, { depth: 10.6, bevelEnabled: false }); rg.translate(0, 0, -5.3); add(rg, std(0x34383d, { roughness: .7 }), 0, 5.6, 0); }
  add(new THREE.BoxGeometry(1.1, 3, 1.1), std(0x7a4a36), 3.6, 8.2, -1.5);
  const winMat = std(0xffc46b, { emissive: 0xffb54a, emissiveIntensity: 1.6, roughness: .4 });
  [[-4.3, 2.9], [4.3, 2.9], [-1.6, 2.9]].forEach(([x, y]) => add(new THREE.BoxGeometry(1.7, 1.5, .12), winMat, x, y, 4.78));
  [[-4.3, 2.9], [0, 2.9], [4.3, 2.9]].forEach(([x, y]) => add(new THREE.BoxGeometry(.12, 1.5, 1.7), winMat, 6.53, y, x * .7));
  add(new THREE.BoxGeometry(1.4, 2.6, .14), std(0x5a3a28), 1.6, 1.3, 4.8);
  add(new THREE.BoxGeometry(14, .25, 2.6), std(0x8c8478), 0, .12, 6.1);
  house.position.set(-15, 0, -5); house.rotation.y = .3; scene.add(house);
  { const dg = new THREE.PlaneGeometry(5.2, 30); dg.rotateX(-Math.PI / 2); const dw = new THREE.Mesh(dg, std(0x77746c, { roughness: 1 })); dw.position.set(-6, .06, 13); dw.rotation.y = .3; dw.receiveShadow = true; scene.add(dw); }

  // ---------------------------------------------------------------- storm site: fallen tree
  const storm = new THREE.Group(); storm.position.set(S3.x, 0, S3.y); scene.add(storm);
  { const gs = [], fs = [];
    const t = new THREE.CylinderGeometry(.42, .8, 17, 12, 6); t.rotateZ(Math.PI / 2 - .05); t.translate(0, .75, 0); gs.push(bark(t, 0x4a3a2c));
    const rp = new THREE.CylinderGeometry(2.6, 2.3, .9, 16, 1); rp.rotateZ(Math.PI / 2); rp.translate(8.8, 2, 0); gs.push(paint(rp, (c, x, y, z) => c.set(0x5e4632).multiplyScalar(.7 + .3 * (vnoise(y * 2, z * 2, 1) * .5 + .5))));
    for (let i = 0; i < 7; i++) { const b = new THREE.CylinderGeometry(.08, .2, R(2.5, 4.5), 6); b.rotateZ(R(-1.2, 1.2)); b.rotateX(R(-1.2, 1.2)); b.translate(R(-7, 6), R(.8, 1.8), R(-1.5, 1.5)); gs.push(bark(b, 0x4a3a2c)); }
    for (let i = 0; i < 9; i++) fs.push(blob(R(1.4, 2.6), 12, 9, 0x3d6430, .45).translate(R(-9.5, -2), R(.8, 2.4), R(-2.8, 2.8)));
    for (let i = 0; i < 12; i++) { const b = new THREE.CylinderGeometry(.05, .12, R(1.2, 2.6), 5); b.rotateZ(Math.PI / 2 + R(-.4, .4)); b.rotateY(R(0, 6.28)); b.translate(R(-12, 12), .15, R(-9, 9)); gs.push(bark(b, 0x54412f)); }
    const snag = new THREE.CylinderGeometry(.35, .62, 4.2, 10); snag.translate(9.5, 2.1, 3.8); gs.push(bark(snag, 0x463628));
    const bm = new THREE.Mesh(merge(gs), barkMat), fm = new THREE.Mesh(merge(fs), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9 }));
    [bm, fm].forEach(m => { m.castShadow = true; m.receiveShadow = true; storm.add(m); }); storm.rotation.y = -.5;
    const t2 = bigTree(.9, 0x3a6230); t2.position.set(-14, 0, -12); storm.add(t2);
    // fence the tree came down on
    const fm2 = std(0xd9d2c3); for (let i = 0; i < 14; i++) add(new THREE.BoxGeometry(.14, 1.3, .14), fm2, -12 + i * 2, .65, 7.5, storm);
    add(new THREE.BoxGeometry(26, .14, .1), fm2, 1, 1.1, 7.5, storm);
  }

  // ---------------------------------------------------------------- clearing site: stumps, brush, chipper, truck
  const clr = new THREE.Group(); clr.position.set(S4.x, 0, S4.y); scene.add(clr);
  { const gs = [], fs = [];
    for (let i = 0; i < 26; i++) { const a = R(0, 6.28), r = Math.sqrt(rnd()) * 22, x = Math.cos(a) * r, z = Math.sin(a) * r, rr = R(.28, .62);
      const s = new THREE.CylinderGeometry(rr, rr * 1.15, R(.3, .55), 10); s.translate(x, .2, z);
      gs.push(paint(s, (c, px, py, pz, nx, ny) => ny > .9 ? c.set(0xd2ae78) : c.set(0x4a3a2b).multiplyScalar(.8 + .3 * Math.random()))); }
    for (let k = 0; k < 4; k++) { const cx = R(-16, 16), cz = R(-16, -6); for (let i = 0; i < 6; i++) fs.push(blob(R(1.2, 2.2), 10, 8, 0x4c5a30, .45, .45).translate(cx + R(-2.4, 2.4), R(.4, 1.6), cz + R(-1.6, 1.6))); }
    for (let i = 0; i < 9; i++) { const l = new THREE.CylinderGeometry(.32, .36, 4.4, 10); l.rotateZ(Math.PI / 2); l.translate(10 + (i % 4) * 0 , .35 + Math.floor(i / 4) * .62, 6 + (i % 4) * .66 - Math.floor(i / 4) * .33);
      gs.push(paint(l, (c, x, y, z, nx) => Math.abs(nx) > .9 ? c.set(0xd4b07a) : c.set(0x4e3c2c))); }
    const bm = new THREE.Mesh(merge(gs), barkMat), fm = new THREE.Mesh(merge(fs), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .95 }));
    [bm, fm].forEach(m => { m.castShadow = true; m.receiveShadow = true; clr.add(m); });
    const yel = std(0xf2b20e, { roughness: .45, metalness: .1 }), blk = std(0x17191b, { roughness: .6 }), stl = std(0x3a3d40, { roughness: .5, metalness: .4 });
    const ch = new THREE.Group(); ch.position.set(-4, 0, 9); ch.rotation.y = -.7; clr.add(ch);
    add(new THREE.BoxGeometry(2.6, 1.5, 1.8), yel, 0, 1.25, 0, ch);
    add(new THREE.BoxGeometry(1.5, 1.1, 1.9), yel, -1.9, 1.35, 0, ch).rotation.z = .35;
    add(new THREE.BoxGeometry(1.4, .9, 1.7), stl, 1.6, 1.6, 0, ch);
    { const c = add(new THREE.CylinderGeometry(.28, .32, 2.6, 12), yel, 1.8, 2.9, 0, ch); c.rotation.z = -.55; }
    [[.2, 1.05], [.2, -1.05]].forEach(([x, z]) => { const w = add(new THREE.CylinderGeometry(.5, .5, .38, 18), blk, x, .5, z, ch); w.rotation.x = Math.PI / 2; });
    add(new THREE.BoxGeometry(2.4, .14, .14), stl, 2.8, .7, 0, ch);
    const tk = new THREE.Group(); tk.position.set(4.5, 0, 13); tk.rotation.y = -.7; clr.add(tk);
    const body = std(0x1f2a2f, { roughness: .35, metalness: .35 }), glass = std(0x1a2026, { roughness: .1, metalness: .6 });
    add(new THREE.BoxGeometry(5.6, 1.0, 2.1), body, 0, 1.0, 0, tk); add(new THREE.BoxGeometry(2.3, 1.0, 2.0), body, .6, 1.95, 0, tk);
    add(new THREE.BoxGeometry(2.0, .7, 2.04), glass, .6, 2.05, 0, tk);
    [[-1.9, 1.05], [-1.9, -1.05], [1.8, 1.05], [1.8, -1.05]].forEach(([x, z]) => { const w = add(new THREE.CylinderGeometry(.45, .45, .34, 18), blk, x, .45, z, tk); w.rotation.x = Math.PI / 2; });
  }

  // ---------------------------------------------------------------- sky, lights, rain
  const skyU = { top: { value: C(0x46679a) }, hor: { value: C(0xf2b77a) }, sunC: { value: C(0xffd2a0) }, sunDir: { value: new THREE.Vector3() }, flash: { value: 0 } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({ uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }',
    fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sunC; uniform vec3 sunDir; uniform float flash; varying vec3 vW;
      void main(){ vec3 d = normalize(vW - cameraPosition); float h = max(d.y, 0.);
        vec3 c = mix(hor, top, pow(h, .5)); float s = max(dot(d, normalize(sunDir)), 0.);
        c += sunC * (pow(s, 900.) * 6. + pow(s, 12.) * .45 + pow(s, 3.) * .12); c = mix(c, hor, smoothstep(0., -.08, d.y)); c += vec3(.75,.8,.95) * flash;
        gl_FragColor = vec4(c, 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  sky.renderOrder = -1; scene.add(sky);
  const hemi = new THREE.HemisphereLight(0xa9c0dc, 0x3a4a2a, .9); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd2a0, 2.6); sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048); const sc = sun.shadow.camera; sc.left = -48; sc.right = 48; sc.top = 48; sc.bottom = -48; sc.near = 1; sc.far = 400; sun.shadow.bias = -.0004; sun.shadow.normalBias = .04;
  scene.add(sun, sun.target);
  const RN = mobile ? 1600 : 2600, rp = new Float32Array(RN * 6), re = new Float32Array(RN * 2);
  for (let i = 0; i < RN; i++) { const x = R(-35, 35), y = R(0, 40), z = R(-35, 35); rp.set([x, y, z, x, y, z], i * 6); re[i * 2 + 1] = 1; }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3)); rg.setAttribute('aEnd', new THREE.BufferAttribute(re, 1));
  const rainU = { uTime: { value: 0 }, uOp: { value: 0 } };
  const rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({ uniforms: rainU, transparent: true, depthWrite: false, fog: false,
    vertexShader: 'uniform float uTime; attribute float aEnd; void main(){ vec3 p = position; p.y = mod(p.y - uTime * 26., 40.) - 12.; p.y += aEnd * 1.1; p.x += aEnd * .22; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.); }',
    fragmentShader: 'uniform float uOp; void main(){ gl_FragColor = vec4(.78,.84,.9, uOp * .45); }' }));
  rain.frustumCulled = false; scene.add(rain);

  // ---------------------------------------------------------------- moods (golden hour, storm, morning)
  const MOODS = [
    { top: 0x3d5f92, hor: 0xf0b07a, sunC: 0xffc98f, sunI: 3.1, sunDir: [.55, .3, -.78], hs: 0xb4c8e0, hg: 0x4a5a32, hI: 1.2, fog: 0xc79a7a, fd: .0040, exp: 1.05, wind: 1 },
    { top: 0x36404d, hor: 0x77808b, sunC: 0xa9b4c2, sunI: .95, sunDir: [-.3, .6, -.4], hs: 0x96a2b0, hg: 0x323b30, hI: 1.15, fog: 0x68727c, fd: .0062, exp: 1.0, wind: 3.2 },
    { top: 0x5b8fc6, hor: 0xf3d6ae, sunC: 0xfff0d2, sunI: 2.3, sunDir: [.55, .42, -.62], hs: 0xbad2ea, hg: 0x4a5a34, hI: .95, fog: 0xbfcbd0, fd: .0034, exp: 1.08, wind: .8 },
  ].map(m => ({ ...m, top: C(m.top), hor: C(m.hor), sunC: C(m.sunC), hs: C(m.hs), hg: C(m.hg), fog: C(m.fog), sunDir: new THREE.Vector3(...m.sunDir).normalize() }));
  const tmpC = new THREE.Color(), tmpV = new THREE.Vector3();
  function applyMood(m, flash) {
    const i = Math.min(1, Math.floor(m)), t = Math.min(1, m - i), a = MOODS[i], b = MOODS[i + 1];
    skyU.top.value.copy(a.top).lerp(b.top, t); skyU.hor.value.copy(a.hor).lerp(b.hor, t); skyU.sunC.value.copy(a.sunC).lerp(b.sunC, t); skyU.flash.value = flash * .9;
    tmpV.copy(a.sunDir).lerp(b.sunDir, t).normalize(); skyU.sunDir.value.copy(tmpV);
    sun.color.copy(a.sunC).lerp(b.sunC, t); sun.intensity = a.sunI + (b.sunI - a.sunI) * t;
    hemi.color.copy(a.hs).lerp(b.hs, t); hemi.groundColor.copy(a.hg).lerp(b.hg, t); hemi.intensity = a.hI + (b.hI - a.hI) * t + flash * 2.4;
    fog.color.copy(a.fog).lerp(b.fog, t); fog.density = a.fd + (b.fd - a.fd) * t;
    renderer.toneMappingExposure = a.exp + (b.exp - a.exp) * t; U.wind.value = a.wind + (b.wind - a.wind) * t;
    winMat.emissiveIntensity = 1.6 * (1 - Math.max(0, m - 1)) + .2;
    return tmpV;
  }

  // ---------------------------------------------------------------- shots
  const v = (x, y, z) => new THREE.Vector3(x, y, z), s3 = (x, y, z) => v(S3.x + x, y, S3.y + z), s4 = (x, y, z) => v(S4.x + x, y, S4.y + z);
  const SHOTS = [
    { a: [v(70, 96, 210), v(0, 6, 0)], b: [v(52, 70, 160), v(-2, 6, 0)] },                       // intro: aerial approach
    { a: [v(30, 3.2, 31), v(4, 9, 3)], b: [v(21, 2.6, 26), v(1, 10.5, 2)] },                       // 1 removal: low angle under the oak, house in frame
    { a: [v(27, 9, 21), v(4, 11, 3)], b: [v(22, 21, 17), v(3, 16, 2)] },                          // 2 trimming: rise up through the canopy
    { a: [s3(-14, 3.6, 15), s3(0, 1.2, 0)], b: [s3(-9, 2.8, 10), s3(2, 1.4, 0)] },                  // 3 storm: low, close, rain
    { a: [s4(34, 16, 36), s4(0, 0, 2)], b: [s4(22, 34, 26), s4(-2, 0, -2)] },                      // 4 clearing: aerial reveal at morning
  ];
  const END = [s4(28, 92, 120), s4(-10, 0, -20)];
  const ease = { io: t => t < .5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2, sine: t => -(Math.cos(Math.PI * t) - 1) / 2 };
  const P = v(0, 0, 0), L = v(0, 0, 0);
  function pose(p) {
    let roll = 0, fovK = 0, mood = 0, flash = 0;
    const hold = (sh, u) => { const e = ease.sine(u); P.lerpVectors(sh.a[0], sh.b[0], e); L.lerpVectors(sh.a[1], sh.b[1], e); };
    const swoop = (from, to, t, k) => { const e = ease.io(t), lift = Math.sin(Math.PI * e); P.lerpVectors(from[0], to[0], e); P.y += lift * 34; L.lerpVectors(from[1], to[1], e); L.y += lift * 8;
      roll = Math.sin(Math.PI * e) * (k % 2 ? .16 : -.16); fovK = Math.sin(Math.PI * Math.min(1, t * 1.15)); };
    if (p < IH) hold(SHOTS[0], p / IH);
    else {
      let done = false;
      for (let k = 0; k < N; k++) {
        const t0 = IH + k * (TL + HL), h0 = t0 + TL, h1 = h0 + HL;
        if (p < h0) { swoop(SHOTS[k].b, SHOTS[k + 1].a, (p - t0) / TL, k); if (k === 2) mood = (p - t0) / TL; if (k === 3) mood = 1 + (p - t0) / TL; if (k > 3) mood = 2; done = true; break; }
        if (p < h1) { const u = (p - h0) / HL; hold(SHOTS[k + 1], u); mood = k === 2 ? 1 : k === 3 ? 2 : 0; if (k === 2) flash = Math.max(0, 1 - Math.abs(u - .1) / .025) + .6 * Math.max(0, 1 - Math.abs(u - .16) / .015); done = true; break; }
      }
      if (!done) { const t0 = IH + N * (TL + HL), t = Math.min(1, (p - t0) / (1 - t0)), e = ease.sine(t); P.lerpVectors(SHOTS[N].b[0], END[0], e); L.lerpVectors(SHOTS[N].b[1], END[1], e); mood = 2; }
    }
    return { roll, fovK, mood, flash };
  }

  // ---------------------------------------------------------------- loop
  const cp = v(70, 96, 210), cl = v(0, 6, 0); let cRoll = 0, cFov = 0, last = performance.now(), running = false, raf = 0, W = 0, H = 0;
  function resize() { const w = stage.clientWidth, h = stage.clientHeight; if (w === W && h === H) return; W = w; H = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  function frame(now) {
    raf = requestAnimationFrame(frame); const dt = Math.min(.05, (now - last) / 1000); last = now; U.time.value += dt; rainU.uTime.value = U.time.value;
    resize();
    const p = getP(), st = pose(p), k = 1 - Math.exp(-dt * 6.5);
    cp.lerp(P, k); cl.lerp(L, k); cRoll += (st.roll - cRoll) * k; cFov += (st.fovK - cFov) * k;
    const baseFov = camera.aspect < 1 ? 62 : 46; camera.fov = baseFov + cFov * 20; camera.updateProjectionMatrix();
    camera.position.copy(cp); const gy = height(cp.x, cp.z) + 1.2; if (camera.position.y < gy) camera.position.y = gy;
    camera.lookAt(cl); camera.rotateZ(cRoll);
    const sd = applyMood(Math.max(0, Math.min(2, st.mood)), st.flash);
    sun.target.position.copy(cl); sun.position.copy(cl).addScaledVector(sd, 160); sky.position.copy(camera.position);
    rain.position.copy(camera.position); rainU.uOp.value = Math.max(0, 1 - Math.abs(st.mood - 1) * 1.6);
    renderer.render(scene, camera);
  }
  function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  // first frame snaps to the current pose
  { const st = pose(getP()); cp.copy(P); cl.copy(L); resize(); }
  return { start, stop };
}
