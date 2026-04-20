/* ═══════════════════════════════════════════════
   calibration.js — Calibración de límites físicos de servos
   ────────────────────────────────────────────────────────────────
   Permite al usuario definir los ángulos mínimo y máximo de cada
   articulación para proteger los servos MG995 de sobrepasar sus
   límites mecánicos. Los valores se guardan en localStorage.

   Dependencias: shared.js (JDEFS, J, setJoint, log)
   ═══════════════════════════════════════════════ */


/* Clave de localStorage para persistir la calibración entre sesiones */
const CAL_KEY = 'roboarm-ipn-v10-calib';

/* Valores por defecto (iguales a JDEFS — rango completo de los servos) */
const CAL_DEFAULTS = {
  base: { min: -90, max: 0   },
  sho:  { min: 0,   max: 90  },
  elb:  { min: 0,   max: 80  },
  wri:  { min: -90, max: 100 },
  grip: { min: 0,   max: 20  },
};


/* ──────────────────────────────────────────────────────────────
   CONSTRUCCIÓN DE LA UI DE CALIBRACIÓN
   Genera dinámicamente los controles de min/max para cada
   articulación. Se llama al inicio y al restablecer.
   ────────────────────────────────────────────────────────────── */
function buildCalibUI() {
  document.getElementById('calib-wrap').innerHTML = JDEFS.map(d => `
    <div class="cb">
      <div class="cbn">${d.lbl}</div>
      <div class="cgr">
        <span class="clb">Mín s</span>
        <input type="number" class="inp-n" id="cm-${d.key}" value="${J[d.key].calMin}">
        <span class="cu">s</span>
      </div>
      <div class="cgr">
        <span class="clb">Máx s</span>
        <input type="number" class="inp-n" id="cx-${d.key}" value="${J[d.key].calMax}">
        <span class="cu">s</span>
      </div>
      <div class="cgr">
        <span class="clb">Vel</span>
        <input type="number" class="inp-n" id="dps-${d.key}" value="${J[d.key].dps}" min="1" max="360" step="1">
        <span class="cu">°/s</span>
      </div>
      <div class="cgr" style="grid-template-columns:auto 28px 1fr 28px auto">
        <span class="clb" title="Trim del PWM neutro — si el servo gira solo cuando debería estar parado, ajusta hasta que se detenga por completo">Neutro</span>
        <button class="btn" onclick="trimNeu('${d.key}', -1)" title="PWM neutro -1">◀</button>
        <input type="number" class="inp-n" id="neu-${d.key}" value="${neutrals[d.key]}" min="260" max="360" step="1" style="text-align:center">
        <button class="btn" onclick="trimNeu('${d.key}', +1)" title="PWM neutro +1">▶</button>
        <span class="cu">pwm</span>
      </div>
      <div class="cgr" style="grid-template-columns:1fr 1fr 1fr">
        <button class="btn" onclick="measureDps('${d.key}')" title="Gira 3 s y mide °/s">📐 °/s</button>
        <button class="btn gh" onclick="goDegrees('${d.key}', 15)" title="Mover +15° con velocidad calibrada">Test +15°</button>
        <button class="btn" onclick="autoTrimNeu('${d.key}')" title="Si el servo sigue moviéndose parado, ajusta el neutro hasta detenerlo">🎯 Auto-trim</button>
      </div>
    </div>`
  ).join('');
}

/* Trim manual: ajusta el neutro ±1 y lo envía en caliente al Arduino */
function trimNeu(key, delta) {
  const inp = document.getElementById('neu-' + key);
  if (!inp) return;
  let v = parseInt(inp.value) + delta;
  v = Math.max(260, Math.min(360, v));
  inp.value = v;
  neutrals[key] = v;
  saveNeutrals();
  sendNeutrals();   // aplica en caliente sin re-flashear
  log(`${key}: neutro = ${v}`, 'info');
}

/* Auto-trim interactivo: barre el neutro de 290 → 320 de uno en uno
   y pide al usuario pulsar ESPACIO cuando el servo deje de moverse. */
async function autoTrimNeu(key) {
  if (typeof writer === 'undefined' || !writer) {
    log('Conecta el Arduino primero para auto-trim', 'err'); return;
  }
  setJoint(key, 0);
  if (!confirm(
    `Auto-trim de ${key.toUpperCase()}\n\n` +
    `Voy a barrer el PWM neutro de 290 a 320 lentamente.\n` +
    `Mira el servo y pulsa OK para empezar.\n` +
    `Cuando veas que el servo deja de moverse, pulsa ESPACIO (o este botón de nuevo) para fijar el valor.`
  )) return;

  const lbl = document.getElementById('neu-' + key);
  let cancelled = false;
  const onKey = (e) => { if (e.code === 'Space') { e.preventDefault(); cancelled = true; } };
  document.addEventListener('keydown', onKey);

  log(`Auto-trim ${key}: barriendo 290 → 320… pulsa ESPACIO al detenerse`, 'info');
  for (let v = 290; v <= 320 && !cancelled; v++) {
    neutrals[key] = v;
    if (lbl) lbl.value = v;
    sendNeutrals();
    log(`${key}: probando ${v}`, 'info');
    await new Promise(r => setTimeout(r, 450));
  }
  document.removeEventListener('keydown', onKey);
  saveNeutrals();
  log(`${key}: neutro fijado en ${neutrals[key]}`, 'ok');
}

/* Auto-trim total: para TODOS los servos a la vez y deja al usuario ajustar
   uno por uno con los botones ◀ ▶. Barre bajando el PWM en cada uno. */
async function autoTrimAll() {
  if (typeof writer === 'undefined' || !writer) {
    log('Conecta el Arduino primero', 'err'); return;
  }
  for (const d of JDEFS) setJoint(d.key, 0);
  log('Todos los servos "parados" — ajusta cada ◀/▶ hasta que no giren', 'info');
  sendNeutrals();
}

/* ──────────────────────────────────────────────────────────────
   AUTO-MEDIR °/s — gira el servo 3 s a máxima velocidad
   y pide al usuario que escriba los grados realmente recorridos.
   ────────────────────────────────────────────────────────────── */
async function measureDps(key) {
  if (typeof writer === 'undefined' || !writer) {
    log('Conecta el Arduino primero para auto-medir', 'err'); return;
  }
  const TEST_SECS = 3.0;
  log(`Midiendo ${key}: gira ${TEST_SECS}s…`, 'info');
  setJoint(key, TEST_SECS);
  await new Promise(r => setTimeout(r, TEST_SECS * 1000 + 200));
  setJoint(key, 0);
  const ans = prompt(`¿Cuántos GRADOS se movió ${key.toUpperCase()} en ${TEST_SECS}s?`, '');
  const deg = parseFloat(ans);
  if (!isNaN(deg) && deg > 0) {
    J[key].dps = deg / TEST_SECS;
    document.getElementById('dps-' + key).value = J[key].dps.toFixed(1);
    saveDps();
    log(`${key} calibrado: ${J[key].dps.toFixed(1)} °/s`, 'ok');
  } else {
    log('Medición cancelada', 'info');
  }
}

/* Mover por grados usando la velocidad calibrada */
function goDegrees(key, deg) {
  moveDegrees(key, deg);
  log(`${key}: moviendo ${deg}° (~${(Math.abs(deg)/J[key].dps).toFixed(2)}s)`, 'ok');
}


/* ──────────────────────────────────────────────────────────────
   APLICAR CALIBRACIÓN
   Lee los valores de los inputs y los aplica a J, a los sliders
   manuales y a las etiquetas de límites del sidebar.
   Retorna true si todos los valores son válidos.
   ────────────────────────────────────────────────────────────── */
function applyCalib() {
  let allValid = true;

  JDEFS.forEach(d => {
    const mn = parseFloat(document.getElementById('cm-' + d.key).value);
    const mx = parseFloat(document.getElementById('cx-' + d.key).value);
    const dp = parseFloat(document.getElementById('dps-' + d.key)?.value ?? J[d.key].dps);
    const nu = parseInt(document.getElementById('neu-' + d.key)?.value ?? neutrals[d.key]);
    if (!isNaN(nu) && nu >= 260 && nu <= 360) neutrals[d.key] = nu;

    // Validación: números válidos y mínimo < máximo
    if (isNaN(mn) || isNaN(mx) || mn >= mx) {
      log(`Rango inválido en ${d.lbl}: mín debe ser < máx`, 'err');
      allValid = false;
      return;
    }

    // Actualizar límites en el estado global
    J[d.key].calMin = mn;
    J[d.key].calMax = mx;
    if (!isNaN(dp) && dp > 0) J[d.key].dps = dp;

    // Actualizar el slider manual para que refleje los nuevos límites
    const sl = document.getElementById('sl-' + d.key);
    if (sl) { sl.min = mn; sl.max = mx; }

    // Actualizar las etiquetas de límites visibles debajo del slider
    const lmin = document.getElementById('lm-' + d.key + '-min');
    const lmax = document.getElementById('lm-' + d.key + '-max');
    if (lmin) lmin.textContent = mn + '°';
    if (lmax) lmax.textContent = mx + '°';

    // Re-clampear el valor actual al nuevo rango (si estaba fuera de límites)
    setJoint(d.key, J[d.key].v);
  });

  return allValid;
}


/* ──────────────────────────────────────────────────────────────
   BOTÓN: GUARDAR CALIBRACIÓN
   Aplica y persiste en localStorage.
   ────────────────────────────────────────────────────────────── */
document.getElementById('btn-save-cal').addEventListener('click', () => {
  if (!applyCalib()) return;  // No guardar si hay errores
  if (typeof syncLastCmd === 'function') syncLastCmd();  // No mover servos al guardar
  const data = {};
  JDEFS.forEach(x => { data[x.key] = { min: J[x.key].calMin, max: J[x.key].calMax, dps: J[x.key].dps }; });
  try {
    localStorage.setItem(CAL_KEY, JSON.stringify(data));
    saveDps();
    saveNeutrals();
    if (typeof sendNeutrals === 'function') sendNeutrals();
    log('Calibración guardada — mueve un slider o usa "mover grados"', 'ok');
  } catch (e) {
    log('Error al guardar calibración', 'err');
  }
});


/* ──────────────────────────────────────────────────────────────
   BOTÓN: CARGAR CALIBRACIÓN
   Lee de localStorage y actualiza los inputs.
   ────────────────────────────────────────────────────────────── */
document.getElementById('btn-load-cal').addEventListener('click', () => {
  try {
    const saved = localStorage.getItem(CAL_KEY);
    if (!saved) { log('No hay calibración guardada', 'err'); return; }
    const data = JSON.parse(saved);
    JDEFS.forEach(x => {
      if (data[x.key]) {
        document.getElementById('cm-' + x.key).value = data[x.key].min;
        document.getElementById('cx-' + x.key).value = data[x.key].max;
        if (data[x.key].dps) {
          const el = document.getElementById('dps-' + x.key);
          if (el) el.value = data[x.key].dps;
        }
      }
    });
    applyCalib();
    if (typeof syncLastCmd === 'function') syncLastCmd();  // No mover servos al cargar
    log('Calibración cargada — mueve un slider para enviar al Arduino', 'ok');
  } catch (e) {
    log('Error al cargar calibración', 'err');
  }
});


/* ──────────────────────────────────────────────────────────────
   BOTÓN: RESTAURAR VALORES POR DEFECTO
   ────────────────────────────────────────────────────────────── */
document.getElementById('btn-reset-cal').addEventListener('click', () => {
  JDEFS.forEach(d => {
    document.getElementById('cm-' + d.key).value = CAL_DEFAULTS[d.key].min;
    document.getElementById('cx-' + d.key).value = CAL_DEFAULTS[d.key].max;
  });
  applyCalib();
  if (typeof syncLastCmd === 'function') syncLastCmd();  // No mover servos al restaurar
  log('Calibración restaurada a valores por defecto', 'info');
});


/* ──────────────────────────────────────────────────────────────
   BOTONES: IR A MÍNIMOS / MÁXIMOS
   Mueve todas las articulaciones a sus límites de calibración.
   Útil para verificar el rango real del hardware.
   ────────────────────────────────────────────────────────────── */
document.getElementById('btn-go-min').addEventListener('click', () => {
  JDEFS.forEach(d => setJoint(d.key, J[d.key].calMin));
  log('Moviendo a posiciones mínimas', 'info');
});
document.getElementById('btn-go-max').addEventListener('click', () => {
  JDEFS.forEach(d => setJoint(d.key, J[d.key].calMax));
  log('Moviendo a posiciones máximas', 'info');
});


/* ──────────────────────────────────────────────────────────────
   INICIALIZACIÓN
   Construir la UI y cargar calibración previa si existe.
   ────────────────────────────────────────────────────────────── */
buildCalibUI();

// Listener: cualquier cambio en el input del neutro → aplica en caliente
document.getElementById('calib-wrap').addEventListener('change', e => {
  if (!e.target.id || !e.target.id.startsWith('neu-')) return;
  const key = e.target.id.slice(4);
  const v = Math.max(260, Math.min(360, parseInt(e.target.value) || 307));
  e.target.value = v;
  neutrals[key] = v;
  saveNeutrals();
  if (typeof sendNeutrals === 'function') sendNeutrals();
  log(`${key}: neutro → ${v}`, 'info');
});

// Intentar cargar calibración guardada automáticamente al iniciar
try {
  const saved = localStorage.getItem(CAL_KEY);
  if (saved) {
    const data = JSON.parse(saved);
    JDEFS.forEach(x => {
      if (data[x.key]) {
        J[x.key].calMin = data[x.key].min;
        J[x.key].calMax = data[x.key].max;
      }
    });
    buildCalibUI();  // Reconstruir con los valores cargados
    log('Calibración previa restaurada automáticamente', 'info');
  }
} catch (e) {
  /* Si hay un error en el JSON guardado, simplemente usar los valores por defecto */
}
