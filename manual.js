/* ════════════════════════════════════════════════
   manual.js — Control manual · Servos de POSICIÓN (MG995 180°)
   ────────────────────────────────────────────────────────────────
   Cada slider envía directamente la posición angular al servo.
   Teclado: cada pulsación mueve MANUAL_STEP_DEG (1°).
   ════════════════════════════════════════════════ */

/* ── Sliders en grados objetivo (±angLim) ─────────────────────── */
JDEFS.forEach(d => {
  ['sl-', 'ard-sl-'].forEach(prefix => {
    const sl = document.getElementById(prefix + d.key);
    if (!sl) return;
    sl.step  = ANGLE_STEP_DEG;
    sl.value = 0;
  });

  const sl = document.getElementById('sl-' + d.key);
  if (!sl) return;
  sl.addEventListener('input', () => setJointTarget(d.key, parseFloat(sl.value)));
  sl.addEventListener('change', () => setJointTarget(d.key, parseFloat(sl.value)));
});

/* Recalcula los topes visibles del panel manual usando la calibración
   efectiva del momento, incluyendo restricciones activas de visión. */
function refreshManualRangeUi() {
  JDEFS.forEach(d => {
    const min = jointMin(d.key);
    const max = jointMax(d.key);
    const total = Math.max(0, max - min);

    ['sl-', 'ard-sl-'].forEach(prefix => {
      const sl = document.getElementById(prefix + d.key);
      if (!sl) return;
      sl.min = min;
      sl.max = max;
      sl.step = ANGLE_STEP_DEG;
      const current = parseFloat(sl.value);
      sl.value = String(clamp(isFinite(current) ? current : 0, min, max));
    });

    const lmMin = document.getElementById('lm-' + d.key + '-min');
    const lmMax = document.getElementById('lm-' + d.key + '-max');
    if (lmMin) lmMin.textContent = `${min}°`;
    if (lmMax) lmMax.textContent = `${max}°`;

    const totalLbl = document.getElementById('deg-range-total-' + d.key);
    const sideLbl  = document.getElementById('deg-range-side-' + d.key);
    const inp      = document.getElementById('deg-inp-' + d.key);

    if (totalLbl) totalLbl.textContent = `Rango total ${total}°`;
    if (sideLbl) {
      sideLbl.textContent =
        `Rango disponible: ${min}° a ${max}°. Cada toque mueve exactamente ${MANUAL_STEP_DEG}°.`;
    }
    if (inp) {
      const safeMax = Math.max(MANUAL_STEP_DEG, total);
      inp.min = String(MANUAL_STEP_DEG);
      inp.max = String(safeMax);
      inp.step = String(MANUAL_STEP_DEG);
      inp.title = `Máximo actual: ${safeMax}°`;
      const raw = parseFloat(inp.value);
      inp.value = String(clamp(isFinite(raw) ? raw : MANUAL_STEP_DEG, MANUAL_STEP_DEG, safeMax));
    }
  });
}

refreshManualRangeUi();

function handOffVisionForManual() {
  if (!window.__camOn) return;
  if (typeof window.stopCam === 'function') window.stopCam();
  else window.__camOn = false;
}


/* ── UI "Mover en grados" ─────────────────────────────────────── */
(function buildDegCtrls() {
  const wrap = document.getElementById('deg-ctrls');
  if (!wrap) return;
  wrap.innerHTML = JDEFS.map(d => {
    const min = jointMin(d.key);
    const max = jointMax(d.key);
    const total = Math.max(0, max - min);
    return `
    <div class="jb" style="padding:8px 10px;margin-bottom:6px">
      <div class="jr" style="margin-bottom:6px">
        <span class="jn">${d.lbl}</span>
        <span class="jk" id="deg-range-total-${d.key}">Rango total ${total}°</span>
        <span class="jv" id="ang-${d.key}">0°</span>
      </div>
      <div id="deg-range-side-${d.key}" style="font-size:8px;color:var(--ink3);margin-bottom:6px">
        Rango disponible: ${min}° a ${max}°. Cada toque mueve exactamente ${MANUAL_STEP_DEG}°.
      </div>
      <div class="br" style="gap:4px;flex-wrap:wrap">
        <button class="btn" data-dkey="${d.key}" data-deg="-${MANUAL_STEP_DEG}">◀ ${MANUAL_STEP_DEG}°</button>
        <button class="btn" data-dkey="${d.key}" data-deg="+${MANUAL_STEP_DEG}">${MANUAL_STEP_DEG}° ▶</button>
      </div>
    </div>`;
  }).join('');

  refreshManualRangeUi();

  wrap.addEventListener('click', e => {
    const b = e.target.closest('button[data-dkey]');
    if (!b) return;
    const k = b.dataset.dkey;
    const deg = parseFloat(b.dataset.deg);
    if (!isFinite(deg) || !deg) return;
    handOffVisionForManual();
    const delta = snapDeltaDeg(deg, MANUAL_STEP_DEG);
    if (!moveDegrees(k, delta)) return;
    log(`${k}: ${delta > 0 ? '+' : ''}${delta}° → ${J[k].target.toFixed(1)}°`, 'ok');
  });

  // Refresca el ángulo mostrado periódicamente (sin interacción)
  setInterval(() => {
    JDEFS.forEach(d => {
      const a = document.getElementById('ang-' + d.key);
      if (a) a.textContent = J[d.key].angPos.toFixed(1) + '°';
    });
  }, 200);
})();


/* ── Botones ─────────────────────────────────────────────────── */
/* "Parar todo" del panel manual delega en el PARO de emergencia
   global, así nunca hay dos rutas distintas para detener el equipo. */
document.getElementById('btn-reset').addEventListener('click', () => {
  if (typeof window.emergencyStop === 'function') window.emergencyStop();
  else JDEFS.forEach(d => setJointTarget(d.key, J[d.key].angPos));
});

/* HOME del panel manual usa el HOME global (que reanuda el firmware
   si estaba en PARO y respeta la posición base calibrada). */
document.getElementById('btn-home').addEventListener('click', () => {
  if (typeof window.globalHome === 'function') window.globalHome();
  else { resetAngPos(); if (typeof sendRaw === 'function' && typeof writer !== 'undefined' && writer) sendRaw('HOME'); }
});


/* ── Teclado — pasos discretos por pulsación ─────────────────── */
const KM = {
  'KeyQ': ['base', -1],
  'KeyA': ['base', +1],
  'KeyW': ['sho',  +1],
  'KeyS': ['sho',  -1],
  'KeyE': ['elb',  +1],
  'KeyD': ['elb',  -1],
  'KeyR': ['wri',  +1],
  'KeyF': ['wri',  -1],
  'KeyT': ['grip', +1],
  'KeyG': ['grip', -1],
};

const pressedKeys = new Set();
const holdStartMs = new Map();
const continuousKeys = new Set();
let keyHoldRaf = null;
let keyHoldLastTs = 0;
const KEY_HOLD_DELAY_MS = 220;
const KEY_HOLD_LEAD_DEG = 2;

function refreshKeyHighlight() {
  const last = Array.from(pressedKeys.keys()).pop();
  hlJ(last ? KM[last][0] : null);
}

function stopJointAtCurrent(key) {
  if (!J[key]) return;
  setJointTarget(key, J[key].angPos);
}

function keyHoldLoop(ts) {
  keyHoldRaf = null;
  if (!pressedKeys.size) {
    keyHoldLastTs = 0;
    return;
  }

  const now = performance.now();
  const jointDir = {};
  pressedKeys.forEach(code => {
    const item = KM[code];
    if (!item) return;
    const started = holdStartMs.get(code) || now;
    if (now - started < KEY_HOLD_DELAY_MS) return;
    continuousKeys.add(code);
    const [joint, sign] = item;
    jointDir[joint] = (jointDir[joint] || 0) + sign;
  });

  Object.keys(jointDir).forEach(joint => {
    const dir = Math.sign(jointDir[joint]);
    if (!dir) return;
    setJointTarget(joint, J[joint].angPos + dir * KEY_HOLD_LEAD_DEG);
  });

  keyHoldLastTs = ts;
  keyHoldRaf = requestAnimationFrame(keyHoldLoop);
}

function ensureKeyHoldLoop() {
  if (!keyHoldRaf) keyHoldRaf = requestAnimationFrame(keyHoldLoop);
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.repeat && KM[e.code]) {
    e.preventDefault();
    return;
  }

  if (e.code === 'Digit0') {
    pressedKeys.clear();
    if (typeof window.emergencyStop === 'function') window.emergencyStop();
    else JDEFS.forEach(d => setJointTarget(d.key, J[d.key].angPos));
    hlJ(null);
    return;
  }
  if (e.code === 'KeyH') {
    const kg = document.getElementById('kguide');
    if (kg) kg.style.display = kg.style.display === 'block' ? 'none' : 'block';
    return;
  }

  if (KM[e.code]) {
    // Mientras el sistema esté en PARO, ignoramos el teclado de movimiento.
    if (window.__emergencyStop) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const [joint, sign] = KM[e.code];
    const wasPressed = pressedKeys.has(e.code);
    handOffVisionForManual();
    pressedKeys.add(e.code);
    if (!wasPressed) {
      holdStartMs.set(e.code, performance.now());
      moveDegrees(joint, sign * MANUAL_STEP_DEG);
    }
    ensureKeyHoldLoop();
    hlJ(joint);
  }
});

document.addEventListener('keyup', e => {
  if (!KM[e.code]) return;
  const [joint] = KM[e.code];
  const wasContinuous = continuousKeys.has(e.code);
  pressedKeys.delete(e.code);
  holdStartMs.delete(e.code);
  continuousKeys.delete(e.code);
  if (wasContinuous) stopJointAtCurrent(joint);
  refreshKeyHighlight();
});
