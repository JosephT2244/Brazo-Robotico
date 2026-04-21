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
const JDEFS = [
  { key:'base', min:-90, max: 90, def:0, lbl:'BASE',   dps: DEFAULT_SPEED_DPS, angLim: 90, maxSecs: 0.18 },
  { key:'sho',  min:-45, max: 45, def:0, lbl:'HOMBRO', dps: DEFAULT_SPEED_DPS, angLim: 45, maxSecs: 0.18 },
  { key:'elb',  min:-30, max: 30, def:0, lbl:'CODO',   dps: DEFAULT_SPEED_DPS, angLim: 30, maxSecs: 0.18 },
  { key:'wri',  min:-90, max: 90, def:0, lbl:'MUÑECA', dps: DEFAULT_SPEED_DPS, angLim: 90, maxSecs: 0.18 },
  { key:'grip', min:-30, max: 30, def:0, lbl:'PINZA',  dps: DEFAULT_SPEED_DPS, angLim: 30, maxSecs: 0.18 },
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

function applySpeedProfile(nextDps = speedDps) {
  speedDps = Math.max(MIN_SPEED_DPS, Math.min(MAX_SPEED_DPS, nextDps));
  const scale = speedDps / DEFAULT_SPEED_DPS;
  JDEFS.forEach(d => {
    J[d.key].dps = Math.max(1, J[d.key].dpsBase * scale);
  });
  return speedDps;
}
applySpeedProfile(speedDps);

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

JDEFS.forEach(d => {
  _manualQueue[d.key]   = [];
  _manualBusy[d.key]    = false;
  _manualToken[d.key]   = 0;
  _manualPlanned[d.key] = d.def;
});

const _sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function jointMin(key) {
  return Math.max(-J[key].angLim, J[key].calMin);
}

function jointMax(key) {
  return Math.min(J[key].angLim, J[key].calMax);
}

function clampJointDeg(key, deg) {
  if (!J[key]) return deg;
  return clamp(deg, jointMin(key), jointMax(key));
}

function getJointHome(key) {
  if (!J[key]) return 0;
  return clampJointDeg(key, typeof J[key].home === 'number' ? J[key].home : 0);
}

function setJointHome(key, deg) {
  if (!J[key]) return 0;
  J[key].home = snapTargetDeg(key, deg);
  return getJointHome(key);
}

function getHomePoseMap() {
  const map = {};
  JDEFS.forEach(d => { map[d.key] = getJointHome(d.key); });
  return map;
}

function captureCurrentPoseAsHome() {
  const map = {};
  JDEFS.forEach(d => {
    map[d.key] = setJointHome(d.key, J[d.key].angPos);
  });
  return map;
}

function moveToHomePose() {
  JDEFS.forEach(d => setJointTarget(d.key, getJointHome(d.key)));
}

function snapDeltaDeg(deg, stepDeg = ANGLE_STEP_DEG) {
  if (!isFinite(deg) || !deg) return 0;
  const step = Math.max(0.001, Math.abs(stepDeg));
  const snapped = Math.round(deg / step) * step;
  return snapped || Math.sign(deg) * step;
}

function snapTargetDeg(key, deg, stepDeg = ANGLE_STEP_DEG) {
  if (!J[key]) return deg;
  const clamped = clampJointDeg(key, deg);
  if (Math.abs(clamped) < 1e-9 || clamped === jointMin(key) || clamped === jointMax(key))
    return clamped;
  const step = Math.max(0.001, Math.abs(stepDeg));
  return clampJointDeg(key, Math.round(clamped / step) * step);
}

function _commitAll() {
  let anyChanged = false;
  JDEFS.forEach(d => {
    const j    = J[d.key];
    const tgt  = clampJointDeg(d.key, j.target);
    const diff = tgt - j.committed;

    if (Math.abs(diff) < _POS_TOL) {
      if (j.v !== 0) { j.v = 0; anyChanged = true; }
      return;
    }

    const dps = Math.max(1, j.dps);
    const maxP = Math.min(j.maxSecs, PULSE_CAP_S);
    const sec = clamp(diff / dps, -maxP, maxP);
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
    _manualPlanned[d.key] = home;
  });
}

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

function cancelQueuedMoves(key, opts = {}) {
  if (!J[key]) return;
  const holdPosition = opts.holdPosition !== false;
  _manualQueue[key].length = 0;
  _manualBusy[key] = false;
  _manualToken[key]++;
  _manualPlanned[key] = clampJointDeg(key, holdPosition ? J[key].angPos : J[key].target);
  if (holdPosition) _setJointTargetRaw(key, J[key].angPos);
}

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
      const stopped = Math.abs(J[key].v) < 0.0005;
      if (atGoal && stopped) break;
      if (performance.now() > deadline) break;
      await _sleep(30);
    }

    if (_manualToken[key] !== token) break;
    await _sleep(MANUAL_SETTLE_MS);
  }
}

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
