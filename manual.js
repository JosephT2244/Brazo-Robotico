/* ════════════════════════════════════════════════
   manual.js — Control manual · Servos de POSICIÓN (MG995 180°)
   ────────────────────────────────────────────────────────────────
   Cada slider envía directamente la posición angular al servo.
   Teclado: cada pulsación mueve MANUAL_STEP_DEG (10°).
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
        `Rango disponible: ${min}° a ${max}°. Cada paso del control manual mueve ${MANUAL_STEP_DEG}° para mantener precisión.`;
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
        Rango disponible: ${min}° a ${max}°. Cada paso del control manual mueve ${MANUAL_STEP_DEG}° para mantener precisión.
      </div>
      <div class="br" style="gap:4px;flex-wrap:wrap">
        <button class="btn" data-dkey="${d.key}" data-deg="-${MANUAL_STEP_DEG * 2}">◀◀ ${MANUAL_STEP_DEG * 2}°</button>
        <button class="btn" data-dkey="${d.key}" data-deg="-${MANUAL_STEP_DEG}">◀ ${MANUAL_STEP_DEG}°</button>
        <button class="btn" data-dkey="${d.key}" data-deg-input="deg-inp-${d.key}" data-deg-sign="-1">◀</button>
        <input type="number" class="inp-n" id="deg-inp-${d.key}" value="${MANUAL_STEP_DEG}" step="${MANUAL_STEP_DEG}" min="${MANUAL_STEP_DEG}" max="${Math.max(MANUAL_STEP_DEG, total)}" title="Máximo actual: ${Math.max(MANUAL_STEP_DEG, total)}°" style="width:64px;flex:0 0 auto">
        <button class="btn p" data-dkey="${d.key}" data-deg-input="deg-inp-${d.key}" data-deg-sign="1">▶</button>
        <button class="btn" data-dkey="${d.key}" data-deg="+${MANUAL_STEP_DEG}">${MANUAL_STEP_DEG}° ▶</button>
        <button class="btn" data-dkey="${d.key}" data-deg="+${MANUAL_STEP_DEG * 2}">${MANUAL_STEP_DEG * 2}° ▶▶</button>
      </div>
    </div>`;
  }).join('');

  refreshManualRangeUi();

  wrap.addEventListener('click', e => {
    const b = e.target.closest('button[data-dkey]');
    if (!b) return;
    const k = b.dataset.dkey;
    let deg;
    if (b.dataset.deg !== undefined) {
      deg = parseFloat(b.dataset.deg);
    } else {
      const inp = document.getElementById(b.dataset.degInput);
      if (!inp) return;
      const sign = parseFloat(b.dataset.degSign || '1') || 1;
      const min = parseFloat(inp.min);
      const max = parseFloat(inp.max);
      const raw = parseFloat(inp.value);
      const safe = clamp(
        isFinite(raw) ? raw : MANUAL_STEP_DEG,
        isFinite(min) ? min : MANUAL_STEP_DEG,
        isFinite(max) ? max : MANUAL_STEP_DEG
      );
      inp.value = String(safe);
      deg = safe * Math.sign(sign || 1);
    }
    if (!isFinite(deg) || !deg) return;
    deg = snapDeltaDeg(deg, ANGLE_STEP_DEG);
    moveDegrees(k, deg);
    log(`${k}: ${deg > 0 ? '+' : ''}${deg}° → ${J[k].target.toFixed(1)}°`, 'ok');
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

function refreshKeyHighlight() {
  const last = Array.from(pressedKeys.keys()).pop();
  hlJ(last ? KM[last][0] : null);
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
    pressedKeys.add(e.code);
    moveDegrees(joint, sign * MANUAL_STEP_DEG);
    hlJ(joint);
  }
});

document.addEventListener('keyup', e => {
  if (!KM[e.code]) return;
  pressedKeys.delete(e.code);
  refreshKeyHighlight();
});
