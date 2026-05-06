/* ════════════════════════════════════════════════
   shared.js — Estado global, utilidades y marco de UI
   ────────────────────────────────────────────────────────────────
   Modelo POSICIÓN: los servos son MG995 Hi-SPEED de 180° (servos de
   ángulo, no de velocidad). Cada articulación tiene un ángulo objetivo
   en GRADOS dentro de su rango permitido. La página envía la posición directa al
   firmware; el firmware aplica la conversión ángulo→PWM usando un
   neutro calibrado por servo.

   Rangos de operación (ángulos TOTALES solicitados):
   • Base   180°  → ±90°
   • Hombro  90°  → 0° a 90°
   • Codo    90°  → -90° a 0°
   • Muñeca 180°  → ±90°
   • Pinza   50°  → ±25°

   Dependencias: ninguna (es la base de todo)
   ════════════════════════════════════════════════ */


/* ──────────────────────────────────────────────────────────────
   DEFINICIÓN DE ARTICULACIONES
   ────────────────────────────────────────────────────────────── */
const ANGLE_STEP_DEG  = 0.25;
const MANUAL_STEP_DEG = 1;

// Límite de velocidad de los comandos enviados al firmware. No cambia la
// velocidad interna del MG995; reparte los cambios de posición en pasos cortos.
const SERVO_SPEED_KEY = 'roboarm-servo-command-speed-v6';
const SERVO_SPEED_PREVIOUS_KEYS = [
  { key: 'roboarm-servo-command-speed-v5', scale: 2 },
  { key: 'roboarm-servo-command-speed-v4', scale: 4 },
  { key: 'roboarm-servo-command-speed-v3', scale: 0.05 },
  { key: 'roboarm-servo-command-speed-v2', scale: 0.05 },
  { key: 'roboarm-servo-command-speed-v1', scale: 0.025 },
];
const SERVO_SPEED_STEP_DPS = 0.1;
const SERVO_SPEED_MIN_DPS = 0.1;
const SERVO_SPEED_MAX_DPS = 20;
const SERVO_SPEED_DEFAULT_DPS = 4;
const VISION_SERVO_SPEED_MULTIPLIER = 6;
const SERVO_JOINT_SPEED_SCALE = {
  base: 0.60,
  sho:  0.35,
  elb:  0.35,
  wri:  0.60,
  grip: 0.35,
};

function clampServoSpeed(v) {
  const clamped = Math.max(SERVO_SPEED_MIN_DPS, Math.min(SERVO_SPEED_MAX_DPS, v));
  return Math.round(clamped / SERVO_SPEED_STEP_DPS) * SERVO_SPEED_STEP_DPS;
}

let servoCommandDps = SERVO_SPEED_DEFAULT_DPS;
try {
  const savedServoSpeed = parseFloat(localStorage.getItem(SERVO_SPEED_KEY));
  if (isFinite(savedServoSpeed)) {
    servoCommandDps = clampServoSpeed(savedServoSpeed);
  } else {
    for (const prev of SERVO_SPEED_PREVIOUS_KEYS) {
      const previousServoSpeed = parseFloat(localStorage.getItem(prev.key));
      if (isFinite(previousServoSpeed)) {
        servoCommandDps = clampServoSpeed(previousServoSpeed * prev.scale);
        break;
      }
    }
  }
} catch(e) { /* default */ }

function setServoCommandSpeed(degPerSec) {
  const v = clampServoSpeed(isFinite(degPerSec) ? degPerSec : SERVO_SPEED_DEFAULT_DPS);
  servoCommandDps = v;
  try { localStorage.setItem(SERVO_SPEED_KEY, String(v)); } catch(e) {}
  return servoCommandDps;
}

function getServoCommandSpeed() {
  return servoCommandDps;
}

// Rango FÍSICO TOTAL de cada articulación (servos MG995 de 180°).
// El movimiento operativo es simétrico ± la mitad de este total.
const PHYSICAL_TOTAL = {
  base: 180,
  sho:   90,
  elb:   90,
  wri:  180,
  grip:  50,
};

// Alcance máximo por articulación. Hombro y codo son rangos desplazados:
// trabajan de 0° a 90° en vez de partir el recorrido a ambos lados del cero.
const PHYSICAL_LIMITS = {
  base: PHYSICAL_TOTAL.base / 2,   // 90
  sho:  PHYSICAL_TOTAL.sho,        // 90
  elb:  PHYSICAL_TOTAL.elb,        // 90
  wri:  PHYSICAL_TOTAL.wri  / 2,   // 90
  grip: PHYSICAL_TOTAL.grip / 2,   // 25
};

const PHYSICAL_MIN = {
  base: -PHYSICAL_LIMITS.base,
  sho:  0,
  elb:  -PHYSICAL_LIMITS.elb,
  wri:  -PHYSICAL_LIMITS.wri,
  grip: -PHYSICAL_LIMITS.grip,
};

const PHYSICAL_MAX = {
  base: PHYSICAL_LIMITS.base,
  sho:  PHYSICAL_LIMITS.sho,
  elb:  0,
  wri:  PHYSICAL_LIMITS.wri,
  grip: PHYSICAL_LIMITS.grip,
};

// Topes extra cuando la cámara está activa (± grados respecto al 0 lógico).
const VISION_ACTIVE_LIMITS = {
  sho: PHYSICAL_LIMITS.sho,
};

const JDEFS = [
  { key:'base', min:PHYSICAL_MIN.base, max:PHYSICAL_MAX.base, def:0, lbl:'BASE',   angLim: PHYSICAL_LIMITS.base, total: PHYSICAL_TOTAL.base },
  { key:'sho',  min:PHYSICAL_MIN.sho,  max:PHYSICAL_MAX.sho,  def:0, lbl:'HOMBRO', angLim: PHYSICAL_LIMITS.sho,  total: PHYSICAL_TOTAL.sho  },
  { key:'elb',  min:PHYSICAL_MIN.elb,  max:PHYSICAL_MAX.elb,  def:0, lbl:'CODO',   angLim: PHYSICAL_LIMITS.elb,  total: PHYSICAL_TOTAL.elb  },
  { key:'wri',  min:PHYSICAL_MIN.wri,  max:PHYSICAL_MAX.wri,  def:0, lbl:'MUÑECA', angLim: PHYSICAL_LIMITS.wri,  total: PHYSICAL_TOTAL.wri  },
  { key:'grip', min:PHYSICAL_MIN.grip, max:PHYSICAL_MAX.grip, def:0, lbl:'PINZA',  angLim: PHYSICAL_LIMITS.grip, total: PHYSICAL_TOTAL.grip },
];

/* ──────────────────────────────────────────────────────────────
   ESTADO GLOBAL DE ARTICULACIONES
   J es el objeto central compartido por todos los módulos.
   ────────────────────────────────────────────────────────────── */
const J = {};
JDEFS.forEach(d => {
  J[d.key] = {
    target:   0,        // Ángulo objetivo en GRADOS (lo que la UI/visión piden)
    angPos:   0,        // Ángulo "real" estimado en GRADOS — con servos de posición = target tras commit
    home:     d.def,    // HOME persistible (referencia de inicio)
    calMin:   d.min,    // Límite inferior calibrado (restricción del usuario)
    calMax:   d.max,    // Límite superior calibrado (restricción del usuario)
    minLim:   d.min,    // Límite físico inferior real
    maxLim:   d.max,    // Límite físico superior real
    angLim:   d.angLim, // Alcance máximo usado por visualización y límites de visión
    zero:     0,        // OFFSET de cero (grados) — para alinear el "0 mecánico" del servo
                        //   con el "0 lógico" de la página tras montar el brazo.
  };
});


/* ──────────────────────────────────────────────────────────────
   UTILIDADES MATEMÁTICAS
   ────────────────────────────────────────────────────────────── */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toRad = d => d * Math.PI / 180;
const lerp  = (a, b, t) => a + (b - a) * t;


/* ──────────────────────────────────────────────────────────────
   LÍMITES Y SNAPPING
   ────────────────────────────────────────────────────────────── */
function jointMin(key) {
  const baseMin = Math.max(J[key].minLim, J[key].calMin);
  const visionCap = window.__camOn ? VISION_ACTIVE_LIMITS[key] : null;
  if (typeof visionCap !== 'number') return baseMin;
  return Math.max(baseMin, J[key].minLim);
}

function jointMax(key) {
  const baseMax = Math.min(J[key].maxLim, J[key].calMax);
  const visionCap = window.__camOn ? VISION_ACTIVE_LIMITS[key] : null;
  if (typeof visionCap !== 'number') return baseMax;
  return Math.min(baseMax, Math.min(J[key].maxLim, Math.abs(visionCap)));
}

function clampJointDeg(key, deg) {
  if (!J[key]) return deg;
  return clamp(deg, jointMin(key), jointMax(key));
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
  const step = Math.max(0.001, Math.abs(stepDeg));
  return clampJointDeg(key, Math.round(clamped / step) * step);
}


/* ──────────────────────────────────────────────────────────────
   POSICIÓN HOME (referencia de inicio segura)
   ────────────────────────────────────────────────────────────── */
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


/* ──────────────────────────────────────────────────────────────
   COMMIT / REFRESCO
   target = lo que pide la UI/visión.
   angPos = posición comandada al firmware, limitada por grados/segundo.
   El envío real al firmware lo gestiona arduino.js (sendPos).
   ────────────────────────────────────────────────────────────── */
let _rafPending = false;
let _lastMotionTs = 0;

function _stepServoCommand(dtSec) {
  let moving = false;
  JDEFS.forEach(d => {
    const j = J[d.key];
    const target = clampJointDeg(d.key, j.target);
    const current = clampJointDeg(d.key, j.angPos);
    const delta = target - current;

    if (Math.abs(delta) <= 0.01) {
      j.target = target;
      j.angPos = target;
      return;
    }

    const scale = (SERVO_JOINT_SPEED_SCALE[d.key] ?? 1) *
      (window.__camOn ? VISION_SERVO_SPEED_MULTIPLIER : 1);
    const maxStep = Math.max(0.001, servoCommandDps * scale * dtSec);
    j.angPos = current + clamp(delta, -maxStep, maxStep);
    moving = true;
  });
  return moving;
}

function _scheduleUI() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(ts => {
    _rafPending = false;
    const dtSec = _lastMotionTs
      ? clamp((ts - _lastMotionTs) / 1000, 1 / 120, 0.08)
      : 1 / 60;
    _lastMotionTs = ts;
    const moving = _stepServoCommand(dtSec);
    if (typeof applyArm === 'function') applyArm();
    refreshUI();
    if (moving) _scheduleUI();
  });
}

// Asigna el objetivo y dispara el seguimiento suavizado.
function _setJointTargetRaw(key, deg) {
  if (!J[key]) return;
  J[key].target = snapTargetDeg(key, deg);
  _scheduleUI();
}

/** Resetea todas las articulaciones a su HOME persistido. */
function resetAngPos() {
  JDEFS.forEach(d => {
    const home = getJointHome(d.key);
    J[d.key].target = home;
    J[d.key].angPos = home;
  });
  _scheduleUI();
}

/** API principal: fija el ángulo objetivo de un servo. */
function setJointTarget(key, deg) {
  _setJointTargetRaw(key, deg);
}

/** Mover un delta angular desde la posición actual. */
function moveDegrees(key, degrees) {
  if (!J[key] || !isFinite(degrees) || !Math.abs(degrees)) return false;
  if (Math.abs(J[key].target - J[key].angPos) > 0.02) return false;
  const delta = snapDeltaDeg(degrees, MANUAL_STEP_DEG);
  const base = clampJointDeg(key, J[key].angPos);
  const next = snapTargetDeg(key, base + delta, ANGLE_STEP_DEG);
  if (Math.abs(next - J[key].target) < 1e-6 && Math.abs(next - J[key].angPos) < 0.05) return false;
  setJointTarget(key, next);
  return true;
}

/** Movimiento manual por pasos — encolado simplificado.
 *  Con servos de posición no hace falta cola: simplemente
 *  ajustamos el target. Se mantiene la firma para compatibilidad. */
function queueManualMove(key, degrees) {
  return moveDegrees(key, degrees);
}

function cancelQueuedMoves(/* key, opts */) { /* no-op con servos de posición */ }
function cancelAllQueuedMoves(/* opts */)   { /* no-op con servos de posición */ }


/* ──────────────────────────────────────────────────────────────
   ACTUALIZACIÓN EN LOTE (BATCH) — uso desde visión y presets
   ────────────────────────────────────────────────────────────── */
function batchTargets(map) {
  for (const key in map) {
    if (!J[key]) continue;
    if (key === 'base' && window.__camOn) continue;
    setJointTarget(key, map[key]);
  }
}

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
   REFRESH UI
   ────────────────────────────────────────────────────────────── */
const _uiCache = {};

function _fmtDeg(v) {
  // Algunos límites usan fracciones de grado; mostramos decimal sólo si hace falta.
  return Math.abs(v - Math.round(v)) < 0.05 ? `${Math.round(v)}°` : `${v.toFixed(1)}°`;
}

function refreshUI() {
  JDEFS.forEach(d => {
    const j = J[d.key];
    const lbl = _fmtDeg(j.angPos);

    const sl = document.getElementById('sl-' + d.key);
    if (sl && document.activeElement !== sl) sl.value = j.target;

    _setText('lv-' + d.key, lbl);
    _setText('h-'  + d.key, lbl);
  });

  _setText('ft-ang',
    `B:${_fmtDeg(J.base.angPos)}  H:${_fmtDeg(J.sho.angPos)}  ` +
    `C:${_fmtDeg(J.elb.angPos)}  W:${_fmtDeg(J.wri.angPos)}  G:${_fmtDeg(J.grip.angPos)}`
  );
}

setInterval(() => _scheduleUI(), 250);

function _setText(id, txt) {
  if (_uiCache[id] === txt) return;
  _uiCache[id] = txt;
  const e = document.getElementById(id);
  if (e) e.textContent = txt;
}


/* ──────────────────────────────────────────────────────────────
   LOG DE EVENTOS
   ────────────────────────────────────────────────────────────── */
const logEl = document.getElementById('logbox');

function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = 'll ' + type;
  div.textContent = new Date().toLocaleTimeString('es-MX', { hour12: false }) + ' ' + msg;
  logEl.appendChild(div);
  while (logEl.children.length > 14) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}


/* ──────────────────────────────────────────────────────────────
   MODAL DE AVISOS
   ────────────────────────────────────────────────────────────── */
function modal(title, body) {
  document.getElementById('modal-t').textContent = title;
  document.getElementById('modal-b').textContent = body;
  document.getElementById('modalbg').classList.add('show');
}


/* ──────────────────────────────────────────────────────────────
   HIGHLIGHT DE ARTICULACIÓN ACTIVA
   ────────────────────────────────────────────────────────────── */
function hlJ(k) {
  document.querySelectorAll('.jb').forEach(e => e.classList.remove('kb'));
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

function openSidebar()  { sidebar.classList.add('open');    backdrop.style.display = 'block'; }
function closeSidebar() { sidebar.classList.remove('open'); backdrop.style.display = 'none';  }

document.getElementById('btn-sidebar-toggle').addEventListener('click', () =>
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar()
);

backdrop.addEventListener('click', closeSidebar);

function switchTab(t) {
  document.querySelectorAll('.tab').forEach(x =>
    x.classList.toggle('active', x.dataset.t === t));
  document.querySelectorAll('.pane').forEach(x =>
    x.classList.toggle('active', x.id === 'pane-' + t));
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    switchTab(tab.dataset.t);
    if (window.matchMedia('(max-width:900px)').matches && !sidebar.classList.contains('open'))
      openSidebar();
  });
});

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.t;
    document.querySelectorAll('.nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.t === t));
    switchTab(t);
    const currentTab = document.querySelector('.tab.active');
    currentTab && currentTab.dataset.t === t && sidebar.classList.contains('open')
      ? closeSidebar()
      : openSidebar();
  });
});
