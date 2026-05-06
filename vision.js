/* ════════════════════════════════════════════════
   vision.js — Control por brazo COMPLETO (Pose + Hands) v12
   ────────────────────────────────────────────────────────────────
   ARQUITECTURA:
   1. getUserMedia → stream
   2. Video visible + rAF draw loop INMEDIATAMENTE
   3. MediaPipe Pose + Hands inicializan en paralelo (no bloquean UI)
   4. Cada N frames: envía imagen a Pose y a Hands
   5. Resultados combinados se aplican al brazo

   MAPEO anatómico → servo:
     BASE   (CH4): yaw hombro→muñeca (rotación horizontal del brazo)
     HOMBRO (CH3): elevación del hombro (ángulo torso / brazo superior)
     CODO   (CH2): flexión del codo  (ángulo brazo sup. / antebrazo)
     MUÑECA (CH1): roll de la mano (de Hands, o del antebrazo)
     PINZA  (CH0): pinch dedos pulgar-índice (de Hands)

   Si Pose no detecta el brazo → fallback a control por mano (legacy).

   Dependencias: shared.js (J, JDEFS, clamp, lerp, batchTargets, log, modal)
   ═══════════════════════════════════════════════ */

/* ─── DOM refs ──────────────────────────────────────────────── */
const camVideo  = document.getElementById('cam-video');
const camCanvas = document.getElementById('cam-canvas');
const camCtx    = camCanvas.getContext('2d');
const poseMapEl = document.getElementById('pose-map');
const pmCtx     = poseMapEl.getContext('2d');

/* ─── Estado ────────────────────────────────────────────────── */
let handInst       = null;
let poseInst       = null;
let camActive      = false;
let mpReady        = false;   // Pose listo (mínimo para brazo completo)
let handsReady     = false;   // Hands listo (añade pinza + muñeca fina)
let mirrorOn       = true;
let selectedDevId  = null;
let _selBound      = false;
let _rafId         = null;    // rAF del draw loop
let _frameCount    = 0;       // Throttle MediaPipe
const MP_SKIP      = 1;       // Procesar 1 de cada 2 frames

/* ─── Parámetros ajustables ─────────────────────────────────── */
let SENS_X = 120;
let SENS_Y = 130;
let SENS_Z = 100;
let ALPHA1 = 0.32;   // EMA-1: anti-ruido. Más bajo = seguimiento más directo del gesto.
let ALPHA2 = 0.45;   // EMA-2: suavidad. Balance entre respuesta y estabilidad del servo.

/* ─── Zona muerta y mapeo a GRADOS objetivo ────────────────────
   Cada eje mide distancia desde el centro (0.5 para X/Y).
   Zona muerta → ignora temblores. Fuera de la zona muerta el
   delta se mapea linealmente al rango ±VISION_LIMITS[jointKey].

   VISION_LIMITS: topes duros específicos de modo visión (grados ±).
   Por defecto siguen el rango físico disponible; si luego quieres
   hacer visión más conservadora, bájalos aquí. Rangos totales:
     base 180° → ±90, hombro 90° → 0..90, codo 90° → -90..0,
     muñeca 180° → ±90, pinza 50° → ±25. */
const DEADZONE = 0.18;
const VISION_LIMITS = {
  base: PHYSICAL_LIMITS.base,  // ±90   → 180° totales
  sho:  Math.min(PHYSICAL_LIMITS.sho, VISION_ACTIVE_LIMITS.sho ?? PHYSICAL_LIMITS.sho), // 0..90 → 90° totales
  elb:  PHYSICAL_LIMITS.elb,   // -90..0 → 90° totales
  wri:  PHYSICAL_LIMITS.wri,   // ±90  → 180° totales
  grip: PHYSICAL_LIMITS.grip,  // ±25 → 50°  totales
};

/* ─── CUADRÍCULA DE CONTROL 2D ────────────────────────────────────
   Rectángulo centrado en el hombro dentro del frame de cámara.
   dx/dy del wrist AL hombro se normalizan a ±1 dividiendo por estas
   medias anchura/altura y se mapean a ±VISION_LIMITS[base|sho].
   Fuera del rect → saturación dura (no hay servo más allá de la reja).
   Es el mapeo que "ves" en la cámara, por eso se dibuja como guía.
   Antes usábamos atan2(x,-z) de pose3D para la base, pero Z en
   poseWorldLandmarks es ruidoso y envuelve ±180°, causando giros >180°
   al acercar el brazo al plano de cámara. La reja 2D lo evita. */
const GRID_HALF_X = 0.28;   // ± fracción del ancho del frame
const GRID_HALF_Y = 0.30;   // ± fracción del alto del frame
const VISION_STICKY_EPS = {
  sho: 3.5,   // ignora microcambios del hombro para reducir temblor
};
const VISION_FILTER_ALPHA = {
  sho: { a1: 0.34, a2: 0.48 },
};
/** Límite efectivo: MENOR entre el tope mecánico (angLim) y el de visión */
function visionCap(key) {
  const mech = J[key]?.angLim ?? 90;
  const vis  = VISION_LIMITS[key] ?? mech;
  return Math.min(mech, vis);
}
function stabilizeVisionTarget(key, deg) {
  const eps = VISION_STICKY_EPS[key];
  if (typeof eps !== 'number' || !J[key]) return deg;
  const current = clamp(J[key].target, -visionCap(key), visionCap(key));
  return Math.abs(deg - current) < eps ? current : deg;
}
/** delta = desviación del centro (-0.5..+0.5); devuelve grados objetivo */
function posToTargetDeg(delta, jointKey) {
  const d = Math.abs(delta);
  const lim = visionCap(jointKey);
  if (d < DEADZONE) return 0;
  const t = (d - DEADZONE) / (0.5 - DEADZONE);          // 0..1
  const deg = Math.sign(delta) * Math.min(1, t) * lim;
  return clamp(deg, -lim, lim);
}

/* ─── Filtros por articulación ──────────────────────────────── */
const F = {};
JDEFS.forEach(d => { F[d.key] = { e1: d.def, e2: d.def }; });

/* ─── Últimos resultados de MediaPipe ───────────────────────── */
let latestHand      = null;  // lm 2D de la mano (21 puntos)
let latestPose2D    = null;  // poseLandmarks 2D (imagen normalizada)
let latestPoseWorld = null;  // poseWorldLandmarks 3D (metros, centrado en cadera)
let latestHandRaw   = null;  // mano cruda desde MediaPipe (sin espejo)
let latestPose2DRaw = null;  // pose 2D cruda desde MediaPipe (sin espejo)

function _mirrorPoint2D(p) {
  return { ...p, x: 1 - p.x };
}

function _map2DLandmarksForView(list) {
  if (!list) return null;
  return mirrorOn ? list.map(_mirrorPoint2D) : list;
}

function syncVisionMirrorState() {
  latestHand   = _map2DLandmarksForView(latestHandRaw);
  latestPose2D = _map2DLandmarksForView(latestPose2DRaw);
}

function updateMirrorButton() {
  const btn = document.getElementById('btn-mirror');
  if (btn) btn.textContent = mirrorOn ? '⇔ Espejo: ON' : '⇔ Espejo';
}

/* ¿Qué lado del cuerpo seguimos? "right" = lado derecho del usuario (mirror).
   Landmarks Pose: R_SHOULDER=12, R_ELBOW=14, R_WRIST=16, R_HIP=24.
                   L_SHOULDER=11, L_ELBOW=13, L_WRIST=15, L_HIP=23. */
let ARM_SIDE = 'right';
const SIDE_IDX = {
  right: { sho:12, elb:14, wri:16, hip:24 },
  left:  { sho:11, elb:13, wri:15, hip:23 },
};

/* ─── Rate-limit de envío al brazo (evita congelamiento) ────── */
const ARM_MIN_MS = 60;    // máx ~16 Hz al brazo — respuesta fluida sin saturar
let _lastArmUpdate = 0;

/* ─── CONGELAMIENTO POR LÍMITE ──────────────────────────────────
   Cuando TODOS los servos saturan su tope de visión simultáneamente
   (el gesto está claramente fuera del rango permitido), congelamos:
     • no enviamos targets al brazo (ni al 3D)
     • ocultamos las guías sobre el video de la cámara
   Se sale del modo congelado tan pronto como alguna articulación
   deje de estar saturada (el usuario recoge el brazo). */
const LIMIT_EPS = 0.98;   // 98% del tope = "al límite"
let _armFrozen  = false;

/* ─── Toggles overlay ────────────────────────────────────────── */
const CT = { skeleton:true, pinch:true, labels:false, trail:false };
document.querySelectorAll('.ctool').forEach(btn => {
  const MAP = { 'ct-skeleton':'skeleton','ct-pinch':'pinch','ct-labels':'labels','ct-trail':'trail','ct-depth':'depthZ' };
  const k = MAP[btn.id]; if (!k) return;
  CT[k] = btn.classList.contains('active');
  btn.addEventListener('click', () => { CT[k]=!CT[k]; btn.classList.toggle('active',CT[k]); });
});

const TRAIL=[]; const TRAIL_MAX=40;

/* ─── FPS counter ────────────────────────────────────────────── */
let _fpsFrames=0, _fpsLast=performance.now();

/* ─── Utils UI ───────────────────────────────────────────────── */
function _ui(id,v){ const e=document.getElementById(id); if(e&&e.textContent!==String(v)) e.textContent=v; }
function _bar(id,p){ const e=document.getElementById(id); if(e) e.style.width=clamp(p,0,100)+'%'; }

function disableVisionBaseControls() {
  const sl = document.getElementById('sl-sens-x');
  if (sl) {
    sl.disabled = true;
    sl.style.opacity = '0.45';
    sl.title = 'Base gestionada por teclado: usa Q/A';
  }
  _ui('lv-sens-x', 'Q/A');
}

/* ─── Filtro de señal doble EMA (en GRADOS objetivo) ────────── */
function _adaptiveVisionAlpha(baseAlpha, errorDeg) {
  const assist = clamp((errorDeg - 3) / 18, 0, 1);
  const fastAlpha = Math.max(0.16, baseAlpha - 0.36);
  return lerp(baseAlpha, fastAlpha, assist);
}

function applyFilter(key, raw) {
  const lim = visionCap(key);
  const fa = VISION_FILTER_ALPHA[key];
  const errorDeg = Math.abs(raw - F[key].e2);
  const alpha1 = _adaptiveVisionAlpha(fa?.a1 ?? ALPHA1, errorDeg);
  const alpha2 = _adaptiveVisionAlpha(fa?.a2 ?? ALPHA2, errorDeg);
  raw = clamp(raw, -lim, lim);
  F[key].e1 = lerp(raw, F[key].e1, alpha1);
  F[key].e2 = lerp(F[key].e1, F[key].e2, alpha2);
  F[key].e1 = clamp(F[key].e1, -lim, lim);
  F[key].e2 = clamp(F[key].e2, -lim, lim);
  return F[key].e2;
}

function lockBaseToKeyboardOnly() {
  /* Al entrar en visión, base (CH4) se congela donde está.
     Desde aquí en adelante solo teclado/manual puede cambiarla. */
  setJointTarget('base', J.base.angPos);
  F.base.e1 = F.base.e2 = J.base.angPos;
  _ui('p-shx', '— (teclado Q/A)');
  _ui('cd-base', Math.round(J.base.angPos) + '°');
}

function setBaseUiLock(locked) {
  [
    'sl-base',
    'ard-sl-base',
    'deg-inp-base',
    'ard-sweep-base',
  ].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = locked;
    el.style.opacity = locked ? '0.45' : '';
    if (locked) el.title = 'Base gestionada por teclado: usa Q/A';
    else if (el.title === 'Base gestionada por teclado: usa Q/A') el.title = '';
  });

  document.querySelectorAll('[data-dkey="base"]').forEach(el => {
    el.disabled = locked;
    el.style.opacity = locked ? '0.45' : '';
    if (locked) el.title = 'Base gestionada por teclado: usa Q/A';
    else if (el.title === 'Base gestionada por teclado: usa Q/A') el.title = '';
  });

  const card = document.getElementById('jb-base');
  if (card) card.style.opacity = locked ? '0.65' : '';
}

/* ─── Pinza: distancia pulgar(4)-índice(8) normalizada ─────── */
function pinchOpen(lm) {
  if (!lm||lm.length<21) return null;
  const hl = Math.max(0.001, Math.hypot(lm[0].x-lm[9].x, lm[0].y-lm[9].y));
  return clamp(Math.hypot(lm[4].x-lm[8].x, lm[4].y-lm[8].y)/(hl*2.1), 0, 1);
}

/* ─── Distancia 2D ───────────────────────────────────────────── */
function dist2(a,b){ return Math.hypot(a.x-b.x,a.y-b.y); }

/* ══════════════════════════════════ SELECTOR DE CÁMARA ══════════════════════════════════ */
async function populateCameraList() {
  const sel = document.getElementById('sel-camera'); if(!sel) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const cams = devs.filter(d=>d.kind==='videoinput');
    sel.innerHTML = cams.length
      ? cams.map((c,i)=>`<option value="${c.deviceId}">${c.label||'Cámara '+(i+1)}</option>`).join('')
      : '<option value="">Sin cámaras</option>';
    if (!selectedDevId && cams.length) selectedDevId = cams[0].deviceId;
    if (sel.querySelector(`[value="${selectedDevId}"]`)) sel.value = selectedDevId;
    if (!_selBound && cams.length) {
      sel.addEventListener('change', ()=>{ selectedDevId=sel.value; });
      _selBound=true;
    }
  } catch(e) { console.warn('enumerateDevices:', e); }
}
populateCameraList();
if (navigator.mediaDevices.addEventListener)
  navigator.mediaDevices.addEventListener('devicechange', populateCameraList);

/* ══════════════════════════════════ CALLBACKS DE MEDIAPIPE ══════════════════════════════════ */
function onHandResults(res) {
  if (!res.multiHandLandmarks?.length) {
    latestHandRaw = null;
    latestHand = null;
    return;
  }
  let best = res.multiHandLandmarks[0];
  const preferredLabel = ARM_SIDE === 'right' ? 'Left' : 'Right';
  res.multiHandedness?.forEach((h,i)=>{ if(h.label===preferredLabel) best=res.multiHandLandmarks[i]; });
  latestHandRaw = best;
  syncVisionMirrorState();
}

function onPoseResults(res) {
  if (!res.poseLandmarks) {
    latestPose2DRaw = null;
    latestPose2D = null;
    latestPoseWorld = null;
    return;
  }
  latestPose2DRaw = res.poseLandmarks;
  latestPoseWorld = res.poseWorldLandmarks || null;
  /* Lado seguido: el que tenga mayor visibilidad en la muñeca */
  const rV = res.poseLandmarks[16]?.visibility ?? 0;
  const lV = res.poseLandmarks[15]?.visibility ?? 0;
  if (rV > lV + 0.1) ARM_SIDE = 'right';
  else if (lV > rV + 0.1) ARM_SIDE = 'left';
  syncVisionMirrorState();
}

/* ─── Utilidades geométricas ────────────────────────────────── */
function _sub(a,b){ return { x:a.x-b.x, y:a.y-b.y, z:a.z-b.z }; }
function _len(v){ return Math.hypot(v.x, v.y, v.z); }
function _norm(v){ const l=_len(v)||1; return { x:v.x/l, y:v.y/l, z:v.z/l }; }
function _dot(a,b){ return a.x*b.x + a.y*b.y + a.z*b.z; }
function _angBetween(a,b){ // grados
  const na=_norm(a), nb=_norm(b);
  return Math.acos(clamp(_dot(na,nb), -1, 1)) * 180/Math.PI;
}

/* ════════════════════════════════ PROCESAMIENTO DE FRAME ════════════════════════════════
   Usa Pose (brazo) como fuente primaria; Hands aporta pinza + muñeca.
   Calcula 5 targets anatómicos en GRADOS, los pasa por filtro doble
   EMA y los enruta al brazo mediante batchTargets. */
function processFrame() {
  const p2 = latestPose2D;
  const pw = latestPoseWorld;
  const lm = latestHand;

  /* Sin Pose ni Hands → nada que hacer */
  if (!p2 && !lm) {
    _armFrozen = false;
    _ui('pm-status', 'SIN BRAZO');
    document.getElementById('pm-status').style.color='var(--err)';
    _ui('p-conf', '0%'); _bar('conf-bar', 0);
    return;
  }

  const S_I = SIDE_IDX[ARM_SIDE];
  const shoulder2D = p2 ? p2[S_I.sho] : null;
  const elbow2D    = p2 ? p2[S_I.elb] : null;
  const wrist2D    = p2 ? p2[S_I.wri] : null;
  const hip2D      = p2 ? p2[S_I.hip] : null;

  /* Visibilidad del brazo completo (0..1) */
  const vis = p2
    ? Math.min(shoulder2D?.visibility ?? 0, elbow2D?.visibility ?? 0, wrist2D?.visibility ?? 0)
    : 0;

  let rawSho, rawElb, rawWri, rawGrip;

  if (p2 && vis > 0.45 && pw) {
    /* ═══════ MODO BRAZO COMPLETO (Pose 3D + reja 2D) ═══════ */
    const S = pw[S_I.sho], E = pw[S_I.elb], W = pw[S_I.wri];

    /* Vectores anatómicos en metros (para CODO) */
    const SE = _sub(E, S);    // brazo superior
    const EW = _sub(W, E);    // antebrazo

    /* BASE + HOMBRO: CUADRÍCULA 2D centrada en el hombro.
       dx/dy del wrist al hombro, normalizados a ±1 por la media
       anchura/altura de la reja. Fuera de la reja → saturación dura.
       Esto elimina los saltos de yaw 3D (> 180°) al cruzar el plano
       de cámara y coincide 1:1 con el rectángulo dibujado en pantalla. */
    const dxFrac = wrist2D.x - shoulder2D.x;
    const dyFrac = wrist2D.y - shoulder2D.y;
    const xN = clamp(dxFrac / GRID_HALF_X, -1, 1);
    const yN = clamp(dyFrac / GRID_HALF_Y, -1, 1);
    rawSho  = yN * VISION_LIMITS.sho;    // y sube ⇒ dy<0 ⇒ rawSho<0

    /* CODO: flexión del codo. Ángulo en el vértice E entre -SE y EW.
       Extendido = 180°. Flexionado 90° = 90°. Totalmente cerrado = 0°.
       Neutro = 135° (ligeramente flexionado). Mapeamos al rango de codo configurado.
       Flexión (doblado) → positivo; extensión → negativo. */
    const ES = { x:-SE.x, y:-SE.y, z:-SE.z };
    const elbFlex = _angBetween(ES, EW);      // 0..180
    const elbDelta = (135 - elbFlex) / 45;    // recto→-1, doblado→+1
    rawElb = clamp(elbDelta, -1, 1) * VISION_LIMITS.elb;

    /* MUÑECA: si tenemos Hands usamos roll de la mano; si no, usamos
       dirección del antebrazo proyectada (aproximación). */
    if (lm) {
      const handAng = Math.atan2(lm[9].y-lm[0].y, lm[9].x-lm[0].x)*180/Math.PI;
      rawWri = clamp(handAng + 90, -VISION_LIMITS.wri, VISION_LIMITS.wri);
    } else {
      const fwAng = Math.atan2(EW.x, EW.y) * 180/Math.PI;
      rawWri = clamp(fwAng, -VISION_LIMITS.wri, VISION_LIMITS.wri);
    }

    /* PINZA: si Hands está activo usa pinch; si no, mantén última. */
    if (lm) {
      const open = pinchOpen(lm) ?? 0.5;
      rawGrip = posToTargetDeg(open - 0.5, 'grip');
    } else {
      rawGrip = F.grip.e2;   // conserva último
    }

    /* UI: muestra grados objetivo (ya clampados a la reja).
       p-shx (base) muestra "—" porque la base está bloqueada en visión. */
    _ui('p-shy', Math.round(rawSho)+'°');
    _ui('p-shx', '— (solo teclas Q/A)');
    _ui('p-elb', elbFlex.toFixed(0)+'°');
    _ui('p-wri', (lm ? Math.atan2(lm[9].y-lm[0].y, lm[9].x-lm[0].x)*180/Math.PI : 0).toFixed(0)+'°');
    _ui('p-grip', lm ? ((pinchOpen(lm)||0)*100).toFixed(0)+'%' : '—');
    const pm=document.getElementById('pm-status');
    if(pm){ pm.textContent = vis>0.8?'BRAZO OK':vis>0.6?'BRAZO':'BRAZO DÉBIL';
            pm.style.color = vis>0.8?'var(--ok)':vis>0.6?'var(--warn)':'var(--err)'; }
    _ui('p-conf', Math.round(vis*100)+'%');
    _bar('conf-bar', vis*100);
  }
  else if (lm) {
    /* ═══════ FALLBACK: solo mano (Pose no detecta brazo) ═══════ */
    const palmX = (lm[0].x+lm[5].x+lm[9].x+lm[13].x+lm[17].x)/5;
    const palmY = (lm[0].y+lm[5].y+lm[9].y+lm[13].y+lm[17].y)/5;
    const palmZ = (lm[0].z+lm[5].z+lm[9].z)/3;
    const sz    = dist2(lm[0], lm[9]);
    const conf  = clamp(sz*4.5, 0, 1);
    if (conf < 0.18) {
      _ui('pm-status', 'DÉBIL'); _ui('p-conf', Math.round(conf*100)+'%'); _bar('conf-bar', conf*100);
      return;
    }
    rawSho  = posToTargetDeg(palmY - 0.5, 'sho');
    const szNorm = clamp((sz - 0.14) / 0.18, -0.5, 0.5);
    const zSig   = clamp(-palmZ * 4, -0.5, 0.5);
    rawElb = posToTargetDeg(clamp(szNorm*0.55 + zSig*0.45, -0.5, 0.5), 'elb');
    const handAng = Math.atan2(lm[9].y-lm[0].y, lm[9].x-lm[0].x)*180/Math.PI;
    rawWri  = posToTargetDeg(clamp((handAng+90)/180, -0.5, 0.5), 'wri');
    const open = pinchOpen(lm) ?? 0.5;
    rawGrip = posToTargetDeg(open - 0.5, 'grip');
    const pm=document.getElementById('pm-status');
    if(pm){ pm.textContent='SOLO MANO'; pm.style.color='var(--warn)'; }
    _ui('p-conf', Math.round(conf*100)+'%');
    _bar('conf-bar', conf*100);
  } else {
    _ui('pm-status', 'SIN BRAZO');
    document.getElementById('pm-status').style.color='var(--err)';
    return;
  }

  /* Rastro: sigue la muñeca (2D) si hay Pose; si no, el centro de la palma */
  if (CT.trail) {
    const tx = wrist2D ? wrist2D.x
             : lm ? (lm[0].x+lm[9].x)/2 : null;
    const ty = wrist2D ? wrist2D.y
             : lm ? (lm[0].y+lm[9].y)/2 : null;
    if (tx != null) { TRAIL.push({x:tx, y:ty}); if(TRAIL.length>TRAIL_MAX) TRAIL.shift(); }
  } else TRAIL.length=0;

  /* Detección de saturación: ¿están TODOS los targets pegados al tope?
     BASE se excluye — en modo visión la base NO se mueve, solo teclado. */
  const atCap = (raw, key) => Math.abs(raw) >= visionCap(key) * LIMIT_EPS;
  const allSat =
    atCap(rawSho,'sho') && atCap(rawElb,'elb') &&
    atCap(rawWri,'wri') && atCap(rawGrip,'grip');
  _armFrozen = allSat;

  if (_armFrozen) {
    /* Congelado: no filtramos (evita que los EMA sigan empujando),
       no enviamos al brazo, y marcamos el estado en UI. */
    const pm = document.getElementById('pm-status');
    if (pm) { pm.textContent='LÍMITE ALCANZADO'; pm.style.color='var(--err)'; }
    _ui('cam-mode-lbl', 'LÍMITE — DETENIDO');
    return;
  }

  /* Doble EMA + rate-limit al brazo.
     BASE queda fuera del envío — en modo visión solo se mueve por teclado. */
  const fSho  = applyFilter('sho',  rawSho);
  const fElb  = applyFilter('elb',  rawElb);
  const fWri  = applyFilter('wri',  rawWri);
  const fGrip = applyFilter('grip', rawGrip);

  const nowMs = performance.now();
  if (nowMs - _lastArmUpdate >= ARM_MIN_MS) {
    _lastArmUpdate = nowMs;
    batchTargets({
      sho:  stabilizeVisionTarget('sho', clamp(fSho, -visionCap('sho'), visionCap('sho'))),
      elb:  clamp(fElb,  -visionCap('elb'),  visionCap('elb')),
      wri:  clamp(fWri,  -visionCap('wri'),  visionCap('wri')),
      grip: clamp(fGrip, -visionCap('grip'), visionCap('grip')),
    });
  }

  /* Restaura label si ya no está congelado */
  if (mpReady) _ui('cam-mode-lbl', 'BRAZO COMPLETO');
  else if (handsReady) _ui('cam-mode-lbl', 'SOLO MANO');

  /* Barras y ángulos filtrados */
  _bar('sg-pose', (vis||0)*100);
  _ui('sv-pose', Math.round((vis||0)*100)+'%');
  const sfmt = v => Math.round(v) + '°';
  _ui('cd-base', sfmt(J.base.target));   // base la gestiona el teclado, no visión
  _ui('cd-sho',  sfmt(J.sho.target));
  _ui('cd-elb',  sfmt(J.elb.target));
  _ui('cd-wri',  sfmt(J.wri.target));
  _ui('cd-grip', sfmt(J.grip.target));
  if (lm) {
    const op = pinchOpen(lm) ?? 0.5;
    const closed = op < 0.28;
    _ui('pinch-val', closed?'CERRADO':(op*100).toFixed(0)+'%');
    const pd=document.getElementById('pinch-dot'); if(pd) pd.className=closed?'open':'';
    _bar('sg-grip', op*100);
    _ui('sv-grip2', (op*100).toFixed(0)+'%');
  }
}

/* ═══════════════════════════════════════════════
   DRAW LOOP — siempre activo cuando la cámara está encendida
   Dibuja el video en el canvas y los landmarks encima.
   Se ejecuta con rAF independientemente de MediaPipe.
   ═══════════════════════════════════════════════ */
function drawLoop() {
  if (!camActive) return;
  _rafId = requestAnimationFrame(drawLoop);

  const W = camCanvas.offsetWidth  || 292;
  const H = camCanvas.offsetHeight || 165;
  if (camCanvas.width!==W||camCanvas.height!==H){ camCanvas.width=W; camCanvas.height=H; }

  /* Dibujar video */
  if (camVideo.readyState >= 2) {
    if (mirrorOn) { camCtx.save(); camCtx.scale(-1,1); camCtx.drawImage(camVideo,-W,0,W,H); camCtx.restore(); }
    else           { camCtx.drawImage(camVideo, 0, 0, W, H); }
  }

  /* Overlay landmarks — se ocultan por completo cuando el sistema está
     congelado (todos los servos al tope). Eso deja la cámara "limpia"
     como aviso visual y evita sugerir que el control sigue activo. */
  const lm = latestHand;
  const p2 = latestPose2D;
  let anyDrawn = false;
  if (!_armFrozen) {
    if (p2) { _drawGrid(p2, W, H); anyDrawn=true; }
    if (CT.trail && TRAIL.length>1) { _drawTrail(W, H); anyDrawn=true; }
    if (p2 && CT.skeleton) { _drawArm(p2, W, H); anyDrawn=true; }
    if (lm) {
      if (CT.skeleton) _drawHand(lm, W, H);
      if (CT.pinch)    _drawPinch(lm, W, H);
      _drawCrossHair(lm, W, H);
      anyDrawn=true;
    }
  }
  if (_armFrozen) {
    /* Mensaje claro en rojo semitransparente */
    camCtx.fillStyle='rgba(140,20,40,0.82)';
    camCtx.fillRect(0, H/2 - 14, W, 28);
    camCtx.fillStyle='#FDFAF6';
    camCtx.font=`700 ${Math.max(10,Math.round(W*0.045))}px IBM Plex Mono,monospace`;
    camCtx.textAlign='center';
    camCtx.fillText('LÍMITE · DETENIDO', W/2, H/2 + 5);
    camCtx.textAlign='left';
  } else if (!anyDrawn) {
    camCtx.fillStyle='rgba(253,250,246,0.45)';
    camCtx.font='600 10px IBM Plex Mono,monospace';
    camCtx.textAlign='center';
    camCtx.fillText(mpReady?'Muestre el brazo':'Cargando IA…', W/2, H/2);
    camCtx.textAlign='left';
  }

  /* Enviar a MediaPipe (throttled): Pose + Hands en paralelo */
  if (camVideo.readyState>=2 && _frameCount % (MP_SKIP+1) === 0) {
    if (poseInst && mpReady)  poseInst.send({ image: camVideo }).catch(()=>{});
    if (handInst && handsReady) handInst.send({ image: camVideo }).catch(()=>{});
    if (mpReady || handsReady) processFrame();
  }
  _frameCount++;

  /* FPS */
  _fpsFrames++;
  const now = performance.now();
  if (now-_fpsLast>900){
    _ui('cam-fps', Math.round(_fpsFrames*1000/(now-_fpsLast))+' fps');
    _fpsFrames=0; _fpsLast=now;
  }

  /* Mapa miniatura: también se apaga cuando el brazo está congelado */
  if (_armFrozen) { pmCtx.clearRect(0,0,poseMapEl.width||260,poseMapEl.height||74); }
  else if (p2)     _drawArmMap(p2);
  else             _drawHandMap(lm);
}

/* ─── Cuadrícula activa de control ──────────────────────────────
   Rect centrado en el hombro. El wrist dentro del rect mueve base/
   hombro linealmente; fuera del rect los servos están SATURADOS al
   tope y un círculo rojo marca el wrist como "fuera de alcance". */
function _drawGrid(p2, W, H) {
  const I = SIDE_IDX[ARM_SIDE];
  const S = p2[I.sho]; const Wr = p2[I.wri];
  if (!S) return;
  const cx = S.x * W, cy = S.y * H;
  const hx = GRID_HALF_X * W, hy = GRID_HALF_Y * H;

  camCtx.save();
  /* Rect exterior: tope del control */
  camCtx.strokeStyle = 'rgba(212,160,64,0.72)';
  camCtx.lineWidth = 1.8;
  camCtx.setLineDash([6,4]);
  camCtx.strokeRect(cx - hx, cy - hy, hx*2, hy*2);
  camCtx.setLineDash([]);
  /* Cruz central: 0° de base y hombro */
  camCtx.strokeStyle = 'rgba(212,160,64,0.30)';
  camCtx.lineWidth = 1;
  camCtx.beginPath();
  camCtx.moveTo(cx - hx, cy); camCtx.lineTo(cx + hx, cy);
  camCtx.moveTo(cx, cy - hy); camCtx.lineTo(cx, cy + hy);
  camCtx.stroke();
  /* Esquinas reforzadas (vértices de la zona) */
  camCtx.strokeStyle = 'rgba(140,20,40,0.85)';
  camCtx.lineWidth = 2.2;
  const cs = Math.min(hx, hy) * 0.18;
  [[cx-hx,cy-hy,1,1],[cx+hx,cy-hy,-1,1],[cx-hx,cy+hy,1,-1],[cx+hx,cy+hy,-1,-1]]
    .forEach(([x,y,sx,sy])=>{
      camCtx.beginPath();
      camCtx.moveTo(x+sx*cs, y); camCtx.lineTo(x, y); camCtx.lineTo(x, y+sy*cs);
      camCtx.stroke();
    });
  /* Marca wrist fuera de reja */
  if (Wr) {
    const wx = Wr.x * W, wy = Wr.y * H;
    const outside = Math.abs(Wr.x - S.x) > GRID_HALF_X
                 || Math.abs(Wr.y - S.y) > GRID_HALF_Y;
    if (outside) {
      camCtx.strokeStyle = '#8C1428'; camCtx.lineWidth = 2.5;
      const r = Math.max(10, Math.min(18, W*0.05));
      camCtx.beginPath(); camCtx.arc(wx, wy, r, 0, Math.PI*2); camCtx.stroke();
      camCtx.beginPath();
      camCtx.moveTo(wx-r*0.55, wy-r*0.55); camCtx.lineTo(wx+r*0.55, wy+r*0.55);
      camCtx.stroke();
    }
  }
  camCtx.restore();
}

/* ─── Dibujar brazo (Pose) ───────────────────────────────────── */
function _drawArm(p2, W, H) {
  const I = SIDE_IDX[ARM_SIDE];
  const S = p2[I.sho], E = p2[I.elb], Wr = p2[I.wri], Hp = p2[I.hip];
  const other = ARM_SIDE==='right' ? p2[11] : p2[12];
  const pts = [S,E,Wr,Hp,other].filter(p=>p && (p.visibility===undefined || p.visibility>0.35));
  if (pts.length < 2) return;

  const toXY = p => [p.x*W, p.y*H];
  /* Torso (hombros + cadera del lado) */
  if (other && Hp) {
    camCtx.globalAlpha=0.45; camCtx.strokeStyle='#907070'; camCtx.lineWidth=1.3;
    const [ax,ay]=toXY(S), [bx,by]=toXY(other), [hx,hy]=toXY(Hp);
    camCtx.beginPath(); camCtx.moveTo(ax,ay); camCtx.lineTo(bx,by); camCtx.stroke();
    camCtx.beginPath(); camCtx.moveTo(ax,ay); camCtx.lineTo(hx,hy); camCtx.stroke();
  }
  /* Segmentos del brazo */
  const segs = [[S,E,'#D4A040'],[E,Wr,'#8C1428']];
  segs.forEach(([a,b,col])=>{
    if(!a||!b) return;
    const [x1,y1]=toXY(a), [x2,y2]=toXY(b);
    camCtx.globalAlpha=0.85; camCtx.strokeStyle=col; camCtx.lineWidth=3.0; camCtx.lineCap='round';
    camCtx.beginPath(); camCtx.moveTo(x1,y1); camCtx.lineTo(x2,y2); camCtx.stroke();
  });
  /* Articulaciones */
  const joints = [[S,'#D4A040','HOMBRO'],[E,'#C4742C','CODO'],[Wr,'#8C1428','MUÑECA']];
  joints.forEach(([p,col,lbl])=>{
    if(!p) return;
    const [x,y]=toXY(p);
    camCtx.globalAlpha=0.25; camCtx.beginPath(); camCtx.arc(x,y,10,0,Math.PI*2); camCtx.fillStyle=col; camCtx.fill();
    camCtx.globalAlpha=1;    camCtx.beginPath(); camCtx.arc(x,y,4.5,0,Math.PI*2); camCtx.fillStyle=col; camCtx.fill();
    camCtx.strokeStyle='rgba(255,255,250,0.9)'; camCtx.lineWidth=1.2;
    camCtx.beginPath(); camCtx.arc(x,y,6.5,0,Math.PI*2); camCtx.stroke();
    if(CT.labels) _lbl(x+8,y-6,lbl,col,W);
  });
  camCtx.globalAlpha=1;
}

function _drawArmMap(p2){
  const W=poseMapEl.offsetWidth||260, H=74;
  poseMapEl.width=W; poseMapEl.height=H; pmCtx.clearRect(0,0,W,H);
  const I = SIDE_IDX[ARM_SIDE];
  const pts = [p2[I.sho], p2[I.elb], p2[I.wri], p2[I.hip]];
  if (pts.some(p=>!p)) return;
  /* Caja de encuadre del brazo + cadera para escalar el mini-mapa */
  const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const dx=Math.max(0.05,maxX-minX), dy=Math.max(0.05,maxY-minY);
  const pad=8;
  const mx=p=>((p.x-minX)/dx)*(W-2*pad)+pad;
  const my=p=>((p.y-minY)/dy)*(H-2*pad)+pad;

  pmCtx.globalAlpha=0.55; pmCtx.strokeStyle='#907878'; pmCtx.lineWidth=1.0;
  pmCtx.beginPath(); pmCtx.moveTo(mx(p2[I.sho]),my(p2[I.sho])); pmCtx.lineTo(mx(p2[I.hip]),my(p2[I.hip])); pmCtx.stroke();
  const segs=[[I.sho,I.elb,'#D4A040'],[I.elb,I.wri,'#8C1428']];
  segs.forEach(([a,b,col])=>{
    pmCtx.globalAlpha=0.90; pmCtx.strokeStyle=col; pmCtx.lineWidth=2.0; pmCtx.lineCap='round';
    pmCtx.beginPath(); pmCtx.moveTo(mx(p2[a]),my(p2[a])); pmCtx.lineTo(mx(p2[b]),my(p2[b])); pmCtx.stroke();
  });
  [[I.sho,'#D4A040'],[I.elb,'#C4742C'],[I.wri,'#8C1428']].forEach(([i,col])=>{
    pmCtx.globalAlpha=1; pmCtx.beginPath(); pmCtx.arc(mx(p2[i]),my(p2[i]),3,0,Math.PI*2);
    pmCtx.fillStyle=col; pmCtx.fill();
  });
  pmCtx.globalAlpha=1;
}

/* ─── Dibujar rastro ─────────────────────────────────────────── */
function _drawTrail(W,H){
  TRAIL.forEach((p,i)=>{
    if(!i)return;
    camCtx.globalAlpha=(i/TRAIL.length)*0.55;
    camCtx.strokeStyle='#8C1428'; camCtx.lineWidth=1.5+(i/TRAIL.length)*2.5; camCtx.lineCap='round';
    camCtx.beginPath(); camCtx.moveTo(TRAIL[i-1].x*W,TRAIL[i-1].y*H); camCtx.lineTo(p.x*W,p.y*H); camCtx.stroke();
  });
  camCtx.globalAlpha=1;
}

/* ─── Conexiones de la mano ──────────────────────────────────── */
const HAND_CONN=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]];
const FG_COL=['#D4A040','#D4A040','#D4A040','#D4A040','#D4A040','#8C1428','#8C1428','#8C1428','#8C1428','#A07878','#A07878','#A07878','#A07878','#907070','#907070','#907070','#907070','#806068','#806068','#806068','#806068'];

function _drawHand(lm,W,H){
  const x=i=>lm[i].x*W, y=i=>lm[i].y*H;
  HAND_CONN.forEach(([a,b])=>{
    camCtx.globalAlpha=0.70; camCtx.strokeStyle='#907070'; camCtx.lineWidth=1.6; camCtx.lineCap='round';
    camCtx.beginPath(); camCtx.moveTo(x(a),y(a)); camCtx.lineTo(x(b),y(b)); camCtx.stroke();
  });
  camCtx.globalAlpha=1;
  lm.forEach((p,i)=>{
    const px=p.x*W, py=p.y*H;
    const r=(i===4||i===8)?5.5:(i===0)?4.5:2.8;
    const col=FG_COL[i]||'#907878';
    if(i===4||i===8){ camCtx.globalAlpha=0.22; camCtx.beginPath(); camCtx.arc(px,py,9,0,Math.PI*2); camCtx.fillStyle=col; camCtx.fill(); camCtx.globalAlpha=1; }
    camCtx.beginPath(); camCtx.arc(px,py,r,0,Math.PI*2); camCtx.fillStyle=col; camCtx.fill();
    if(i===4||i===8){ camCtx.strokeStyle='rgba(255,255,250,0.88)'; camCtx.lineWidth=1.3; camCtx.beginPath(); camCtx.arc(px,py,r+2.5,0,Math.PI*2); camCtx.stroke(); }
    if(CT.labels&&(i===4||i===8||i===0)) _lbl(px+7,py-5,i===4?'PULGAR':i===8?'ÍNDICE':'',col,W);
  });
}

function _drawPinch(lm,W,H){
  const tx=lm[4].x*W, ty=lm[4].y*H, ix=lm[8].x*W, iy=lm[8].y*H;
  const open=pinchOpen(lm)??0;
  const lc=open<0.25?'#6FBA8A':open<0.55?'#D4A830':'#8C1428';
  camCtx.globalAlpha=clamp(1-open*0.6,0.3,1); camCtx.strokeStyle=lc; camCtx.lineWidth=2.0;
  camCtx.setLineDash([4,3]); camCtx.beginPath(); camCtx.moveTo(tx,ty); camCtx.lineTo(ix,iy); camCtx.stroke();
  camCtx.setLineDash([]); camCtx.globalAlpha=1;
  _lbl((tx+ix)/2+2,(ty+iy)/2-7, open<0.25?'✓ CERRADO':(open*100).toFixed(0)+'% ABIERTO', lc, W);
}

function _drawCrossHair(lm,W,H){
  const px=((lm[0].x+lm[5].x+lm[9].x+lm[13].x+lm[17].x)/5)*W;
  const py=((lm[0].y+lm[5].y+lm[9].y+lm[13].y+lm[17].y)/5)*H;
  const cs=8;
  camCtx.globalAlpha=0.62; camCtx.strokeStyle='#D4A830'; camCtx.lineWidth=1.3;
  camCtx.beginPath(); camCtx.moveTo(px-cs,py); camCtx.lineTo(px+cs,py); camCtx.stroke();
  camCtx.beginPath(); camCtx.moveTo(px,py-cs); camCtx.lineTo(px,py+cs); camCtx.stroke();
  camCtx.globalAlpha=1;
}

function _lbl(x,y,txt,col,W){
  const fs=Math.max(7,Math.round(W*0.032));
  camCtx.font=`600 ${fs}px IBM Plex Mono,monospace`;
  camCtx.strokeStyle='rgba(253,250,246,0.88)'; camCtx.lineWidth=2.2;
  camCtx.strokeText(txt,x,y); camCtx.fillStyle=col; camCtx.fillText(txt,x,y);
}

function _drawHandMap(lm){
  const W=poseMapEl.offsetWidth||260, H=74;
  poseMapEl.width=W; poseMapEl.height=H; pmCtx.clearRect(0,0,W,H);
  if(!lm)return;
  const mx=i=>lm[i].x*W*0.82+W*0.09, my=i=>lm[i].y*H*0.88+H*0.06;
  HAND_CONN.forEach(([a,b])=>{
    pmCtx.globalAlpha=0.60; pmCtx.strokeStyle='#907878'; pmCtx.lineWidth=0.9; pmCtx.lineCap='round';
    pmCtx.beginPath(); pmCtx.moveTo(mx(a),my(a)); pmCtx.lineTo(mx(b),my(b)); pmCtx.stroke();
  });
  lm.forEach((p,i)=>{
    const col=i===4?'#D4A830':i===8?'#8C1428':'#907878';
    pmCtx.globalAlpha=0.82;
    pmCtx.beginPath(); pmCtx.arc(mx(i),my(i),(i===4||i===8)?2.5:1.4,0,Math.PI*2);
    pmCtx.fillStyle=col; pmCtx.fill();
  });
  pmCtx.globalAlpha=1;
}

/* ═══════════════════════════════════════════════
   INICIO DE CÁMARA
   ─────────────────────────────────────────────────────────────
   Orden para evitar bugs:
   1. getUserMedia → stream (puede fallar aquí si no hay permisos)
   2. Asignar al video y esperar metadata
   3. MOSTRAR overlay e iniciar drawLoop rAF INMEDIATAMENTE
   4. Inicializar MediaPipe en background (no bloquea el draw loop)
   ═══════════════════════════════════════════════ */
async function startCam() {
  const btnStart = document.getElementById('btn-cam-start');
  btnStart.textContent = 'Conectando…';
  btnStart.disabled    = true;

  try {
    /* 1. Stream de video */
    const constraints = { video:{
      width:{ideal:640}, height:{ideal:480}, frameRate:{ideal:30},
      ...(selectedDevId ? {deviceId:{exact:selectedDevId}} : {facingMode:'user'}),
    }};
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    camVideo.srcObject  = stream;
    camVideo.muted      = true;
    camVideo.playsInline= true;

    /* Esperar metadata (no esperar canplay — más rápido) */
    await new Promise(resolve => {
      if (camVideo.readyState >= 1) { resolve(); return; }
      camVideo.onloadedmetadata = resolve;
    });
    camVideo.play().catch(()=>{});  /* play no-await para no bloquear */

    /* 2. Activar UI y drawLoop ANTES de inicializar MediaPipe */
    camActive = true;
    window.__camOn = true;    // bloquea BASE (shared.js la ignora en visión)
    _ui('cam-mode-lbl', 'INICIANDO…');
    document.getElementById('cam-overlay').style.display    = 'flex';
    document.getElementById('signal-bar').style.display     = 'flex';
    document.getElementById('amp-hud').style.display        = 'flex';
    document.getElementById('st-cam').className             = 'chip on';
    document.getElementById('btn-mirror').disabled          = false;
    document.getElementById('btn-mirror').style.opacity     = '1';
    document.getElementById('ft-mode').textContent          = 'Vista: Seguimiento por mano';
    btnStart.style.display                                   = 'none';
    document.getElementById('btn-cam-stop').style.display   = 'block';
    document.getElementById('btn-overlay-stop').style.display = 'inline-flex';
    log('Cámara activada — iniciando seguimiento…', 'ok');

    /* Resetear filtros al objetivo actual (evita saltos al iniciar) */
    setJointTarget('sho', J.sho.target);
    JDEFS.forEach(d=>{ F[d.key].e1=F[d.key].e2=J[d.key].target; });
    if (typeof refreshManualRangeUi === 'function') refreshManualRangeUi();
    lockBaseToKeyboardOnly();
    setBaseUiLock(true);
    log('Base reservada al teclado en este modo — usa Q/A', 'info');

    /* Iniciar draw loop rAF — el video es visible desde AQUÍ */
    _frameCount=0; _fpsFrames=0; _fpsLast=performance.now();
    drawLoop();

    /* Re-enumerar cámaras con permisos reales */
    populateCameraList();

    /* 3. Inicializar MediaPipe en background (no bloquea el drawLoop) */
    _initMediaPipe();

  } catch(err) {
    btnStart.textContent   = '▶ Activar cámara';
    btnStart.disabled      = false;
    btnStart.style.display = 'block';
    document.getElementById('btn-cam-stop').style.display     = 'none';
    document.getElementById('btn-overlay-stop').style.display = 'none';
    document.getElementById('cam-overlay').style.display      = 'none';
    camActive = false;
    window.__camOn = false;
    log('Error: ' + err.message, 'err');
    modal('No se pudo activar la cámara',
      'La cámara no pudo iniciarse en este momento.\n\n' +
      '• Verifica los permisos del navegador\n' +
      '• Comprueba si la cámara está siendo utilizada por otra aplicación\n' +
      '• Asegúrate de abrir la página desde HTTPS o localhost\n\n' + err.message);
  }
}

/* Inicializa Pose + Hands en background — no bloquean el draw loop */
async function _initMediaPipe() {
  const havePose  = typeof Pose  !== 'undefined';
  const haveHands = typeof Hands !== 'undefined';
  if (!havePose && !haveHands) {
    log('MediaPipe no disponible', 'err');
    _ui('cam-mode-lbl', 'NO DISP.');
    return;
  }

  /* Pose — fuente primaria (brazo completo) */
  if (havePose) {
    try {
      poseInst = new Pose({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}` });
      poseInst.setOptions({
        modelComplexity:        0,    // rápido (lite)
        smoothLandmarks:        true,
        enableSegmentation:     false,
        minDetectionConfidence: 0.55,
        minTrackingConfidence:  0.55,
      });
      poseInst.onResults(onPoseResults);
      await poseInst.initialize();
      if (!camActive) return;
      mpReady = true;
      _ui('cam-mode-lbl', 'SEGUIMIENTO');
      log('Seguimiento corporal listo ✓', 'ok');
    } catch(e) {
      log('Error Pose: ' + e.message, 'err');
    }
  }

  /* Hands — aporta pinza y roll fino de muñeca */
  if (haveHands) {
    try {
      handInst = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
      handInst.setOptions({
        maxNumHands:            1,
        modelComplexity:        0,
        minDetectionConfidence: 0.55,
        minTrackingConfidence:  0.55,
      });
      handInst.onResults(onHandResults);
      await handInst.initialize();
      if (!camActive) return;
      handsReady = true;
      document.getElementById('st-hand').className = 'chip on';
      log('Seguimiento de mano listo ✓', 'ok');
    } catch(e) {
      log('Error Hands: ' + e.message, 'err');
    }
  }

  if (!mpReady && !handsReady) _ui('cam-mode-lbl', 'ERROR');
}

/* ─── Parar cámara ───────────────────────────────────────────── */
/* Restablece el modo manual por completo: libera MediaPipe, apaga el
   stream y devuelve la UI a un estado neutro. */
function stopCam() {
  camActive = false;
  window.__camOn = false;   // desbloquea BASE
  mpReady   = false;
  handsReady= false;
  _armFrozen= false;
  setBaseUiLock(false);
  if (typeof refreshManualRangeUi === 'function') refreshManualRangeUi();
  latestHand= null;
  latestHandRaw = null;
  latestPose2D    = null;
  latestPose2DRaw = null;
  latestPoseWorld = null;

  if (_rafId) { cancelAnimationFrame(_rafId); _rafId=null; }
  if (handInst) { try{handInst.close();}catch(e){} handInst=null; }
  if (poseInst) { try{poseInst.close();}catch(e){} poseInst=null; }
  if (camVideo.srcObject) { camVideo.srcObject.getTracks().forEach(t=>t.stop()); camVideo.srcObject=null; }

  TRAIL.length=0;
  camCtx.clearRect(0,0,camCanvas.width,camCanvas.height);
  pmCtx.clearRect(0,0,poseMapEl.width,poseMapEl.height);

  document.getElementById('cam-overlay').style.display    = 'none';
  document.getElementById('signal-bar').style.display     = 'none';
  document.getElementById('amp-hud').style.display        = 'none';
  ['st-cam','st-hand'].forEach(id=>document.getElementById(id).className='chip');

  const bs=document.getElementById('btn-cam-start');
  bs.textContent='▶ Activar cámara'; bs.disabled=false; bs.style.display='block';
  document.getElementById('btn-cam-stop').style.display    = 'none';
  document.getElementById('btn-overlay-stop').style.display = 'none';
  document.getElementById('btn-mirror').disabled = true;
  document.getElementById('btn-mirror').style.opacity = '.4';
  document.getElementById('ft-mode').textContent = 'Vista: Control';
  log('Cámara detenida', 'info');
}
window.stopCam = stopCam;

/* ─── Listeners de controles ─────────────────────────────────── */
// Botones principales del panel de visión.
document.getElementById('btn-cam-start').addEventListener('click', startCam);
document.getElementById('btn-cam-stop').addEventListener('click', stopCam);
document.getElementById('btn-overlay-stop').addEventListener('click', stopCam);

document.getElementById('btn-mirror').addEventListener('click', function(){
  mirrorOn = !mirrorOn;
  syncVisionMirrorState();
  updateMirrorButton();
});

// Sensibilidades y filtros se aplican en vivo para afinar el seguimiento.
document.getElementById('sl-sens-x').addEventListener('input',function(){ SENS_X=parseFloat(this.value); _ui('lv-sens-x',SENS_X+'°'); });
document.getElementById('sl-sens-y').addEventListener('input',function(){ SENS_Y=parseFloat(this.value); _ui('lv-sens-y',SENS_Y+'°'); });
document.getElementById('sl-sens-z').addEventListener('input',function(){ SENS_Z=parseFloat(this.value); _ui('lv-sens-z',SENS_Z+'°'); });
document.getElementById('sl-smooth').addEventListener('input',function(){ ALPHA2=parseFloat(this.value); _ui('lv-smooth',ALPHA2.toFixed(2)); });
document.getElementById('sl-smooth2').addEventListener('input',function(){ ALPHA1=parseFloat(this.value); _ui('lv-smooth2',ALPHA1.toFixed(2)); });
disableVisionBaseControls();
updateMirrorButton();

/* ══════════════════════════════════ OVERLAY ARRASTRABLE ══════════════════════════════════ */
/* El overlay puede anclarse a esquinas o moverse libremente sin afectar
   el pipeline de visión, porque solo manipula estilos del contenedor. */
(function(){
  const ov=document.getElementById('cam-overlay');
  const hdr=document.getElementById('cam-hdr');
  const btnMin=document.getElementById('btn-cam-minimize');
  const btnSnap=document.getElementById('btn-cam-snap');
  const btnStop=document.getElementById('btn-overlay-stop');
  let drag=false,ox=0,oy=0,snapped=true,si=0;
  const SNAPS=['bl','br','tl','tr'];

  function snapTo(s){
    const ow=ov.offsetWidth,oh=ov.offsetHeight,pad=14,vw=window.innerWidth,vh=window.innerHeight;
    const map={bl:[pad,vh-oh-pad-34],br:[vw-ow-pad,vh-oh-pad-34],tl:[pad,56+pad],tr:[vw-ow-pad,56+pad]};
    const [l,t]=map[s]||[pad,vh-oh-pad-34];
    Object.assign(ov.style,{left:l+'px',top:t+'px',bottom:'auto',right:'auto'});
  }
  const isCtrl=e=>e===btnMin||e===btnSnap||e===btnStop;
  function startD(cx,cy){drag=true;snapped=false;const r=ov.getBoundingClientRect();ox=cx-r.left;oy=cy-r.top;ov.classList.add('dragging');hdr.style.cursor='grabbing';}
  function moveD(cx,cy){if(!drag)return;ov.style.left=clamp(cx-ox,0,innerWidth-ov.offsetWidth)+'px';ov.style.top=clamp(cy-oy,0,innerHeight-ov.offsetHeight)+'px';ov.style.bottom='auto';ov.style.right='auto';}
  function endD(){drag=false;ov.classList.remove('dragging');hdr.style.cursor='grab';}

  hdr.addEventListener('mousedown',e=>{if(!isCtrl(e.target)){startD(e.clientX,e.clientY);e.preventDefault();}});
  document.addEventListener('mousemove',e=>moveD(e.clientX,e.clientY));
  document.addEventListener('mouseup',endD);
  hdr.addEventListener('touchstart',e=>{if(!isCtrl(e.target))startD(e.touches[0].clientX,e.touches[0].clientY);},{passive:true});
  document.addEventListener('touchmove',e=>{if(drag)moveD(e.touches[0].clientX,e.touches[0].clientY);},{passive:true});
  document.addEventListener('touchend',endD);

  btnMin.addEventListener('click',()=>{const m=ov.classList.toggle('minimized');btnMin.textContent=m?'+':'—';btnMin.title=m?'Restaurar':'Minimizar';});
  btnSnap.addEventListener('click',()=>{si=(si+1)%SNAPS.length;snapped=true;snapTo(SNAPS[si]);});
  window.addEventListener('resize',()=>{if(snapped)snapTo(SNAPS[si]);});
})();
