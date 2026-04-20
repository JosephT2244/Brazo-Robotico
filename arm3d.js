/* ══════════════════════════════════ ══════════════
   arm3d.js — RoboArm IPN 3D v15 · Three.js r128
   ────────────────────────────────────────────────────────────────
   Análisis visual de la imagen de referencia:

   BASE:
   • Placa inf. roja plana (~29×29 cm), 4 agujeros negros en esquinas
   • Placa sup. roja (~25×25 cm), mismos agujeros, rodamiento central
   • Bracket en U rojo: paredes verticales gruesas, servo negro vertical

   HOMBRO:
   • Servo negro montado lateralmente visible
   • Dos chapas rojas en L a los lados
   • Rodamiento circular plateado en el lateral izquierdo

   BRAZO SUPERIOR (arm1):
   • Marco rectangular ABIERTO (4 tubos en las aristas)
   • Servo negro encima del marco, extremo del hombro
   • Tubos de sección cuadrada, no redonda

   CODO:
   • Dos chapas rojas articuladas
   • Servo negro visible

   ANTEBRAZO (arm2):
   • Marco idéntico a arm1 pero más corto
   • Servo negro encima, extremo frontal

   MUÑECA:
   • Bloque rojo compacto
   • Engranaje blanco grande con dientes finos
   • Piñón pequeño gris

   PINZA:
   • Cuerpo rojo rectangular
   • Dos garras plateadas/gris con agujeros circulares
   • Puntas que convergen hacia delante

   Canales: CH4=Base · CH3=Hombro · CH2=Codo · CH1=Muñeca · CH0=Pinza
   ══════════════════════════════════ ══════════════ */

const c3   = document.getElementById('three-canvas');
const vpEl = document.getElementById('vp');

/* ─── Renderer ─────────────────────────────────────────────── */
const renderer = new THREE.WebGLRenderer({
  canvas: c3, antialias: true, powerPreference: 'high-performance'
});
renderer.shadowMap.enabled   = true;
renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputEncoding      = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xECE6DC);

const cam3 = new THREE.PerspectiveCamera(34, 1, 0.1, 60);

/* ─── Iluminación ──────────────────────────────────────────── */
scene.add(new THREE.AmbientLight(0xF8F0E8, 0.70));

const sunL = new THREE.DirectionalLight(0xFFFDF0, 1.82);
sunL.position.set(8, 14, 7);
sunL.castShadow = true;
sunL.shadow.mapSize.width = sunL.shadow.mapSize.height = 1024;
sunL.shadow.camera.near = 0.5; sunL.shadow.camera.far = 30;
sunL.shadow.camera.left = sunL.shadow.camera.bottom = -7;
sunL.shadow.camera.right= sunL.shadow.camera.top   =  7;
sunL.shadow.bias = -0.0004;
scene.add(sunL);

const rimL = new THREE.DirectionalLight(0xFFCC40, 0.40);
rimL.position.set(-7, 4, -4);
scene.add(rimL);

const fillL = new THREE.DirectionalLight(0xB0C8FF, 0.15);
fillL.position.set(-3, 1, 6);
scene.add(fillL);

const glowL = new THREE.PointLight(0x8C1020, 0.40, 12);
glowL.position.set(0, 4, 5);
scene.add(glowL);

/* ─── Suelo ────────────────────────────────────────────────── */
const gridH = new THREE.GridHelper(20, 40, 0xC6B8A6, 0xDBD0C0);
gridH.material.opacity = 0.38;
gridH.material.transparent = true;
scene.add(gridH);

const gndMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ color: 0xE2D6C6, roughness: 0.93, metalness: 0.01 })
);
gndMesh.rotation.x = -Math.PI / 2;
gndMesh.receiveShadow = true;
scene.add(gndMesh);

/* ─── Paleta de materiales ─────────────────────────────────── */
const MAT = {
  /* Rojo vivo del cuerpo estructural */
  red:  new THREE.MeshStandardMaterial({ color: 0xC2131C, metalness: 0.04, roughness: 0.46 }),
  rdx:  new THREE.MeshStandardMaterial({ color: 0x9E0D14, metalness: 0.06, roughness: 0.52 }),
  /* Servo negro MG995 */
  sbk:  new THREE.MeshStandardMaterial({ color: 0x141210, metalness: 0.28, roughness: 0.55 }),
  stp:  new THREE.MeshStandardMaterial({ color: 0x0C0A08, metalness: 0.50, roughness: 0.18 }),
  sea:  new THREE.MeshStandardMaterial({ color: 0x3A3430, metalness: 0.18, roughness: 0.72 }),
  syl:  new THREE.MeshStandardMaterial({ color: 0xCC8C10, metalness: 0.02, roughness: 0.90 }),
  /* Engranaje blanco */
  gear: new THREE.MeshStandardMaterial({ color: 0xDCDCE4, metalness: 0.18, roughness: 0.44 }),
  /* Garras plateadas */
  slv:  new THREE.MeshStandardMaterial({ color: 0xACACC0, metalness: 0.75, roughness: 0.24 }),
  slvd: new THREE.MeshStandardMaterial({ color: 0x808090, metalness: 0.80, roughness: 0.30 }),
  /* Cromado (tornillos, ejes) */
  chr:  new THREE.MeshStandardMaterial({ color: 0x1E1E28, metalness: 0.92, roughness: 0.08 }),
  /* Rodamiento plateado */
  brn:  new THREE.MeshStandardMaterial({ color: 0xC4C0C0, metalness: 0.88, roughness: 0.12 }),
  /* Goma agarre */
  rub:  new THREE.MeshStandardMaterial({ color: 0x181412, metalness: 0.01, roughness: 0.98 }),
};

/* ─── Helpers ──────────────────────────────────────────────── */
function mk(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}
function box(w, h, d, mat)        { return mk(new THREE.BoxGeometry(w, h, d), mat); }
function cyl(rt, rb, h, s, mat)   { return mk(new THREE.CylinderGeometry(rt, rb, h, s), mat); }
function trs(R, r, mat, ts, rs)   { return mk(new THREE.TorusGeometry(R, r, ts||10, rs||26), mat); }
function cone(r, h, s, mat)       { return mk(new THREE.ConeGeometry(r, h, s, 1), mat); }

function place(parent, obj, x, y, z, rx, ry, rz) {
  if (x !== undefined) obj.position.set(x, y||0, z||0);
  if (rx !== undefined) obj.rotation.set(rx, ry||0, rz||0);
  parent.add(obj);
  return obj;
}

function group(parent, x, y, z) {
  const g = new THREE.Group();
  if (x !== undefined) g.position.set(x, y||0, z||0);
  if (parent) parent.add(g);
  return g;
}

/* ─── Servo MG995 helper ────────────────────────────────────
   Cuerpo negro ~42×21×44mm. Hub de salida en +Y.
   ─────────────────────────────────────────────────────────── */
function servo(parent, x, y, z, rx, ry, rz) {
  const g = group(parent, x, y, z);
  if (rx !== undefined) g.rotation.set(rx, ry||0, rz||0);

  place(g, box(0.425, 0.622, 0.212, MAT.sbk));                      // cuerpo
  place(g, box(0.380, 0.070, 0.192, MAT.stp),   0, 0.342,  0);     // tapa brillante
  place(g, box(0.515, 0.052, 0.226, MAT.sea),   0, 0.358,  0);     // orejeta sup
  place(g, box(0.515, 0.052, 0.226, MAT.sea),   0,-0.358,  0);     // orejeta inf
  [-0.198, 0.198].forEach(dx => {
    place(g, cyl(0.018,0.018,0.066,7,MAT.chr), dx,  0.358, 0);     // tornillos
    place(g, cyl(0.018,0.018,0.066,7,MAT.chr), dx, -0.358, 0);
  });
  place(g, box(0.280, 0.098, 0.013, MAT.syl),  0, 0.052,  0.106); // sticker amarillo
  place(g, cyl(0.072,0.072,0.048,13,MAT.chr),  0, 0.458,  0);     // hub
  place(g, cyl(0.046,0.046,0.038, 9,MAT.brn),  0, 0.482,  0);     // bearing hub
  place(g, box(0.215, 0.009, 0.023, MAT.brn),  0, 0.497,  0);     // horn H
  place(g, box(0.023, 0.009, 0.190, MAT.brn),  0, 0.497,  0);     // horn V
  return g;
}

/* ══════════════════════════════════ ══════════
   BASE ESTÁTICA
   ══════════════════════════════════ ══════════ */

// Placa inferior
place(scene, box(2.92, 0.094, 2.92, MAT.red), 0, 0.047, 0);
// Placa superior
place(scene, box(2.52, 0.084, 2.52, MAT.rdx), 0, 0.197, 0);

// Agujeros de montaje — 4 esquinas por placa
[{ r:1.10, y:0.047 }, { r:0.94, y:0.197 }].forEach(({ r, y }) => {
  for (let i = 0; i < 4; i++) {
    const a = i/4 * Math.PI*2 + Math.PI/4;
    const h = cyl(0.062, 0.062, 0.110, 10, MAT.chr);
    h.position.set(Math.cos(a)*r, y, Math.sin(a)*r);
    scene.add(h);
  }
});

// Postes separadores
for (let i = 0; i < 4; i++) {
  const a = i/4 * Math.PI*2 + Math.PI/4;
  place(scene, cyl(0.035,0.035,0.122,7,MAT.slvd),
    Math.cos(a)*0.80, 0.120, Math.sin(a)*0.80);
}

// Eje central
place(scene, cyl(0.070,0.070,0.280,11,MAT.chr), 0, 0.120, 0);

// Rodamiento central visible
const bBase = trs(0.112, 0.020, MAT.brn);
bBase.position.set(0, 0.200, 0);
scene.add(bBase);
place(scene, cyl(0.066, 0.066, 0.028, 16, MAT.brn), 0, 0.200, 0);

/* ══════════════════════════════════ ══════════
   GRUPO GIRATORIO — baseG  (CH4 / J.base)
   ══════════════════════════════════ ══════════ */
const baseG = group(scene, 0, 0.214, 0);

// Bracket en U — paredes gruesas que dan rigidez (más prominente)
place(baseG, box(0.700, 0.780, 0.078, MAT.red),    0,  0.368, -0.310); // pared trasera
place(baseG, box(0.078, 0.780, 0.680, MAT.red),  -0.314,0.368,  0);    // lateral izq
place(baseG, box(0.078, 0.780, 0.680, MAT.rdx),   0.314,0.368,  0);    // lateral der
place(baseG, box(0.700, 0.058, 0.680, MAT.rdx),   0, -0.022,    0);    // base

// Tornillos visibles en las paredes del bracket
[-0.290, 0.290].forEach(dx => {
  [0.10, 0.58].forEach(z => {
    place(baseG, cyl(0.020,0.020,0.090,8,MAT.chr), dx, 0.368, z - 0.300);
  });
});

// Servo de rotación de base (negro vertical, más centrado)
servo(baseG, 0, 0.360, 0.048);

// Plataforma de transición al hombro (más ancha)
place(baseG, box(0.740, 0.060, 0.710, MAT.red),  0, 0.808, 0);
place(baseG, box(0.560, 0.054, 0.540, MAT.rdx),  0, 0.892, 0);
place(baseG, cyl(0.128,0.128,0.148,14,MAT.red),  0, 0.996, 0);

/* ─── Articulación hombro ───────────────────────────────── */
const shoP = group(baseG, 0, 1.108, 0);
const shoG = group(shoP);

// Eje horizontal del hombro
const shoAxle = cyl(0.046, 0.046, 0.800, 9, MAT.slvd);
shoAxle.rotation.z = Math.PI / 2;
shoG.add(shoAxle);

// Rodamiento lateral izquierdo — muy visible, grande
const bShoOut = cyl(0.108, 0.108, 0.064, 18, MAT.brn);
bShoOut.rotation.z = Math.PI / 2;
bShoOut.position.set(-0.370, 0, 0);
shoG.add(bShoOut);

const bShoIn = cyl(0.072, 0.072, 0.072, 12, MAT.chr);
bShoIn.rotation.z = Math.PI / 2;
bShoIn.position.set(-0.370, 0, 0);
shoG.add(bShoIn);

const bShoR = trs(0.100, 0.020, MAT.slv);
bShoR.rotation.y = Math.PI / 2;
bShoR.position.set(-0.370, 0, 0);
shoG.add(bShoR);

// Rodamiento derecho más pequeño (tapa)
const bShoRR = cyl(0.078, 0.078, 0.048, 14, MAT.brn);
bShoRR.rotation.z = Math.PI / 2;
bShoRR.position.set(0.370, 0, 0);
shoG.add(bShoRR);

// Chapas laterales en L (más anchas para coincidir con el bracket)
place(shoG, box(0.062, 0.480, 0.360, MAT.red), -0.352, 0.020, 0.010);
place(shoG, box(0.062, 0.480, 0.360, MAT.red),  0.352, 0.020, 0.010);

// Servo de hombro (CH3) — visible lateralmente
servo(shoG, 0.050, 0.036, 0.020);

/* ══════════════════════════════════ ══════════
   BRAZO SUPERIOR — arm1 (marco rectangular abierto)
   4 tubos en las aristas + travesaños + servo encima
   ══════════════════════════════════ ══════════ */
const arm1 = group(shoG);

const A1W = 0.360, A1H = 0.218, A1L = 1.990, A1T = 0.055;

// 4 rieles longitudinales (en cada arista del rectángulo)
place(arm1, box(A1T, A1T, A1L, MAT.red),  -A1W/2,  A1H/2, A1L/2);
place(arm1, box(A1T, A1T, A1L, MAT.red),   A1W/2,  A1H/2, A1L/2);
place(arm1, box(A1T, A1T, A1L, MAT.rdx), -A1W/2, -A1H/2, A1L/2);
place(arm1, box(A1T, A1T, A1L, MAT.rdx),  A1W/2, -A1H/2, A1L/2);

// Travesaños + montantes en 4 nodos
[0, A1L*0.36, A1L*0.72, A1L].forEach(z => {
  place(arm1, box(A1W+A1T, A1T, A1T, MAT.red),    0,  A1H/2, z);
  place(arm1, box(A1W+A1T, A1T, A1T, MAT.rdx),   0, -A1H/2, z);
  place(arm1, box(A1T, A1H+A1T, A1T, MAT.red), -A1W/2, 0, z);
  place(arm1, box(A1T, A1H+A1T, A1T, MAT.red),  A1W/2, 0, z);
});

// Servo negro encima del marco, extremo del hombro
servo(arm1, 0.055, A1H/2 + 0.337, 0.352);

/* ─── Articulación codo ─────────────────────────────────── */
const elbP = group(arm1, 0, 0, A1L);
const elbG = group(elbP);

const elbAxle = cyl(0.042, 0.042, 0.638, 9, MAT.slvd);
elbAxle.rotation.z = Math.PI / 2;
elbG.add(elbAxle);

place(elbG, box(0.056, 0.376, 0.300, MAT.red), -0.266, 0, 0.058);
place(elbG, box(0.056, 0.376, 0.300, MAT.red),  0.266, 0, 0.058);

servo(elbG, 0, 0.026, 0.108);

/* ══════════════════════════════════ ══════════
   ANTEBRAZO — arm2 (marco más corto)
   ══════════════════════════════════ ══════════ */
const arm2 = group(elbG);

const A2W = 0.308, A2H = 0.182, A2L = 1.355, A2T = 0.050;

place(arm2, box(A2T, A2T, A2L, MAT.red),  -A2W/2,  A2H/2, A2L/2);
place(arm2, box(A2T, A2T, A2L, MAT.red),   A2W/2,  A2H/2, A2L/2);
place(arm2, box(A2T, A2T, A2L, MAT.rdx), -A2W/2, -A2H/2, A2L/2);
place(arm2, box(A2T, A2T, A2L, MAT.rdx),  A2W/2, -A2H/2, A2L/2);

[0, A2L*0.42, A2L].forEach(z => {
  place(arm2, box(A2W+A2T, A2T, A2T, MAT.red),    0,  A2H/2, z);
  place(arm2, box(A2W+A2T, A2T, A2T, MAT.rdx),   0, -A2H/2, z);
  place(arm2, box(A2T, A2H+A2T, A2T, MAT.red), -A2W/2, 0, z);
  place(arm2, box(A2T, A2H+A2T, A2T, MAT.red),  A2W/2, 0, z);
});

// Servo de muñeca encima, extremo frontal
servo(arm2, 0.052, A2H/2 + 0.250, A2L - 0.186);

/* ─── Articulación muñeca ───────────────────────────────── */
const wriP = group(arm2, 0, 0, A2L);
const wriG = group(wriP);

// Bloque rojo compacto de muñeca (más fiel a imagen real)
place(wriG, box(0.340, 0.260, 0.110, MAT.red),   0,  0,    0.054);
place(wriG, box(0.360, 0.060, 0.118, MAT.rdx),   0,  0.150, 0.054);
place(wriG, box(0.360, 0.060, 0.118, MAT.rdx),   0, -0.150, 0.054);

// Collar central
const wc1 = cyl(0.150, 0.166, 0.310, 18, MAT.red);
wc1.rotation.x = Math.PI / 2;
wriG.add(wc1);

const wc2 = cyl(0.118, 0.126, 0.320, 16, MAT.sbk);
wc2.rotation.x = Math.PI / 2;
wriG.add(wc2);

/* ═══ ENGRANAJE GRANDE (blanco — elemento más icónico, mayor) ═══ */
const gDisc = cyl(0.270, 0.270, 0.046, 40, MAT.gear);
gDisc.rotation.x = Math.PI / 2;
wriG.add(gDisc);

// Aro exterior ligeramente más oscuro (profundidad visual)
const gRim = trs(0.258, 0.016, MAT.slvd);
gRim.rotation.y = Math.PI / 2;
wriG.add(gRim);

// 30 dientes anchos
for (let i = 0; i < 30; i++) {
  const a = i/30 * Math.PI*2;
  const t = box(0.034, 0.040, 0.046, MAT.gear);
  t.position.set(Math.cos(a)*0.277, Math.sin(a)*0.277, 0);
  t.rotation.z = a;
  wriG.add(t);
}

// Hub central
const gHub1 = cyl(0.072, 0.072, 0.064, 14, MAT.chr);
gHub1.rotation.x = Math.PI / 2; wriG.add(gHub1);

const gHub2 = cyl(0.044, 0.044, 0.072, 10, MAT.slvd);
gHub2.rotation.x = Math.PI / 2; wriG.add(gHub2);

// 6 agujeros de aligeramiento (bien separados)
for (let i = 0; i < 6; i++) {
  const a = i/6 * Math.PI*2;
  const h = cyl(0.034, 0.034, 0.054, 10, MAT.chr);
  h.rotation.x = Math.PI / 2;
  h.position.set(Math.cos(a)*0.178, Math.sin(a)*0.178, 0);
  wriG.add(h);
}

// Piñón de accionamiento (servo → engranaje)
const pn1 = cyl(0.062, 0.062, 0.040, 14, MAT.gear);
pn1.rotation.x = Math.PI / 2; pn1.position.set(0.230, 0.210, 0); wriG.add(pn1);

const pn2 = cyl(0.030, 0.030, 0.056, 9, MAT.chr);
pn2.rotation.x = Math.PI / 2; pn2.position.set(0.230, 0.210, 0); wriG.add(pn2);

for (let i = 0; i < 10; i++) {
  const a = i/10 * Math.PI*2;
  const pt = box(0.020, 0.022, 0.040, MAT.gear);
  pt.position.set(0.230 + Math.cos(a)*0.065, 0.210 + Math.sin(a)*0.065, 0);
  pt.rotation.z = a;
  wriG.add(pt);
}

/* ══════════════════════════════════ ══════════════
   PINZA — gripR  (CH0 / J.grip)
   Rediseñada para coincidir con las imágenes de referencia:
   • Cuerpo rojo rectangular compacto
   • Engranaje pequeño integrado al frente del cuerpo
   • Dos garras plateadas con agujero circular grande visible
   ══════════════════════════════════ ══════════ */
const gripR = group(wriG, 0, 0, 0.260);

// Cuerpo rojo principal — bloque rectangular sólido
place(gripR, box(0.310, 0.240, 0.260, MAT.red),   0,  0.000,  0.130);
place(gripR, box(0.330, 0.044, 0.270, MAT.rdx),   0,  0.152,  0.130);  // tapa sup
place(gripR, box(0.330, 0.044, 0.270, MAT.rdx),   0, -0.152,  0.130);  // tapa inf
place(gripR, box(0.310, 0.244, 0.024, MAT.rdx),   0,  0.000,  0.012);  // cara frontal

// Engranaje de accionamiento de la pinza (visible al frente, grande)
const gpD = cyl(0.090, 0.090, 0.036, 18, MAT.gear);
gpD.rotation.x = Math.PI / 2;
gpD.position.set(0, 0.115, 0.295);
gripR.add(gpD);

const gpH = cyl(0.034, 0.034, 0.044, 10, MAT.chr);
gpH.rotation.x = Math.PI / 2;
gpH.position.set(0, 0.115, 0.295);
gripR.add(gpH);

for (let i = 0; i < 12; i++) {
  const a = i/12 * Math.PI*2;
  const dt = box(0.022, 0.024, 0.036, MAT.gear);
  dt.position.set(Math.cos(a)*0.095, Math.sin(a)*0.095 + 0.115, 0.295);
  dt.rotation.z = a;
  gripR.add(dt);
}

// Pin de articulación central horizontal
place(gripR, box(0.012, 0.294, 0.016, MAT.slvd), 0, 0, 0.316);

/* ─── Mandíbulas (garras plateadas con agujero grande, fiel a imagen) ─── */
const jaw1 = group(gripR);
const jaw2 = group(gripR);

[jaw1, jaw2].forEach((jg, ji) => {
  const s = ji === 0 ? 1 : -1;

  // Bloque base de la garra (se desliza con la apertura)
  place(jg, box(0.256, 0.048, 0.095, MAT.slvd), 0, s*0.096, 0.310);

  // Brazo principal — sección recta larga
  const armB = box(0.200, 0.066, 0.340, MAT.slv);
  armB.position.set(0, s*0.048, 0.495);
  jg.add(armB);

  // Tramo angulado convergente (hacia el centro)
  const seg1 = box(0.174, 0.060, 0.280, MAT.slv);
  seg1.position.set(0, s*0.034, 0.736);
  seg1.rotation.x = s * 0.22;
  jg.add(seg1);

  // Tramo final (punta convergente)
  const seg2 = box(0.130, 0.052, 0.210, MAT.slvd);
  seg2.position.set(0, s*0.014, 0.912);
  seg2.rotation.x = s * 0.50;
  jg.add(seg2);

  // Punta cónica de 5 lados (fiel a la imagen)
  const tgeo = new THREE.ConeGeometry(0.052, 0.240, 5, 1);
  const tip  = new THREE.Mesh(tgeo, MAT.slvd);
  tip.castShadow = true;
  tip.rotation.x = -s * Math.PI/2 + s * 0.30;
  tip.position.set(0, s*0.004, 1.008);
  jg.add(tip);

  // ── Agujero grande circular (sello visual más distintivo del brazo) ──
  const hMain = cyl(0.048, 0.048, 0.072, 14, MAT.chr);
  hMain.rotation.z = Math.PI / 2;
  hMain.position.set(0, s*0.048, 0.498);
  jg.add(hMain);

  // Agujero secundario (cerca de punta)
  const hTip = cyl(0.034, 0.034, 0.064, 12, MAT.chr);
  hTip.rotation.z = Math.PI / 2;
  hTip.position.set(0, s*0.036, 0.698);
  jg.add(hTip);

  // Eje/pivot de articulación
  const pin = cyl(0.024, 0.024, 0.264, 8, MAT.slvd);
  pin.rotation.z = Math.PI / 2;
  pin.position.set(0, s*0.006, 0.064);
  jg.add(pin);

  // Ranura de guía (cara interior)
  place(jg, box(0.200, 0.012, 0.320, MAT.rub), 0, -s*0.016, 0.490);
  for (let k = 0; k < 5; k++) {
    place(jg, box(0.200, 0.010, 0.016, MAT.slvd), 0, -s*0.016, 0.380 + k*0.060);
  }
});

/* ══════════════════════════════════ CINEMÁTICA — servos de velocidad ══════════════════════════════════
   J[key].v = segundos restantes (+/-). Mientras != 0, el ángulo visual se acumula. */
const _va = { base: 0, sho: 0, elb: 0, wri: 0 };
let _vaT  = performance.now();
const VIS_SPD = 1.4;  // rad/s de giro visual al estar activo

function _tickVA() {
  const now = performance.now();
  const dt  = Math.min((now - _vaT) / 1000, 0.05);
  _vaT = now;
  if (J.base.v !== 0) _va.base += Math.sign(J.base.v) * VIS_SPD * dt;
  if (J.sho.v  !== 0) _va.sho  += Math.sign(J.sho.v)  * VIS_SPD * dt;
  if (J.elb.v  !== 0) _va.elb  += Math.sign(J.elb.v)  * VIS_SPD * dt;
  if (J.wri.v  !== 0) _va.wri  += Math.sign(J.wri.v)  * VIS_SPD * dt;
}

function _applyVA() {
  baseG.rotation.y = _va.base;
  shoG.rotation.x  = _va.sho;
  elbG.rotation.x  = _va.elb;
  wriG.rotation.z  = _va.wri;
  const gp = J.grip.v > 0 ? 0.115 : J.grip.v < 0 ? 0 : jaw1.position.y;
  jaw1.position.y =  gp;
  jaw2.position.y = -gp;
}

function applyArm() { _tickVA(); _applyVA(); }

/* ─── Órbita de cámara suavizada ───────────────────────── */
let _drag = false, _lx = 0, _ly = 0;
let _th = 0.72, _ph = 0.40, _r = 9.6;
let _tx = 0.72, _ty = 0.40;
const lookTgt = new THREE.Vector3(0, 1.30, 1.10);

c3.addEventListener('mousedown',  e => { _drag=true; _lx=e.clientX; _ly=e.clientY; });
document.addEventListener('mouseup',    () => _drag = false);
document.addEventListener('mousemove',  e => {
  if (!_drag) return;
  _tx -= (e.clientX - _lx) * 0.005; _lx = e.clientX;
  _ty  = clamp(_ty - (e.clientY - _ly) * 0.004, 0.04, 1.42); _ly = e.clientY;
});
c3.addEventListener('wheel', e => {
  _r = clamp(_r + e.deltaY * 0.012, 3, 22);
}, { passive: true });
c3.addEventListener('touchstart', e => {
  _lx = e.touches[0].clientX; _ly = e.touches[0].clientY;
}, { passive: true });
c3.addEventListener('touchmove', e => {
  _tx -= (e.touches[0].clientX - _lx) * 0.005; _lx = e.touches[0].clientX;
  _ty  = clamp(_ty - (e.touches[0].clientY - _ly) * 0.004, 0.04, 1.42); _ly = e.touches[0].clientY;
}, { passive: true });

function resize3d() {
  const w = vpEl.clientWidth, h = vpEl.clientHeight;
  renderer.setSize(w, h, false);
  cam3.aspect = w / h;
  cam3.updateProjectionMatrix();
}
resize3d();
window.addEventListener('resize', resize3d);

/* ─── Loop de renderizado ───────────────────────────────── */
function loop3d() {
  requestAnimationFrame(loop3d);
  _tickVA(); _applyVA();  // animar continuamente mientras servos activos
  _th += (_tx - _th) * 0.12;
  _ph += (_ty - _ph) * 0.12;
  cam3.position.set(
    _r * Math.sin(_th) * Math.cos(_ph),
    _r * Math.sin(_ph),
    _r * Math.cos(_th) * Math.cos(_ph)
  );
  cam3.lookAt(lookTgt);
  glowL.intensity = 0.32 + 0.14 * Math.sin(Date.now() * 0.0018);
  renderer.render(scene, cam3);
}

loop3d();
applyArm();
refreshUI();
log('RoboArm IPN v16 — modelo 3D actualizado', 'ok');
log('CH0=Pinza · CH1=Muñeca · CH2=Codo · CH3=Hombro · CH4=Base', 'info');
