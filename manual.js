/* ════════════════════════════════════════════════
   manual.js — Control manual · Servos de velocidad
   ────────────────────────────────────────────────────────────────
   Valor del slider/tecla = segundos a girar (+ adelante, - atrás).
   Teclado: mantener presionado → girar; soltar → parar.
   ════════════════════════════════════════════════ */

const KB_SECS = 5.0;   // Segundos que se ordenan al mantener una tecla

/* ── Sliders ────────────────────────────────────────────────── */
JDEFS.forEach(d => {
  ['sl-', 'ard-sl-'].forEach(prefix => {
    const sl = document.getElementById(prefix + d.key);
    if (!sl) return;
    sl.min   = d.min;
    sl.max   = d.max;
    sl.value = 0;
  });

  const sl = document.getElementById('sl-' + d.key);
  if (!sl) return;

  // Mostrar valor mientras se arrastra
  sl.addEventListener('input', () => setJoint(d.key, parseFloat(sl.value)));

  // Al soltar: enviar comando y resetear slider a 0 (indica enviado)
  sl.addEventListener('change', () => {
    setJoint(d.key, parseFloat(sl.value));
    setTimeout(() => { sl.value = 0; setJoint(d.key, 0); }, 120);
  });
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
  JDEFS.forEach(d => { clearTimeout(J[d.key]._degTimer); setJoint(d.key, 0); });
  log('Todos los servos parados', 'info');
});

document.getElementById('btn-home').addEventListener('click', () => {
  // HOME: poner ángulo estimado a 0 y parar
  JDEFS.forEach(d => { clearTimeout(J[d.key]._degTimer); J[d.key].angPos = 0; setJoint(d.key, 0); });
  log('HOME — posición angular reseteada a 0°', 'ok');
});


/* ── Teclado — mantener = girar, soltar = parar ─────────────── */
const KM = {
  'KeyQ': ['base', -KB_SECS],
  'KeyA': ['base', +KB_SECS],
  'KeyW': ['sho',  +KB_SECS],
  'KeyS': ['sho',  -KB_SECS],
  'KeyE': ['elb',  +KB_SECS],
  'KeyD': ['elb',  -KB_SECS],
  'KeyR': ['wri',  +KB_SECS],
  'KeyF': ['wri',  -KB_SECS],
  'KeyT': ['grip', +KB_SECS],
  'KeyG': ['grip', -KB_SECS],
};

const held = new Set();
let kbTimer = null;

function kbTick() {
  let lastKey = null;
  held.forEach(code => {
    if (!KM[code]) return;
    const [joint, secs] = KM[code];
    setJoint(joint, secs);   // renovar la orden cada tick
    lastKey = joint;
  });
  hlJ(lastKey);
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.code === 'Digit0') {
    JDEFS.forEach(d => setJoint(d.key, 0));
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
    kbTick();  // enviar inmediatamente al presionar
    if (!kbTimer) kbTimer = setInterval(kbTick, 4000); // renovar cada 4s (< 5s)
  }
});

document.addEventListener('keyup', e => {
  if (!KM[e.code]) return;
  held.delete(e.code);
  const [joint] = KM[e.code];
  setJoint(joint, 0);   // parar ese servo al soltar
  if (held.size === 0 && kbTimer) {
    clearInterval(kbTimer);
    kbTimer = null;
    hlJ(null);
  }
});
