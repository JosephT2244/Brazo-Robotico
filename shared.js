/* ════════════════════════════════════════════════
   shared.js — Estado global, utilidades y marco de UI
   ────────────────────────────────────────────────────────────────
   Modelo POSICIÓN: los servos son MG995 Hi-SPEED de 180° (servos de
   ángulo, no de velocidad). Cada articulación tiene un ángulo objetivo
   en GRADOS dentro de ±angLim. La página envía la posición directa al
   firmware; el firmware aplica la conversión ángulo→PWM usando un
   neutro calibrado por servo.

   Rangos de operación (ángulos TOTALES solicitados):
   • Base   180°  → ±90°
   • Hombro  90°  → ±45°
   • Codo    45°  → ±22.5°
   • Muñeca 180°  → ±90°
   • Pinza   60°  → ±30°

   Dependencias: ninguna (es la base de todo)
   ════════════════════════════════════════════════ */


/* ──────────────────────────────────────────────────────────────
   DEFINICIÓN DE ARTICULACIONES
   ────────────────────────────────────────────────────────────── */
const ANGLE_STEP_DEG  = 1;
const MANUAL_STEP_DEG = 10;

// Rango FÍSICO TOTAL de cada articulación (servos MG995 de 180°).
// El movimiento operativo es simétrico ± la mitad de este total.
const PHYSICAL_TOTAL = {
  base: 180,
  sho:   90,
  elb:   45,
  wri:  180,
  grip:  60,
};

// Mitad del rango total — usado como ± límite operativo.
const PHYSICAL_LIMITS = {
  base: PHYSICAL_TOTAL.base / 2,   // 90
  sho:  PHYSICAL_TOTAL.sho  / 2,   // 45
  elb:  PHYSICAL_TOTAL.elb  / 2,   // 22.5
  wri:  PHYSICAL_TOTAL.wri  / 2,   // 90
  grip: PHYSICAL_TOTAL.grip / 2,   // 30
};

// Topes extra cuando la cámara está activa (± grados respecto al 0 lógico).
const VISION_ACTIVE_LIMITS = {
  sho: 45,
};

const JDEFS = [
  { key:'base', min:-PHYSICAL_LIMITS.base, max: PHYSICAL_LIMITS.base, def:0, lbl:'BASE',   angLim: PHYSICAL_LIMITS.base, total: PHYSICAL_TOTAL.base },
  { key:'sho',  min:-PHYSICAL_LIMITS.sho,  max: PHYSICAL_LIMITS.sho,  def:0, lbl:'HOMBRO', angLim: PHYSICAL_LIMITS.sho,  total: PHYSICAL_TOTAL.sho  },
  { key:'elb',  min:-PHYSICAL_LIMITS.elb,  max: PHYSICAL_LIMITS.elb,  def:0, lbl:'CODO',   angLim: PHYSICAL_LIMITS.elb,  total: PHYSICAL_TOTAL.elb  },
  { key:'wri',  min:-PHYSICAL_LIMITS.wri,  max: PHYSICAL_LIMITS.wri,  def:0, lbl:'MUÑECA', angLim: PHYSICAL_LIMITS.wri,  total: PHYSICAL_TOTAL.wri  },
  { key:'grip', min:-PHYSICAL_LIMITS.grip, max: PHYSICAL_LIMITS.grip, def:0, lbl:'PINZA',  angLim: PHYSICAL_LIMITS.grip, total: PHYSICAL_TOTAL.grip },
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
    angLim:   d.angLim, // ± límite físico (no se debe sobrepasar nunca)
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
  const baseMin = Math.max(-J[key].angLim, J[key].calMin);
  const visionCap = window.__camOn ? VISION_ACTIVE_LIMITS[key] : null;
  if (typeof visionCap !== 'number') return baseMin;
  return Math.max(baseMin, -Math.min(J[key].angLim, Math.abs(visionCap)));
}

function jointMax(key) {
  const baseMax = Math.min(J[key].angLim, J[key].calMax);
  const visionCap = window.__camOn ? VISION_ACTIVE_LIMITS[key] : null;
  if (typeof visionCap !== 'number') return baseMax;
  return Math.min(baseMax, Math.min(J[key].angLim, Math.abs(visionCap)));
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
   Con servos de POSICIÓN no necesitamos un ciclo de pulsos: el
   target se refleja inmediatamente en angPos y la UI se refresca.
   El envío real al firmware lo gestiona arduino.js (sendPos).
   ────────────────────────────────────────────────────────────── */
let _rafPending = false;

function _scheduleUI() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    if (typeof applyArm === 'function') applyArm();
    refreshUI();
  });
}

// Asigna directamente la posición y dispara refresco visual.
function _setJointTargetRaw(key, deg) {
  if (!J[key]) return;
  J[key].target = snapTargetDeg(key, deg);
  J[key].angPos = J[key].target;   // posición = objetivo (servo de ángulo)
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
  if (!J[key] || !Math.abs(degrees)) return;
  setJointTarget(key, J[key].target + snapDeltaDeg(degrees));
}

/** Movimiento manual por pasos — encolado simplificado.
 *  Con servos de posición no hace falta cola: simplemente
 *  ajustamos el target. Se mantiene la firma para compatibilidad. */
function queueManualMove(key, degrees) {
  if (!J[key] || !Math.abs(degrees)) return false;
  const delta = snapDeltaDeg(degrees, MANUAL_STEP_DEG);
  const next  = snapTargetDeg(key, J[key].target + delta, MANUAL_STEP_DEG);
  if (Math.abs(next - J[key].target) < 1e-6) return false;
  setJointTarget(key, next);
  return true;
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
  // Codo permite 22.5° → mostramos 1 decimal sólo cuando es necesario.
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
