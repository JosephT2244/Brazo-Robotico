/* ════════════════════════════════════════════════
   shared.js — Estado global, utilidades y marco de UI
   ────────────────────────────────────────────────────────────────
   Este archivo se carga PRIMERO. Define todo lo que los demás
   módulos necesitan: el estado de articulaciones (J), funciones
   matemáticas, actualización de UI y gestión del sidebar.

   Dependencias: ninguna (es la base de todo)
   ════════════════════════════════════════════════ */


/* ──────────────────────────────────────────────────────────────
   DEFINICIÓN DE ARTICULACIONES
   Cada articulación tiene:
   • key    → identificador interno (coincide con IDs del DOM)
   • min/max → límites por defecto (pueden ser sobreescritos por calibración)
   • def    → posición HOME (posición segura de inicio)
   • lbl    → etiqueta para la UI de calibración
   ────────────────────────────────────────────────────────────── */
const ANGLE_STEP_DEG  = 1;
const MANUAL_STEP_DEG = 10;
const DEFAULT_SPEED_DPS = 8;
const MIN_SPEED_DPS     = 10;
const MAX_SPEED_DPS     = 18;
// Apertura física extra solicitada para base, hombro y codo.
const PHYSICAL_LIMITS = {
  base: 120,
  sho:   75,
  elb:   60,
  wri:   90,
  grip:  30,
};
// Topes extra cuando la cámara está activa. Se expresan como ±grados
// alrededor del 0 lógico de cada articulación.
const VISION_ACTIVE_LIMITS = {
  sho: 45,  // 90° totales mientras la visión esté encendida
};
const JDEFS = [
  { key:'base', min:-PHYSICAL_LIMITS.base, max: PHYSICAL_LIMITS.base, def:0, lbl:'BASE',   dps: DEFAULT_SPEED_DPS, angLim: PHYSICAL_LIMITS.base, maxSecs: 0.18 },
  { key:'sho',  min:-PHYSICAL_LIMITS.sho,  max: PHYSICAL_LIMITS.sho,  def:0, lbl:'HOMBRO', dps: DEFAULT_SPEED_DPS, angLim: PHYSICAL_LIMITS.sho,  maxSecs: 0.18 },
  { key:'elb',  min:-PHYSICAL_LIMITS.elb,  max: PHYSICAL_LIMITS.elb,  def:0, lbl:'CODO',   dps: DEFAULT_SPEED_DPS, angLim: PHYSICAL_LIMITS.elb,  maxSecs: 0.18 },
  { key:'wri',  min:-PHYSICAL_LIMITS.wri,  max: PHYSICAL_LIMITS.wri,  def:0, lbl:'MUÑECA', dps: DEFAULT_SPEED_DPS, angLim: PHYSICAL_LIMITS.wri,  maxSecs: 0.18 },
  { key:'grip', min:-PHYSICAL_LIMITS.grip, max: PHYSICAL_LIMITS.grip, def:0, lbl:'PINZA',  dps: DEFAULT_SPEED_DPS, angLim: PHYSICAL_LIMITS.grip, maxSecs: 0.18 },
];

/* ──────────────────────────────────────────────────────────────
   ESTADO GLOBAL DE ARTICULACIONES
   J es el objeto central compartido por todos los módulos.
   Cada entrada: { v: valor_actual, calMin: mínimo, calMax: máximo }
   ────────────────────────────────────────────────────────────── */
const J = {};
JDEFS.forEach(d => {
  J[d.key] = {
    v:        0,        // Pulso actual en SEGUNDOS (dura 1 ciclo de commit)
    target:   0,        // Ángulo objetivo en GRADOS (lo que mueve UI/visión)
    committed:0,        // Posición "enviada" acumulada en GRADOS (= angPos para display)
    home:     d.def,    // HOME de referencia (software) persistible
    calMin:   d.min,
    calMax:   d.max,
    dpsBase:  d.dps,
    dps:      d.dps,
    angPos:   0,
    angLim:   d.angLim,
    maxSecs:  d.maxSecs,
  };
});

/* ──────────────────────────────────────────────────────────────
   PERSISTENCIA DE VELOCIDADES (grados/segundo) calibradas
   ────────────────────────────────────────────────────────────── */
// v3: velocidad lenta por defecto para correcciones manuales cortas y más controlables.
const DPS_KEY = 'roboarm-dps-v3';
let speedDps = DEFAULT_SPEED_DPS;
try {
  localStorage.removeItem('roboarm-dps-v1');   // limpiar clave vieja
  localStorage.removeItem('roboarm-dps-v2');
  const saved = JSON.parse(localStorage.getItem(DPS_KEY) || 'null');
  if (saved) JDEFS.forEach(d => {
    if (typeof saved[d.key] === 'number' && saved[d.key] > 0)
      J[d.key].dpsBase = saved[d.key];
  });
} catch (e) { /* usar defaults */ }

// Reescala las velocidades calibradas de cada joint según el perfil global.
function applySpeedProfile(nextDps = speedDps) {
  speedDps = Math.max(MIN_SPEED_DPS, Math.min(MAX_SPEED_DPS, nextDps));
  const scale = speedDps / DEFAULT_SPEED_DPS;
  JDEFS.forEach(d => {
    J[d.key].dps = Math.max(1, J[d.key].dpsBase * scale);
  });
  return speedDps;
}
applySpeedProfile(speedDps);

// Persiste la velocidad base medida por articulación para futuras sesiones.
function saveDps() {
  const data = {};
  JDEFS.forEach(d => { data[d.key] = J[d.key].dpsBase; });
  try { localStorage.setItem(DPS_KEY, JSON.stringify(data)); } catch(e) {}
}

/* ──────────────────────────────────────────────────────────────
   MODELO DE PULSOS DISCRETOS (commit cycle)
   ────────────────────────────────────────────────────────────────
   Problema anterior: el controlador rAF refrescaba j.v cada 16 ms,
   y sendPos lo enviaba cada ~80 ms. El firmware reseteaba sv[i].t
   con CADA pulso recibido, así que un servo que debía moverse 10°
   nunca se paraba — siempre había un nuevo pulso reiniciando el
   temporizador antes de que el anterior terminase. Resultado:
   "1 vuelta completa" en vez de los grados solicitados.

   Solución: emitir UN pulso discreto cada COMMIT_MS, ligeramente
   mayor que maxSecs (139 ms de la muñeca). Así el firmware tiene
   tiempo de terminar el pulso antes de recibir el siguiente.
   Se tiene:
     • j.target    → grados deseados (UI/visión lo mueven)
     • j.committed → grados ya "enviados" al firmware (acumulador)
     • j.v         → segundos del pulso actual (0 entre ciclos)
   ────────────────────────────────────────────────────────────── */
const _POS_TOL    = 0.35;
const COMMIT_MS   = 200;
const PULSE_CAP_S = 0.18;
const MANUAL_SETTLE_MS = COMMIT_MS + 40;

const _manualQueue   = {};
const _manualBusy    = {};
const _manualToken   = {};
const _manualPlanned = {};
const HOLD_ASSIST = {
  // Punto medio: ayuda visible, pero sin sostén continuo para evitar runaway.
  sho: { activeAboveDeg: 3, liftSign: -1, minSecs: 0.060, maxSecs: 0.090, sessionMs: 2800, keepAlive: true, resendMs: 145, enabledInVision: true, settleTolDeg: 2.3, pulseStepSecs: 0.008 },
  // Codo: se asume positivo = flexionar/elevar el antebrazo.
  elb: { activeAboveDeg: 10, liftSign: +1, minSecs: 0.085, maxSecs: 0.125, sessionMs: 9000, keepAlive: true, resendMs: 45, enabledInVision: true },
};
const _holdAssistActive = {};
const _holdAssistUntil  = {};
const _holdAssistSince  = {};

JDEFS.forEach(d => {
  _manualQueue[d.key]   = [];
  _manualBusy[d.key]    = false;
  _manualToken[d.key]   = 0;
  _manualPlanned[d.key] = d.def;
  _holdAssistActive[d.key] = false;
  _holdAssistUntil[d.key]  = 0;
  _holdAssistSince[d.key]  = 0;
});

const _sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Devuelve el perfil de asistencia contra gravedad si aplica a la articulación.
function getHoldAssistProfile(key) {
  const profile = HOLD_ASSIST[key];
  if (!profile || !J[key]) return null;
  if (window.__camOn && profile.enabledInVision === false) return null;
  return profile;
}

// Ajusta la tolerancia de "ya llegué" cuando una articulación usa hold assist.
function jointSettleTol(key) {
  return getHoldAssistProfile(key)?.settleTolDeg ?? _POS_TOL;
}

// Cuantiza la duración del pulso para evitar microcambios inútiles en firmware.
function snapPulseSecs(secs, stepDeg) {
  const step = Math.max(0.0005, Math.abs(stepDeg || 0));
  if (Math.abs(secs) < step) return 0;
  return Math.sign(secs) * Math.round(Math.abs(secs) / step) * step;
}

// Límite mínimo efectivo considerando calibración y modo visión.
function jointMin(key) {
  const baseMin = Math.max(-J[key].angLim, J[key].calMin);
  const visionCap = window.__camOn ? VISION_ACTIVE_LIMITS[key] : null;
  if (typeof visionCap !== 'number') return baseMin;
  return Math.max(baseMin, -Math.min(J[key].angLim, Math.abs(visionCap)));
}

// Límite máximo efectivo considerando calibración y modo visión.
function jointMax(key) {
  const baseMax = Math.min(J[key].angLim, J[key].calMax);
  const visionCap = window.__camOn ? VISION_ACTIVE_LIMITS[key] : null;
  if (typeof visionCap !== 'number') return baseMax;
  return Math.min(baseMax, Math.min(J[key].angLim, Math.abs(visionCap)));
}

// Recorta cualquier ángulo al rango operativo realmente permitido.
function clampJointDeg(key, deg) {
  if (!J[key]) return deg;
  return clamp(deg, jointMin(key), jointMax(key));
}

// Lee el HOME persistido y lo fuerza al rango válido actual.
function getJointHome(key) {
  if (!J[key]) return 0;
  return clampJointDeg(key, typeof J[key].home === 'number' ? J[key].home : 0);
}

// Guarda una nueva referencia HOME, ya normalizada a la malla de pasos.
function setJointHome(key, deg) {
  if (!J[key]) return 0;
  J[key].home = snapTargetDeg(key, deg);
  return getJointHome(key);
}

// Entrega la pose HOME completa para serializarla o reutilizarla en bloque.
function getHomePoseMap() {
  const map = {};
  JDEFS.forEach(d => { map[d.key] = getJointHome(d.key); });
  return map;
}

// Toma la pose actual estimada como nueva referencia HOME temporal.
function captureCurrentPoseAsHome() {
  const map = {};
  JDEFS.forEach(d => {
    map[d.key] = setJointHome(d.key, J[d.key].angPos);
  });
  return map;
}

// Manda todas las articulaciones a su referencia HOME actual.
function moveToHomePose() {
  JDEFS.forEach(d => setJointTarget(d.key, getJointHome(d.key)));
}

// Redondea un delta manual al tamaño de paso permitido.
function snapDeltaDeg(deg, stepDeg = ANGLE_STEP_DEG) {
  if (!isFinite(deg) || !deg) return 0;
  const step = Math.max(0.001, Math.abs(stepDeg));
  const snapped = Math.round(deg / step) * step;
  return snapped || Math.sign(deg) * step;
}

// Ajusta un objetivo absoluto al rango y a la rejilla angular del sistema.
function snapTargetDeg(key, deg, stepDeg = ANGLE_STEP_DEG) {
  if (!J[key]) return deg;
  const clamped = clampJointDeg(key, deg);
  if (Math.abs(clamped) < 1e-9 || clamped === jointMin(key) || clamped === jointMax(key))
    return clamped;
  const step = Math.max(0.001, Math.abs(stepDeg));
  return clampJointDeg(key, Math.round(clamped / step) * step);
}

// Mide cuánto "peso" está sosteniendo la articulación según su elevación.
function jointRaisedDeg(key) {
  const profile = getHoldAssistProfile(key);
  if (!profile || !J[key]) return 0;
  return Math.max(
    0,
    profile.liftSign * J[key].angPos,
    profile.liftSign * J[key].target,
  );
}

// Extiende la ventana temporal en la que se permite mantener empuje extra.
function armJointHoldAssist(key, now = performance.now()) {
  const profile = getHoldAssistProfile(key);
  if (!profile || !J[key]) return;
  if (_holdAssistUntil[key] < now) _holdAssistSince[key] = now;
  _holdAssistUntil[key] = now + profile.sessionMs;
}

// Limpia por completo el estado temporal de asistencia para un joint.
function clearJointHoldAssist(key) {
  _holdAssistActive[key] = false;
  _holdAssistUntil[key] = 0;
  _holdAssistSince[key] = 0;
}

// Calcula si el joint necesita un pequeño pulso de sostén y de qué magnitud.
function jointHoldAssistState(key, now = performance.now()) {
  const profile = getHoldAssistProfile(key);
  if (!profile || !J[key]) return { active: false, secs: 0 };
  if (now >= _holdAssistUntil[key]) return { active: false, secs: 0 };
  const raisedDeg = jointRaisedDeg(key);
  if (raisedDeg <= profile.activeAboveDeg) return { active: false, secs: 0 };
  const span = Math.max(1, J[key].angLim - profile.activeAboveDeg);
  const loadT = clamp((raisedDeg - profile.activeAboveDeg) / span, 0, 1);
  const amp = Math.min(
    PULSE_CAP_S,
    profile.minSecs + (profile.maxSecs - profile.minSecs) * loadT,
  );
  const secs = snapPulseSecs(profile.liftSign * amp, profile.pulseStepSecs);
  if (Math.abs(secs) < 0.0005) return { active: false, secs: 0 };
  return { active: true, secs };
}

function isJointHoldAssistActive(key) {
  return !!_holdAssistActive[key];
}

function hasActiveHoldAssist() {
  return Object.values(_holdAssistActive).some(Boolean);
}

function hasContinuousHoldAssist() {
  return Object.keys(_holdAssistActive).some(key => {
    if (!_holdAssistActive[key]) return false;
    return !!(getHoldAssistProfile(key)?.keepAlive);
  });
}

// Cuando varias articulaciones sostienen carga, usamos el resend más conservador.
function currentContinuousHoldResendMs() {
  let resendMs = null;
  Object.keys(_holdAssistActive).forEach(key => {
    if (!_holdAssistActive[key]) return;
    const profile = getHoldAssistProfile(key);
    if (!profile?.keepAlive) return;
    const nextMs = Math.max(40, profile.resendMs || 45);
    resendMs = resendMs == null ? nextMs : Math.max(resendMs, nextMs);
  });
  return resendMs;
}

/* Núcleo del movimiento: traduce targets angulares a pulsos discretos,
   actualiza la estimación interna y refresca la UI una sola vez por ciclo. */
function _commitAll() {
  let anyChanged = false;
  JDEFS.forEach(d => {
    const j    = J[d.key];
    const tgt  = clampJointDeg(d.key, j.target);
    const diff = tgt - j.committed;
    const now  = performance.now();
    const posTol = jointSettleTol(d.key);

    if (Math.abs(diff) < posTol) {
      const hold = jointHoldAssistState(d.key, now);
      const nextSecs = hold.secs;
      _holdAssistActive[d.key] = hold.active;
      if (!hold.active) clearJointHoldAssist(d.key);
      if (Math.abs(j.v - nextSecs) > 0.0004) { j.v = nextSecs; anyChanged = true; }
      return;
    }

    _holdAssistActive[d.key] = false;
    const dps = Math.max(1, j.dps);
    const maxP = Math.min(j.maxSecs, PULSE_CAP_S);
    const sec = clamp(diff / dps, -maxP, maxP);
    if (Math.abs(sec) >= 0.0005) armJointHoldAssist(d.key, now);
    // Avanzar committed por el ángulo que el pulso realmente producirá
    j.committed = clampJointDeg(d.key, j.committed + sec * dps);
    j.angPos    = j.committed;
    j.v         = sec;
    anyChanged  = true;
  });
  if (anyChanged && !_rafPending) {
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      if (typeof applyArm === 'function') applyArm();
      refreshUI();
    });
  }
}
setInterval(_commitAll, COMMIT_MS);

/** Resetea la estimación angular (útil al enviar HOME). */
function resetAngPos() {
  cancelAllQueuedMoves({ holdPosition: false });
  JDEFS.forEach(d => {
    const home = getJointHome(d.key);
    J[d.key].angPos    = home;
    J[d.key].target    = home;
    J[d.key].committed = home;
    J[d.key].v         = 0;
    clearJointHoldAssist(d.key);
    _manualPlanned[d.key] = home;
  });
}

// Actualiza solo el target lógico; el commit cycle emitirá los pulsos reales.
function _setJointTargetRaw(key, deg) {
  if (!J[key]) return;
  J[key].target = snapTargetDeg(key, deg);
  if (!_rafPending) {
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      if (typeof applyArm === 'function') applyArm();
      refreshUI();
    });
  }
}

// Vacía la cola manual de un joint y decide si debe quedarse sosteniendo posición.
function cancelQueuedMoves(key, opts = {}) {
  if (!J[key]) return;
  const holdPosition = opts.holdPosition !== false;
  _manualQueue[key].length = 0;
  _manualBusy[key] = false;
  _manualToken[key]++;
  _manualPlanned[key] = clampJointDeg(key, holdPosition ? J[key].angPos : J[key].target);
  if (holdPosition) _setJointTargetRaw(key, J[key].angPos);
}

// Conveniencia para abortar de una vez todas las colas manuales activas.
function cancelAllQueuedMoves(opts = {}) {
  JDEFS.forEach(d => cancelQueuedMoves(d.key, opts));
}

/** Fija el objetivo angular (grados) de un servo.
 *  El commit cycle se encarga de emitir los pulsos; aquí solo
 *  actualizamos target y refrescamos UI. */
function setJointTarget(key, deg) {
  if (!J[key]) return;
  cancelQueuedMoves(key, { holdPosition: false });
  _setJointTargetRaw(key, deg);
}

async function _runManualQueue(key, token) {
  while (_manualToken[key] === token && _manualQueue[key].length) {
    const goal = _manualQueue[key].shift();
    _manualPlanned[key] = goal;
    _setJointTargetRaw(key, goal);

    const deadline = performance.now() + 15000;
    while (_manualToken[key] === token) {
      const atGoal  = Math.abs(J[key].angPos - goal) <= _POS_TOL;
      const stopped = Math.abs(J[key].v) < 0.0005 || isJointHoldAssistActive(key);
      if (atGoal && stopped) break;
      if (performance.now() > deadline) break;
      await _sleep(30);
    }

    if (_manualToken[key] !== token) break;
    await _sleep(MANUAL_SETTLE_MS);
  }
}

// Arranca el consumidor de cola solo cuando realmente hay trabajo pendiente.
function _ensureManualQueueRunning(key) {
  if (_manualBusy[key]) return;
  _manualBusy[key] = true;
  const token = _manualToken[key];
  _runManualQueue(key, token)
    .catch(() => {})
    .finally(() => {
      if (_manualToken[key] !== token) return;
      _manualBusy[key] = false;
      _manualPlanned[key] = J[key].target;
      if (_manualQueue[key].length) _ensureManualQueueRunning(key);
    });
}

// Descompone un movimiento largo en escalones de MANUAL_STEP_DEG.
function _queueManualTargets(key, fromDeg, toDeg) {
  const step = Math.max(0.001, MANUAL_STEP_DEG);
  let cursor = fromDeg;

  while (true) {
    const remaining = toDeg - cursor;
    if (Math.abs(remaining) < 1e-9) break;

    const rawNext = Math.abs(remaining) <= step
      ? toDeg
      : cursor + Math.sign(remaining) * step;
    const next = snapTargetDeg(key, rawNext, MANUAL_STEP_DEG);

    if (Math.abs(next - cursor) < 1e-9) break;

    _manualQueue[key].push(next);
    cursor = next;
  }

  _manualPlanned[key] = cursor;
  return Math.abs(cursor - fromDeg) > 1e-9;
}

// API pública de pasos manuales: encola sin saltarse los límites físicos.
function queueManualMove(key, degrees) {
  if (!J[key] || !Math.abs(degrees)) return false;

  const delta = snapDeltaDeg(degrees, MANUAL_STEP_DEG);
  const hasPendingManual = _manualBusy[key] || _manualQueue[key].length;
  const base = hasPendingManual ? _manualPlanned[key] : J[key].angPos;

  if (!hasPendingManual && Math.abs(J[key].target - J[key].angPos) > _POS_TOL) {
    _setJointTargetRaw(key, J[key].angPos);
  }

  const nextTarget = snapTargetDeg(key, base + delta, MANUAL_STEP_DEG);
  if (!_queueManualTargets(key, base, nextTarget)) return false;

  _ensureManualQueueRunning(key);
  return true;
}

/** Variante en lote para múltiples servos simultáneos (visión).
 *  BASE se ignora aquí: en modo visión la base no se mueve bajo ninguna vía. */
function batchTargets(map) {
  for (const key in map) {
    if (!J[key]) continue;
    if (key === 'base' && window.__camOn) continue;
    setJointTarget(key, map[key]);
  }
}

/* ──────────────────────────────────────────────────────────────
   MOVIMIENTO EN GRADOS — "muévete N grados desde donde estás".
   Ahora se traduce a una actualización de target: el commit cycle
   emitirá los pulsos necesarios para llegar.
   ────────────────────────────────────────────────────────────── */
function moveDegrees(key, degrees) {
  if (!J[key] || !Math.abs(degrees)) return;
  const j = J[key];
  setJointTarget(key, j.target + snapDeltaDeg(degrees));
}


/* ──────────────────────────────────────────────────────────────
   UTILIDADES MATEMÁTICAS
   Funciones puras usadas en todos los módulos.
   ────────────────────────────────────────────────────────────── */

/** Restringe v entre a y b (inclusive) */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Convierte grados a radianes */
const toRad = d => d * Math.PI / 180;

/** Interpolación lineal: a + (b-a)*t, donde t∈[0,1] */
const lerp  = (a, b, t) => a + (b - a) * t;


/* ──────────────────────────────────────────────────────────────
   ACTUALIZACIÓN EN LOTE (BATCH)
   En lugar de llamar applyArm() + refreshUI() 5 veces por frame
   (una vez por articulación), batchJoints() agrupa todos los
   cambios y ejecuta una sola actualización vía requestAnimationFrame.

   Uso en vision.js:
     batchJoints({ base: 30, sho: 30, elb: 15, wri: 0, grip: 20 });
   ────────────────────────────────────────────────────────────── */
let _rafPending = false;  // Bandera: ¿hay una actualización pendiente?

/* ──────────────────────────────────────────────────────────────
   COMPATIBILIDAD — el proyecto ya opera en GRADOS objetivo.
   setJoint / batchJoints se mantienen como alias legibles para
   módulos viejos (presets, sweep, calibración).
   ────────────────────────────────────────────────────────────── */
function setJoint(key, val) {
  if (!J[key]) return;
  setJointTarget(key, val);
}

// Alias en lote para módulos heredados que aún piensan en "setters" directos.
function batchJoints(targets) {
  for (const key in targets) {
    if (!(key in J)) continue;
    setJointTarget(key, targets[key]);
  }
}


/* ──────────────────────────────────────────────────────────────
   REFRESH UI — Actualiza todos los controles visuales
   Sincroniza sliders, etiquetas de valor y el footer con J.
   Usa un caché de texto para evitar escrituras innecesarias al DOM.
   ────────────────────────────────────────────────────────────── */
const _uiCache = {};  // Caché: {id: ultimo_texto_mostrado}

function refreshUI() {
  JDEFS.forEach(d => {
    const j = J[d.key];
    const ang = j.angPos;
    const tgt = j.target;
    const lbl = Math.abs(ang - tgt) < _POS_TOL
      ? `${ang.toFixed(0)}°`
      : `${ang.toFixed(0)}° → ${tgt.toFixed(0)}°`;

    const sl = document.getElementById('sl-' + d.key);
    if (sl && document.activeElement !== sl) sl.value = tgt;

    _setText('lv-' + d.key, lbl);
    _setText('h-'  + d.key, lbl);
  });

  const fmt = k => `${J[k].angPos.toFixed(0)}°`;
  _setText('ft-ang',
    `B:${fmt('base')}  H:${fmt('sho')}  C:${fmt('elb')}  W:${fmt('wri')}  G:${fmt('grip')}`
  );
}

// Refresco periódico del HUD para mostrar angPos cambiando cuando el servo se mueve
setInterval(() => {
  if (!_rafPending) {
    _rafPending = true;
    requestAnimationFrame(() => { _rafPending = false; refreshUI(); });
  }
}, 120);

/** Actualiza el textContent de un elemento solo si ha cambiado (evita reflows innecesarios) */
function _setText(id, txt) {
  if (_uiCache[id] === txt) return;
  _uiCache[id] = txt;
  const e = document.getElementById(id);
  if (e) e.textContent = txt;
}


/* ──────────────────────────────────────────────────────────────
   LOG DE EVENTOS
   Muestra mensajes con timestamp en la caja de log del viewport.
   Tipos: 'ok' (verde), 'err' (rojo), 'info' (azul), 'tx' (guinda)
   ────────────────────────────────────────────────────────────── */
const logEl = document.getElementById('logbox');

function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = 'll ' + type;
  // Timestamp en formato HH:MM:SS
  div.textContent = new Date().toLocaleTimeString('es-MX', { hour12: false }) + ' ' + msg;
  logEl.appendChild(div);
  // Mantener máximo 14 líneas para no crecer indefinidamente
  while (logEl.children.length > 14) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}


/* ──────────────────────────────────────────────────────────────
   MODAL DE AVISOS
   Muestra un diálogo modal con título y cuerpo de texto.
   ────────────────────────────────────────────────────────────── */
function modal(title, body) {
  document.getElementById('modal-t').textContent = title;
  document.getElementById('modal-b').textContent = body;
  document.getElementById('modalbg').classList.add('show');
}


/* ──────────────────────────────────────────────────────────────
   HIGHLIGHT DE ARTICULACIÓN ACTIVA
   Resalta la tarjeta de la articulación que se está moviendo
   con el teclado (en la pestaña Manual).
   ────────────────────────────────────────────────────────────── */
function hlJ(k) {
  // Quitar highlight de todas
  document.querySelectorAll('.jb').forEach(e => e.classList.remove('kb'));
  // Añadir solo a la articulación activa
  if (k) {
    const e = document.getElementById('jb-' + k);
    if (e) e.classList.add('kb');
  }
}


/* ──────────────────────────────────────────────────────────────
   GESTIÓN DEL SIDEBAR Y PESTAÑAS
   ────────────────────────────────────────────────────────────── */
const sidebar  = document.getElementById('sidebar');
const backdrop = document.getElementById('aside-backdrop');

/** Abre el sidebar lateral */
function openSidebar()  { sidebar.classList.add('open');    backdrop.style.display = 'block'; }

/** Cierra el sidebar lateral */
function closeSidebar() { sidebar.classList.remove('open'); backdrop.style.display = 'none';  }

// Botón hamburguesa del header
document.getElementById('btn-sidebar-toggle').addEventListener('click', () =>
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar()
);

// Clic en el backdrop oscuro cierra el sidebar
backdrop.addEventListener('click', closeSidebar);

/** Cambia la pestaña activa en sidebar y nav inferior */
function switchTab(t) {
  document.querySelectorAll('.tab').forEach(x =>
    x.classList.toggle('active', x.dataset.t === t));
  document.querySelectorAll('.pane').forEach(x =>
    x.classList.toggle('active', x.id === 'pane-' + t));
}

// Pestañas del sidebar (desktop)
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    switchTab(tab.dataset.t);
    // En móvil, abrir el sidebar si está cerrado
    if (window.matchMedia('(max-width:900px)').matches && !sidebar.classList.contains('open'))
      openSidebar();
  });
});

// Botones de navegación inferior (móvil)
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.t;
    document.querySelectorAll('.nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.t === t));
    switchTab(t);
    // Si la pestaña ya está activa y el sidebar abierto → cerrar; si no → abrir
    const currentTab = document.querySelector('.tab.active');
    currentTab && currentTab.dataset.t === t && sidebar.classList.contains('open')
      ? closeSidebar()
      : openSidebar();
  });
});
