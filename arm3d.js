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
// PCFSoftShadowMap + mapa 1024 era el bottleneck de GPU en máquinas
// modestas. PCF normal se ve prácticamente igual y corre al doble.
renderer.shadowMap.type      = THREE.PCFShadowMap;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
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
sunL.shadow.mapSize.width = sunL.shadow.mapSize.height = 512;
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
// Crea una malla con sombras activadas, que es el caso común del modelo.
function mk(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}
function box(w, h, d, mat)        { return mk(new THREE.BoxGeometry(w, h, d), mat); }
function cyl(rt, rb, h, s, mat)   { return mk(new THREE.CylinderGeometry(rt, rb, h, s), mat); }
function trs(R, r, mat, ts, rs)   { return mk(new THREE.TorusGeometry(R, r, ts||10, rs||26), mat); }
function cone(r, h, s, mat)       { return mk(new THREE.ConeGeometry(r, h, s, 1), mat); }

// Posiciona y rota una pieza antes de anexarla al grupo padre.
function place(parent, obj, x, y, z, rx, ry, rz) {
  if (x !== undefined) obj.position.set(x, y||0, z||0);
  if (rx !== undefined) obj.rotation.set(rx, ry||0, rz||0);
  parent.add(obj);
  return obj;
}

// Agrupa subconjuntos mecánicos para luego rotarlos como una articulación.
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

function roundedPlate(parent, w, h, d, r, mat, x, y, z) {
  const g = group(parent, x, y, z);
  place(g, box(w - 2*r, h, d, mat));
  place(g, box(w, h, d - 2*r, mat));
  [-1, 1].forEach(sx => {
    [-1, 1].forEach(sz => {
      place(g, cyl(r, r, h, 18, mat), sx * (w/2 - r), 0, sz * (d/2 - r));
    });
  });
  return g;
}

// Los agujeros se modelan como cilindros cromados visibles, no como booleanos.
function addHole(parent, x, y, z, r, h) {
  place(parent, cyl(r, r, h, 16, MAT.chr), x, y, z);
}

// Marco abierto usado en el brazo superior y antebrazo para replicar el chasis.
// Versión simplificada: sólo cruces en los extremos para conseguir el aspecto
// de "ventana" abierta del CAD de referencia (sin travesaños intermedios).
function openFrame(parent, x, y, z, w, h, l, t, topMat, bottomMat) {
  const g = group(parent, x, y, z);
  const tm = topMat || MAT.red;
  const bm = bottomMat || MAT.rdx;

  // 4 largueros longitudinales (las cuatro aristas del marco)
  place(g, box(t, t, l, tm), -w/2,  h/2, l/2);
  place(g, box(t, t, l, tm),  w/2,  h/2, l/2);
  place(g, box(t, t, l, bm), -w/2, -h/2, l/2);
  place(g, box(t, t, l, bm),  w/2, -h/2, l/2);

  // Sólo dos marcos transversales: extremo trasero y extremo delantero.
  [0, l].forEach(zz => {
    place(g, box(w + t, t, t, tm), 0,  h/2, zz);
    place(g, box(w + t, t, t, bm), 0, -h/2, zz);
    place(g, box(t, h + t, t, tm), -w/2, 0, zz);
    place(g, box(t, h + t, t, tm),  w/2, 0, zz);
  });

  return g;
}

// Engranaje estilizado: disco central + dientes simples para que rinda bien.
function gear(parent, x, y, z, radius, thickness, teeth, toothDepth, toothWidth, mat) {
  const g = group(parent, x, y, z);
  const disc = cyl(radius, radius, thickness, Math.max(28, teeth * 2), mat || MAT.gear);
  disc.rotation.x = Math.PI / 2;
  g.add(disc);

  for (let i = 0; i < teeth; i++) {
    const a = i / teeth * Math.PI * 2;
    const tooth = box(toothWidth, toothDepth, thickness, mat || MAT.gear);
    tooth.position.set(
      Math.cos(a) * (radius + toothDepth * 0.32),
      Math.sin(a) * (radius + toothDepth * 0.32),
      0
    );
    tooth.rotation.z = a;
    g.add(tooth);
  }

  const ring = trs(Math.max(radius - toothDepth * 0.92, 0.02), toothDepth * 0.18, MAT.slvd, 8, 40);
  ring.rotation.y = Math.PI / 2;
  g.add(ring);

  const hub = cyl(radius * 0.27, radius * 0.27, thickness + 0.02, 16, MAT.chr);
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  return g;
}

// Cada garra se construye espejada usando side = ±1.
function jaw(parent, side) {
  const g = group(parent, side * 0.185, -0.038, 0.055);

  place(g, box(0.052, 0.120, 0.118, MAT.slvd), 0, 0, 0.030);

  const upperLink = box(0.038, 0.028, 0.265, MAT.slv);
  upperLink.position.set(0, 0.094, 0.175);
  upperLink.rotation.y = -side * 0.18;
  g.add(upperLink);

  const lowerLink = box(0.038, 0.028, 0.245, MAT.slv);
  lowerLink.position.set(0, 0.010, 0.165);
  lowerLink.rotation.y = -side * 0.08;
  g.add(lowerLink);

  const crank = box(0.032, 0.026, 0.175, MAT.slvd);
  crank.position.set(side * 0.018, 0.060, 0.118);
  crank.rotation.y = -side * 0.56;
  g.add(crank);

  const jawBody = box(0.060, 0.112, 0.315, MAT.slv);
  jawBody.position.set(0, -0.002, 0.350);
  jawBody.rotation.y = -side * 0.14;
  g.add(jawBody);

  const finger = box(0.038, 0.092, 0.188, MAT.slvd);
  finger.position.set(-side * 0.028, -0.012, 0.565);
  finger.rotation.y = -side * 0.48;
  g.add(finger);

  const tip = box(0.020, 0.074, 0.118, MAT.slvd);
  tip.position.set(-side * 0.078, -0.016, 0.695);
  tip.rotation.y = -side * 0.86;
  g.add(tip);

  place(g, box(0.018, 0.086, 0.155, MAT.rub), -side * 0.034, -0.020, 0.610, 0, -side * 0.62, 0);

  [
    [0, 0.098, 0.120, 0.026],
    [0, 0.010, 0.140, 0.024],
    [0, -0.002, 0.345, 0.032],
    [-side * 0.028, -0.012, 0.548, 0.024],
  ].forEach(([hx, hy, hz, rr]) => {
    const hole = cyl(rr, rr, 0.036, 14, MAT.chr);
    hole.rotation.x = Math.PI / 2;
    hole.position.set(hx, hy, hz);
    g.add(hole);
  });

  return g;
}

/* ══════════════════════════════════ ══════════
   BASE ESTÁTICA
   ══════════════════════════════════ ══════════ */

const lowerPlate = roundedPlate(scene, 3.04, 0.082, 3.04, 0.18, MAT.red, 0, 0.041, 0);
const upperPlate = roundedPlate(scene, 2.86, 0.078, 2.86, 0.16, MAT.red, 0, 0.220, 0);
// La placa superior del CAD tiene un cuadro central abierto donde se aloja
// el servo de la base. Modelamos ese marco con cuatro tiras finas en lugar
// de la chapa interior maciza.
const upperOpening = 0.640;            // lado del hueco central
const upperRim     = (2.62 - upperOpening) / 2;
[
  [ 0,  (upperOpening + upperRim) / 2],
  [ 0, -(upperOpening + upperRim) / 2],
].forEach(([x, z]) => {
  place(upperPlate, box(2.62, 0.016, upperRim, MAT.rdx), x, 0.046, z);
});
[
  [ (upperOpening + upperRim) / 2, 0],
  [-(upperOpening + upperRim) / 2, 0],
].forEach(([x, z]) => {
  place(upperPlate, box(upperRim, 0.016, upperOpening, MAT.rdx), x, 0.046, z);
});

[
  [-1, -1], [1, -1], [1, 1], [-1, 1]
].forEach(([sx, sz]) => {
  const x = sx * 1.08;
  const z = sz * 1.08;
  addHole(scene, x, 0.042, z, 0.102, 0.090);
  addHole(scene, x, 0.220, z, 0.102, 0.086);
  [
    [0.165, 0],
    [-0.165, 0],
    [0, 0.165]
  ].forEach(([dx, dz]) => {
    addHole(scene, x + dx, 0.220, z + dz, 0.030, 0.090);
  });
});

// Postes cilíndricos rojos entre las dos placas de la base (igual que el CAD).
[
  [-1.08, -1.08], [1.08, -1.08], [1.08, 1.08], [-1.08, 1.08]
].forEach(([x, z]) => {
  place(scene, cyl(0.085, 0.085, 0.180, 18, MAT.red), x, 0.131, z);
  // Tornillos cromados visibles en el extremo de cada poste
  place(scene, cyl(0.022, 0.022, 0.030, 12, MAT.chr), x, 0.232, z);
  place(scene, cyl(0.022, 0.022, 0.030, 12, MAT.chr), x, 0.030, z);
});

place(scene, cyl(0.088, 0.088, 0.268, 18, MAT.chr), 0, 0.135, 0);
const bBase = trs(0.138, 0.022, MAT.brn, 12, 36);
bBase.position.set(0, 0.222, 0);
scene.add(bBase);
place(scene, cyl(0.080, 0.080, 0.028, 20, MAT.brn), 0, 0.222, 0);
[
  [0, 0],
  [0.18, 0],
  [-0.18, 0],
  [0, 0.18],
  [0, -0.18]
].forEach(([x, z]) => addHole(scene, x, 0.220, z, x === 0 && z === 0 ? 0.050 : 0.024, 0.090));

/* ══════════════════════════════════ ══════════
   GRUPO GIRATORIO — baseG  (CH4 / J.base)
   ══════════════════════════════════ ══════════ */
const baseG = group(scene, 0, 0.258, 0);

place(baseG, box(0.920, 0.058, 0.920, MAT.rdx), 0, -0.012, 0);

[
  [-0.24, -0.24], [0.24, -0.24], [0.24, 0.24], [-0.24, 0.24]
].forEach(([x, z]) => {
  place(baseG, box(0.108, 0.470, 0.108, MAT.red), x, 0.234, z);
});

place(baseG, box(0.588, 0.082, 0.110, MAT.red), 0, 0.470, -0.240);
place(baseG, box(0.588, 0.082, 0.110, MAT.red), 0, 0.470,  0.240);
place(baseG, box(0.110, 0.082, 0.588, MAT.red), -0.240, 0.470, 0);
place(baseG, box(0.110, 0.082, 0.588, MAT.red),  0.240, 0.470, 0);

servo(baseG, 0, 0.366, 0.000);

const shoMount = group(baseG, 0, 0.958, 0.024);
// U-bracket completo en rojo (en el CAD el bracket es rojo plástico/metálico).
place(shoMount, box(0.820, 0.090, 0.540, MAT.red), 0, -0.255, 0);
place(shoMount, box(0.086, 0.540, 0.430, MAT.red), -0.298, 0, 0);
place(shoMount, box(0.086, 0.540, 0.430, MAT.red),  0.298, 0, 0);
place(shoMount, box(0.660, 0.082, 0.100, MAT.red), 0,  0.225, -0.165);
// Refuerzos de aluminio plateado que sujetan el servo del hombro
// (visibles en las renders del CAD como brackets metálicos pequeños).
place(shoMount, box(0.110, 0.230, 0.072, MAT.slvd), -0.260, 0.020, 0.180);
place(shoMount, box(0.110, 0.230, 0.072, MAT.slvd),  0.260, 0.020, 0.180);
servo(shoMount, 0.000, 0.000, 0.000, 0, 0, -Math.PI/2);
[-0.298, 0.298].forEach(dx => {
  [-0.128, 0.128].forEach(dz => {
    addHole(shoMount, dx, 0.120, dz, 0.024, 0.088);
    addHole(shoMount, dx, -0.120, dz, 0.024, 0.088);
  });
});

/* ─── Articulación hombro ───────────────────────────────── */
const shoP = group(baseG, 0, 0.958, 0.024);
const shoG = group(shoP);

const shoAxle = cyl(0.046, 0.046, 0.760, 18, MAT.chr);
shoAxle.rotation.z = Math.PI / 2;
shoG.add(shoAxle);

// Tapas laterales del hombro: rojas en el lado externo, aluminio en el interno
// (en el CAD se ven dos discos: uno rojo grande hacia afuera y un disco
//  plateado más pequeño que es el rodamiento embutido en la chapa).
[
  [-0.338, 0.176, MAT.red],
  [ 0.338, 0.176, MAT.red]
].forEach(([x, r, mat]) => {
  const hub = cyl(r, r, 0.072, 24, mat);
  hub.rotation.z = Math.PI / 2;
  hub.position.set(x, 0, 0);
  shoG.add(hub);
});
[-0.302, 0.302].forEach(x => {
  const inner = cyl(0.092, 0.092, 0.040, 18, MAT.slvd);
  inner.rotation.z = Math.PI / 2;
  inner.position.set(x, 0, 0);
  shoG.add(inner);
});

const shoBear = trs(0.136, 0.018, MAT.brn, 10, 36);
shoBear.rotation.y = Math.PI / 2;
shoBear.position.set(-0.338, 0, 0);
shoG.add(shoBear);

const UPPER_LEN = 1.12;
const UPPER_ANG = 0.82;
const elbY = Math.cos(UPPER_ANG) * UPPER_LEN;
const elbZ = Math.sin(UPPER_ANG) * UPPER_LEN;

[-1, 1].forEach((side, idx) => {
  const mainPlate = box(0.074, UPPER_LEN, 0.182, idx ? MAT.red : MAT.rdx);
  mainPlate.position.set(side * 0.305, elbY / 2, elbZ / 2);
  mainPlate.rotation.x = UPPER_ANG;
  shoG.add(mainPlate);

  const brace = box(0.058, 0.610, 0.094, MAT.red);
  brace.position.set(side * 0.152, 0.272, 0.214);
  brace.rotation.x = UPPER_ANG - 0.28;
  shoG.add(brace);
});

place(shoG, box(0.620, 0.062, 0.110, MAT.red), 0, 0.102, 0.112);
place(shoG, box(0.560, 0.058, 0.096, MAT.red), 0, elbY * 0.58, elbZ * 0.58);
place(shoG, box(0.720, 0.054, 0.082, MAT.rdx), 0, elbY, elbZ);

/* ─── Articulación codo ─────────────────────────────────── */
const elbP = group(shoG, 0, elbY, elbZ);
const elbG = group(elbP);

const elbAxle = cyl(0.040, 0.040, 0.700, 18, MAT.chr);
elbAxle.rotation.z = Math.PI / 2;
elbG.add(elbAxle);

[-0.286, 0.286].forEach((x, idx) => {
  place(elbG, box(0.064, 0.420, 0.110, idx ? MAT.red : MAT.rdx), x, 0.026, 0.040);
  const cap = cyl(0.084, 0.084, 0.052, 18, MAT.brn);
  cap.rotation.z = Math.PI / 2;
  cap.position.set(x, 0, 0);
  elbG.add(cap);
});

servo(elbG, 0.000, 0.060, 0.020, 0, 0, -Math.PI/2);

/* ══════════════════════════════════ ══════════
   ANTEBRAZO PRINCIPAL — bastidor abierto
   ══════════════════════════════════ ══════════ */
const FRAME_W = 0.760;
const FRAME_H = 0.260;
const FRAME_L = 1.620;
const FRAME_T = 0.066;

const arm2 = openFrame(elbG, 0, 0.090, 0.150, FRAME_W, FRAME_H, FRAME_L, FRAME_T, MAT.red, MAT.rdx);

servo(arm2, 0.040, FRAME_H/2 + 0.342, 0.140);
servo(arm2, 0.138, 0.000, FRAME_L - 0.220, 0, 0, -Math.PI/2);

// Soporte diagonal trasero (presente en el CAD de referencia, conecta el
// codo con la parte inferior del marco). Se omite el "midBrace" intermedio
// porque ensucia la silueta del bastidor abierto.
[-1, 1].forEach(side => {
  const backBrace = box(0.052, 0.250, 0.052, MAT.red);
  backBrace.position.set(side * 0.185, -FRAME_H/2 - 0.040, 0.402);
  backBrace.rotation.x = -0.62;
  arm2.add(backBrace);
});

/* ─── Articulación muñeca ───────────────────────────────── */
const wriP = group(arm2, 0, 0.010, FRAME_L);
const wriG = group(wriP);

// Cuerpo principal de la muñeca — rojo macizo como en el CAD
place(wriG, box(0.520, 0.110, 0.165, MAT.red), 0.000, 0.020, 0.030);
place(wriG, box(0.365, 0.052, 0.180, MAT.rdx), 0.000, 0.108, 0.030);
// Tapa inferior de aluminio plateado (en el CAD se ve un bracket metálico
// claro debajo del bloque rojo, donde está atornillado el servo).
place(wriG, box(0.320, 0.060, 0.190, MAT.slvd), 0.000, -0.080, 0.030);
// Carcasa lateral roja que aloja el servo de la pinza
place(wriG, box(0.360, 0.280, 0.250, MAT.red),  0.335, 0.055, 0.060);
// Soporte aluminio bajo el bloque lateral
place(wriG, box(0.340, 0.062, 0.260, MAT.slvd), 0.335, -0.115, 0.060);

const wristCollar = cyl(0.082, 0.082, 0.420, 18, MAT.chr);
wristCollar.rotation.x = Math.PI / 2;
wristCollar.position.set(0, 0.030, 0.000);
wriG.add(wristCollar);

const bigGear = gear(wriG, -0.115, 0.090, 0, 0.154, 0.052, 24, 0.038, 0.028, MAT.gear);
const smallGear = gear(wriG, 0.148, 0.090, 0, 0.108, 0.046, 16, 0.030, 0.020, MAT.gear);

[
  [-0.115, 0.090, 0.032],
  [0.148, 0.090, 0.026]
].forEach(([x, y, r]) => {
  const axle = cyl(r, r, 0.076, 14, MAT.chr);
  axle.rotation.x = Math.PI / 2;
  axle.position.set(x, y, 0);
  wriG.add(axle);
});

/* ══════════════════════════════════ ══════════════
   PINZA — gripR  (CH0 / J.grip)
   Pinza lateral con doble engrane y bielas visibles
   ══════════════════════════════════ ══════════ */
const gripR = group(wriG, 0.004, -0.020, 0.180);

// Cuerpo trasero rojo de la pinza (en el CAD es el bloque donde se monta
//  el servo de la garra). Sólo las garras móviles y los engranajes quedan
//  en aluminio.
place(gripR, box(0.300, 0.060, 0.092, MAT.red),  0, 0.082, 0.012);
place(gripR, box(0.188, 0.104, 0.142, MAT.red),  0, 0.018, 0.032);
// Placa cromada superior — eje central donde gira el engranaje grande.
place(gripR, box(0.390, 0.018, 0.024, MAT.chr),  0, 0.084, 0.010);
// Refuerzo plateado del soporte de las garras (tapa aluminizada del CAD)
place(gripR, box(0.214, 0.026, 0.058, MAT.slvd), 0, 0.030, 0.110);

const jaw1 = jaw(gripR, -1);
const jaw2 = jaw(gripR,  1);

/* ══════════════════════════════════ CINEMÁTICA — sincronización con ángulos reales ══════════════════════════════════
   Antes: _va se integraba por sign(J.v) → el modelo 3D "derivaba" en
   el tiempo y nunca coincidía con la posición real del servo. Ahora
   _va persigue J[key].angPos (estimación real) con un resorte crítico,
   así el modelo 3D SIEMPRE refleja la posición reportada de cada servo,
   tanto en modo manual como en visión.

   Unidades: J[].angPos en GRADOS (±angLim). _va en RADIANES para rotar
   los Groups de Three.js directamente. grip es un caso aparte:
   _va.grip es "apertura visual" en radianes (≈0 cerrado, ≈0.34 abierto),
   derivada linealmente de J.grip.angPos (±angLim). */
const _va = { base: 0, sho: 0, elb: 0, wri: 0, grip: 0.16 };
let _vaT  = performance.now();

/* Constante del resorte: fracción de la distancia que cerramos por segundo.
   6.0 → llega al 99% en ~0.77 s. Se siente instantáneo sin jitter. */
const VA_LAMBDA = 6.0;

function _targetRad(key) {
  // Usamos angPos (posición estimada del servo, actualizada por el
  // commit cycle en shared.js). Así el 3D queda sincronizado con lo
  // que realmente se envía al hardware.
  return toRad(clamp(J[key].angPos, -J[key].angLim, J[key].angLim));
}
function _targetGrip() {
  // Normaliza angPos ±angLim a apertura visual 0.04..0.34
  const t = (J.grip.angPos + J.grip.angLim) / (2 * J.grip.angLim); // 0..1
  return 0.04 + clamp(t, 0, 1) * 0.30;
}

// Interpola suavemente el estado visual hacia el ángulo real estimado.
function _tickVA() {
  const now = performance.now();
  const dt  = Math.min((now - _vaT) / 1000, 0.05);
  _vaT = now;
  const k = 1 - Math.exp(-VA_LAMBDA * dt); // fracción hacia objetivo este frame

  _va.base += (_targetRad('base') - _va.base) * k;
  _va.sho  += (_targetRad('sho')  - _va.sho)  * k;
  _va.elb  += (_targetRad('elb')  - _va.elb)  * k;
  _va.wri  += (_targetRad('wri')  - _va.wri)  * k;
  _va.grip += (_targetGrip()       - _va.grip) * k;
}

// Aplica el estado visual calculado a cada group jerárquico del brazo.
function _applyVA() {
  baseG.rotation.y = _va.base;
  shoG.rotation.x  = _va.sho;
  elbG.rotation.x  = _va.elb;
  wriG.rotation.z  = _va.wri;
  bigGear.rotation.z   =  _va.grip * 1.9;
  smallGear.rotation.z = -_va.grip * 2.7;
  jaw1.rotation.z =  _va.grip;
  jaw2.rotation.z = -_va.grip;
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

/* ─── Loop de renderizado ─────────────────────────────────
   Cap a ~30 fps: la escena es estática (brazo + servos). A 60 fps
   la GPU era el mayor consumidor de CPU cuando el Arduino también
   estaba enviando datos, causando el lag percibido. 30 fps se ve
   igual de fluido para este tipo de visualización. */
const TARGET_FRAME_MS = 1000 / 30;
let _lastRender3d = 0;
// Loop principal: suaviza cámara, anima juntas y renderiza a ~30 fps.
function loop3d(now) {
  requestAnimationFrame(loop3d);
  now = now || performance.now();
  if (now - _lastRender3d < TARGET_FRAME_MS) return;
  _lastRender3d = now;
  _tickVA(); _applyVA();  // animar continuamente mientras servos activos
  _th += (_tx - _th) * 0.12;
  _ph += (_ty - _ph) * 0.12;
  cam3.position.set(
    _r * Math.sin(_th) * Math.cos(_ph),
    _r * Math.sin(_ph),
    _r * Math.cos(_th) * Math.cos(_ph)
  );
  cam3.lookAt(lookTgt);
  glowL.intensity = 0.32 + 0.14 * Math.sin(now * 0.0018);
  renderer.render(scene, cam3);
}

loop3d();
applyArm();
refreshUI();
log('RoboArm IPN v16 — modelo 3D actualizado', 'ok');
log('CH0=Pinza · CH1=Muñeca · CH2=Codo · CH3=Hombro · CH4=Base', 'info');
