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
// Regla de 3 — velocidad real = 720 °/s
//   (antes calculaba 360°/s pero movía el doble → dps real es 720)
// maxSecs = angLim / dps  (tope físico por comando)
//   base   90° / 720 °/s = 0.125 s
//   hombro 90° / 720 °/s = 0.125 s
//   codo   80° / 720 °/s = 0.111 s
//   muñeca 100°/ 720 °/s = 0.139 s
//   pinza  20° / 720 °/s = 0.028 s
const JDEFS = [
  { key:'base', min:-10, max:10, def:0, lbl:'BASE',   dps: 720, angLim:  90, maxSecs: 0.125 },
  { key:'sho',  min:-10, max:10, def:0, lbl:'HOMBRO', dps: 720, angLim:  90, maxSecs: 0.125 },
  { key:'elb',  min:-10, max:10, def:0, lbl:'CODO',   dps: 720, angLim:  80, maxSecs: 0.111 },
  { key:'wri',  min:-10, max:10, def:0, lbl:'MUÑECA', dps: 720, angLim: 100, maxSecs: 0.139 },
  { key:'grip', min:-10, max:10, def:0, lbl:'PINZA',  dps: 720, angLim:  20, maxSecs: 0.028 },
];

/* ──────────────────────────────────────────────────────────────
   ESTADO GLOBAL DE ARTICULACIONES
   J es el objeto central compartido por todos los módulos.
   Cada entrada: { v: valor_actual, calMin: mínimo, calMax: máximo }
   ────────────────────────────────────────────────────────────── */
const J = {};
JDEFS.forEach(d => {
  J[d.key] = {
    v:       d.def,    // Comando actual en SEGUNDOS (velocidad continua)
    calMin:  d.min,    // Mínimo de calibración (protege al servo)
    calMax:  d.max,    // Máximo de calibración (protege al servo)
    dps:     d.dps,    // Grados/segundo reales del servo (calibrable)
    angPos:  0,        // Estimación de posición acumulada en GRADOS (desde HOME)
    angLim:  d.angLim, // Límite ± de grados permitidos desde HOME
    maxSecs: d.maxSecs,// Segundos máximos por comando (=angLim/dps, protege overshoot)
  };
});

/* ──────────────────────────────────────────────────────────────
   PERSISTENCIA DE VELOCIDADES (grados/segundo) calibradas
   ────────────────────────────────────────────────────────────── */
// v2: migración forzada a 90 °/s como valor medido del hardware real.
// Cualquier calibración previa en v1 se ignora para aplicar el nuevo default.
const DPS_KEY = 'roboarm-dps-v2';
try {
  localStorage.removeItem('roboarm-dps-v1');   // limpiar clave vieja
  const saved = JSON.parse(localStorage.getItem(DPS_KEY) || 'null');
  if (saved) JDEFS.forEach(d => {
    if (typeof saved[d.key] === 'number' && saved[d.key] > 0)
      J[d.key].dps = saved[d.key];
  });
} catch (e) { /* usar defaults */ }

function saveDps() {
  const data = {};
  JDEFS.forEach(d => { data[d.key] = J[d.key].dps; });
  try { localStorage.setItem(DPS_KEY, JSON.stringify(data)); } catch(e) {}
}

/* ──────────────────────────────────────────────────────────────
   SEGUIMIENTO DE POSICIÓN ANGULAR ESTIMADA
   Dado que son servos de velocidad sin feedback, estimamos la
   posición integrando la velocidad comandada × tiempo transcurrido.
   ────────────────────────────────────────────────────────────── */
let _angT = performance.now();
function _tickAngPos() {
  const now = performance.now();
  const dt  = Math.min((now - _angT) / 1000, 0.2);
  _angT = now;
  JDEFS.forEach(d => {
    if (J[d.key].v !== 0) {
      const signVel = Math.sign(J[d.key].v);        // dirección del giro
      const deg     = signVel * J[d.key].dps * dt;  // grados recorridos
      const next    = J[d.key].angPos + deg;
      // Tope al límite: si se llega al tope, parar el servo (seguridad)
      if (Math.abs(next) >= J[d.key].angLim) {
        J[d.key].angPos = clamp(next, -J[d.key].angLim, J[d.key].angLim);
        J[d.key].v = 0;  // parada por límite
      } else {
        J[d.key].angPos = next;
      }
    }
  });
  requestAnimationFrame(_tickAngPos);
}
requestAnimationFrame(_tickAngPos);

/* ──────────────────────────────────────────────────────────────
   MOVIMIENTO EN GRADOS — convierte "mover N grados" a pulsos
   de segundos basados en dps calibrado. Gestiona la cola
   automáticamente con el temporizador del firmware.
   ────────────────────────────────────────────────────────────── */
function moveDegrees(key, degrees) {
  if (!J[key] || !Math.abs(degrees)) return;
  const j   = J[key];
  const dps = Math.max(1, j.dps);
  // Clamp el ángulo destino contra angLim (no pasarse del tope mecánico)
  const target = clamp(j.angPos + degrees, -j.angLim, j.angLim);
  const realDeg = target - j.angPos;
  if (Math.abs(realDeg) < 0.5) return;       // ya estaba en el tope
  const secs = realDeg / dps;
  // Limitar a maxSecs del joint (nunca permitir un comando que se pase del angLim)
  const cmd = clamp(secs, -j.maxSecs, j.maxSecs);
  setJoint(key, cmd);
  const ms = Math.abs(secs) * 1000;
  clearTimeout(j._degTimer);
  j._degTimer = setTimeout(() => setJoint(key, 0), ms);
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
     batchJoints({ base: 30, sho: 90, elb: 45, wri: 0, grip: 20 });
   ────────────────────────────────────────────────────────────── */
let _rafPending = false;  // Bandera: ¿hay una actualización pendiente?

/** Clampa una orden de velocidad (segundos) contra TODOS los límites:
 *  - calMin/calMax (rango del slider)
 *  - ±maxSecs (tope por comando)
 *  - Proyección forward: nunca permitir una orden que termine pasándose del angLim
 *    Ej: si angPos=60° y angLim=90° → máx +30° → máx +30/dps segundos
 *         si angPos=60° → máx -150° → máx -150/dps segundos (a 0 y luego -90°)
 */
function _safeClamp(key, v) {
  const j = J[key];
  let c = clamp(v, j.calMin, j.calMax);
  c = clamp(c, -j.maxSecs, j.maxSecs);
  const dps = Math.max(1, j.dps);
  // Cuántos grados quedan hacia cada sentido antes de topar con angLim
  const remainPos = Math.max(0, j.angLim  - j.angPos);   // en grados (positivo)
  const remainNeg = Math.max(0, j.angPos  + j.angLim);   // en grados (positivo)
  // Convertir a segundos y aplicar según la dirección del comando
  const maxForward  =  remainPos / dps;
  const maxBackward = -remainNeg / dps;
  if (c > maxForward)  c = maxForward;
  if (c < maxBackward) c = maxBackward;
  return c;
}

function batchJoints(targets) {
  let changed = false;
  for (const key in targets) {
    if (!(key in J)) continue;
    const clamped = _safeClamp(key, targets[key]);
    if (Math.abs(clamped - J[key].v) > 0.001) {
      J[key].v = clamped;
      changed = true;
    }
  }
  // Programar actualización visual solo si algo cambió y no hay una en cola
  if (changed && !_rafPending) {
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      if (typeof applyArm === 'function') applyArm();  // Rotar grupos 3D
      refreshUI();                                       // Actualizar sliders y HUD
    });
  }
}

/* ──────────────────────────────────────────────────────────────
   SET JOINT — Actualización de articulación individual
   Mantiene compatibilidad con código que no usa batchJoints.
   También usa rAF para evitar múltiples actualizaciones por frame.
   ────────────────────────────────────────────────────────────── */
function setJoint(key, val) {
  const clamped = _safeClamp(key, val);
  if (Math.abs(clamped - J[key].v) > 0.001) {
    J[key].v = clamped;
    if (!_rafPending) {
      _rafPending = true;
      requestAnimationFrame(() => {
        _rafPending = false;
        if (typeof applyArm === 'function') applyArm();
        refreshUI();
      });
    }
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
    const v = J[d.key].v;
    const lbl = v === 0 ? '■' : (v > 0 ? '▶' : '◀') + Math.abs(v).toFixed(1) + 's';

    const sl = document.getElementById('sl-' + d.key);
    if (sl && document.activeElement !== sl) sl.value = v;

    _setText('lv-' + d.key, lbl);
    _setText('h-'  + d.key, lbl);
  });

  const fmt = k => {
    const v = J[k].v;
    return v === 0 ? '■' : (v > 0 ? '+' : '') + v.toFixed(1) + 's';
  };
  _setText('ft-ang',
    `B:${fmt('base')}  H:${fmt('sho')}  C:${fmt('elb')}  W:${fmt('wri')}  G:${fmt('grip')}`
  );
}

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
