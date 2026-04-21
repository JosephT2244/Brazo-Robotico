/* ════════════════════════════════════════════════
   manual.js — Control manual · Servos de velocidad
   ────────────────────────────────────────────────────────────────
   Control manual en grados.
   Teclado: cada click mueve 10° y se procesa en cola, con pausa
   corta entre pasos para que el servo alcance a detenerse.
   ════════════════════════════════════════════════ */

/* ── Sliders: ahora son grados objetivo (±angLim). El controlador
       interno en shared.js convierte grados→segundos para el firmware. ── */
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
        `Límite actual: ${min}° a ${max}°. Si mandas ${total}°, el sistema lo parte en pasos de ${MANUAL_STEP_DEG}° y se detiene entre cada paso.`;
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


/* ── UI "Mover en grados" (pasos discretos usando °/s calibrado) ────── */
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
        <span class="jk" id="dps-lbl-${d.key}">${d.dps}°/s</span>
        <span class="jv" id="ang-${d.key}">0°</span>
      </div>
      <div id="deg-range-side-${d.key}" style="font-size:8px;color:var(--ink3);margin-bottom:6px">
        Límite actual: ${min}° a ${max}°. Si mandas ${total}°, el sistema lo parte en pasos de ${MANUAL_STEP_DEG}° y se detiene entre cada paso.
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
    deg = snapDeltaDeg(deg, MANUAL_STEP_DEG);
    if (!queueManualMove(k, deg)) {
      log(`${k}: límite alcanzado`, 'info');
      return;
    }
    log(`${k}: ${deg > 0 ? '+' : ''}${deg}° programados en pasos de ${MANUAL_STEP_DEG}°`, 'ok');
  });

  // Refrescar ángulo estimado y °/s calibrado
  setInterval(() => {
    JDEFS.forEach(d => {
      const a = document.getElementById('ang-' + d.key);
      const s = document.getElementById('dps-lbl-' + d.key);
      if (a) a.textContent = J[d.key].angPos.toFixed(1) + '°';
      if (s) s.textContent = J[d.key].dps.toFixed(0) + '°/s';
    });
  }, 150);
})();

/* ── Botones ─────────────────────────────────────────────────── */
document.getElementById('btn-reset').addEventListener('click', () => {
  cancelAllQueuedMoves();
  JDEFS.forEach(d => {
    clearTimeout(J[d.key]._degTimer);
    // Parar: objetivo = posición actual
    setJointTarget(d.key, J[d.key].angPos);
  });
  log('Todos los servos parados', 'info');
});

document.getElementById('btn-home').addEventListener('click', () => {
  cancelAllQueuedMoves({ holdPosition: false });
  JDEFS.forEach(d => clearTimeout(J[d.key]._degTimer));
  resetAngPos();
  if (typeof sendRaw === 'function' && typeof writer !== 'undefined' && writer) sendRaw('HOME');
  log('HOME — referencia angular reseteada al HOME guardado', 'ok');
});


/* ── Teclado — pasos discretos de 10° por pulsación ── */
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
    cancelAllQueuedMoves();
    JDEFS.forEach(d => setJointTarget(d.key, J[d.key].angPos));
    hlJ(null);
    return;
  }
  if (e.code === 'KeyH') {
    const kg = document.getElementById('kguide');
    if (kg) kg.style.display = kg.style.display === 'block' ? 'none' : 'block';
    return;
  }

  if (KM[e.code]) {
    e.preventDefault();
    const [joint, sign] = KM[e.code];
    pressedKeys.add(e.code);
    if (!queueManualMove(joint, sign * MANUAL_STEP_DEG)) {
      log(`${joint}: límite alcanzado`, 'info');
    }
    hlJ(joint);
  }
});

document.addEventListener('keyup', e => {
  if (!KM[e.code]) return;
  pressedKeys.delete(e.code);
  refreshKeyHighlight();
});
