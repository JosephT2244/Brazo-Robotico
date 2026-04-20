/* ════════════════════════════════════════════════
   manual.js — Control manual · Servos de velocidad
   ────────────────────────────────────────────────────────────────
   Valor del slider/tecla = segundos a girar (+ adelante, - atrás).
   Teclado: mantener presionado → girar; soltar → parar.
   ════════════════════════════════════════════════ */

/* ── Sliders: ahora son grados objetivo (±angLim). El controlador
       interno en shared.js convierte grados→segundos para el firmware. ── */
JDEFS.forEach(d => {
  ['sl-', 'ard-sl-'].forEach(prefix => {
    const sl = document.getElementById(prefix + d.key);
    if (!sl) return;
    sl.min   = -d.angLim;
    sl.max   =  d.angLim;
    sl.step  = 1;
    sl.value = 0;
  });
  const lmMin = document.getElementById('lm-' + d.key + '-min');
  const lmMax = document.getElementById('lm-' + d.key + '-max');
  if (lmMin) lmMin.textContent = `−${d.angLim}°`;
  if (lmMax) lmMax.textContent = `+${d.angLim}°`;

  const sl = document.getElementById('sl-' + d.key);
  if (!sl) return;
  sl.addEventListener('input', () => setJointTarget(d.key, parseFloat(sl.value)));
  sl.addEventListener('change', () => setJointTarget(d.key, parseFloat(sl.value)));
});


/* ── UI "Mover en grados" (preciso: usa °/s calibrado) ────── */
(function buildDegCtrls() {
  const wrap = document.getElementById('deg-ctrls');
  if (!wrap) return;
  wrap.innerHTML = JDEFS.map(d => `
    <div class="jb" style="padding:8px 10px;margin-bottom:6px">
      <div class="jr" style="margin-bottom:6px">
        <span class="jn">${d.lbl}</span>
        <span class="jk" id="dps-lbl-${d.key}">${d.dps}°/s</span>
        <span class="jv" id="ang-${d.key}">0°</span>
      </div>
      <div class="br" style="gap:4px;flex-wrap:wrap">
        <button class="btn" data-dkey="${d.key}" data-deg="-45">◀◀ 45°</button>
        <button class="btn" data-dkey="${d.key}" data-deg="-10">◀ 10°</button>
        <input type="number" class="inp-n" id="deg-inp-${d.key}" value="15" step="1" min="1" max="180" style="width:54px;flex:0 0 auto">
        <button class="btn p" data-dkey="${d.key}" data-deg-input="deg-inp-${d.key}">▶</button>
        <button class="btn" data-dkey="${d.key}" data-deg="+10">10° ▶</button>
        <button class="btn" data-dkey="${d.key}" data-deg="+45">45° ▶▶</button>
      </div>
    </div>`).join('');

  wrap.addEventListener('click', e => {
    const b = e.target.closest('button[data-dkey]');
    if (!b) return;
    const k = b.dataset.dkey;
    let deg;
    if (b.dataset.deg !== undefined) {
      deg = parseFloat(b.dataset.deg);
    } else {
      const inp = document.getElementById(b.dataset.degInput);
      deg = parseFloat(inp.value);
    }
    if (!isFinite(deg) || !deg) return;
    moveDegrees(k, deg);
    log(`${k}: ${deg > 0 ? '+' : ''}${deg}° (~${(Math.abs(deg)/J[k].dps).toFixed(2)}s)`, 'ok');
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
  JDEFS.forEach(d => {
    clearTimeout(J[d.key]._degTimer);
    // Parar: objetivo = posición actual
    setJointTarget(d.key, J[d.key].angPos);
  });
  log('Todos los servos parados', 'info');
});

document.getElementById('btn-home').addEventListener('click', () => {
  JDEFS.forEach(d => clearTimeout(J[d.key]._degTimer));
  resetAngPos();
  if (typeof sendRaw === 'function' && typeof writer !== 'undefined' && writer) sendRaw('HOME');
  log('HOME — posición angular reseteada a 0°', 'ok');
});


/* ── Teclado — mantener = girar hacia el extremo, soltar = parar ── */
// signo: -1 = hacia -angLim, +1 = hacia +angLim
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

const held = new Set();

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.code === 'Digit0') {
    JDEFS.forEach(d => setJointTarget(d.key, J[d.key].angPos));
    return;
  }
  if (e.code === 'KeyH') {
    const kg = document.getElementById('kguide');
    if (kg) kg.style.display = kg.style.display === 'block' ? 'none' : 'block';
    return;
  }

  if (KM[e.code] && !held.has(e.code)) {
    e.preventDefault();
    held.add(e.code);
    const [joint, sign] = KM[e.code];
    setJointTarget(joint, sign * J[joint].angLim);
    hlJ(joint);
  }
});

document.addEventListener('keyup', e => {
  if (!KM[e.code]) return;
  held.delete(e.code);
  const [joint] = KM[e.code];
  // Al soltar: parar = objetivo = posición actual
  setJointTarget(joint, J[joint].angPos);
  if (held.size === 0) hlJ(null);
});
