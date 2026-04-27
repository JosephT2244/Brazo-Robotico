/* ═══════════════════════════════════════════════
   calibration.js — Calibración de servos MG995 (POSICIÓN)
   ────────────────────────────────────────────────────────────────
   Permite al usuario:
   • Definir el rango operativo (límites mín/máx) por servo dentro
     del rango físico permitido (Base 180°, Hombro 90°, Codo 45°,
     Muñeca 180°, Pinza 60°).
   • Calibrar el "0 lógico" de cada servo (PWM neutro). Esto permite
     alinear el cero de la página con el cero mecánico real del MG995.
   • Establecer y restaurar la POSICIÓN BASE (HOME) por servo.
   • Guardar TODO PARA SIEMPRE (persistencia en localStorage) con un
     único botón. Los valores se restablecen automáticamente al
     recargar la página.

   Dependencias: shared.js (JDEFS, J, setJoint, log) y arduino.js
                 (neutrals, saveNeutrals, sendNeutrals, sendCalibLimits)
   ═══════════════════════════════════════════════ */


/* Clave de localStorage para persistir TODA la calibración entre sesiones */
const CAL_KEY = 'roboarm-ipn-v11-calib';

/* Valores por defecto (rango total físico de cada servo) */
const CAL_DEFAULTS = {
  base: { min: -PHYSICAL_LIMITS.base, max:  PHYSICAL_LIMITS.base },
  sho:  { min: -PHYSICAL_LIMITS.sho,  max:  PHYSICAL_LIMITS.sho  },
  elb:  { min: -PHYSICAL_LIMITS.elb,  max:  PHYSICAL_LIMITS.elb  },
  wri:  { min: -PHYSICAL_LIMITS.wri,  max:  PHYSICAL_LIMITS.wri  },
  grip: { min: -PHYSICAL_LIMITS.grip, max:  PHYSICAL_LIMITS.grip },
};

const HOME_DEFAULTS = {
  base: 0, sho: 0, elb: 0, wri: 0, grip: 0,
};


/* ──────────────────────────────────────────────────────────────
   CONSTRUCCIÓN DE LA UI DE CALIBRACIÓN
   ────────────────────────────────────────────────────────────── */
function buildCalibUI() {
  document.getElementById('calib-wrap').innerHTML = JDEFS.map(d => `
    <div class="cb">
      <div class="cbn">${d.lbl} <span style="font-size:8px;color:var(--ink3);font-weight:400">(rango físico ±${d.angLim}°)</span></div>
      <div class="cgr">
        <span class="clb">Mín °</span>
        <input type="number" class="inp-n" id="cm-${d.key}" value="${J[d.key].calMin}" min="${-d.angLim}" max="${d.angLim}" step="1">
        <span class="cu">°</span>
      </div>
      <div class="cgr">
        <span class="clb">Máx °</span>
        <input type="number" class="inp-n" id="cx-${d.key}" value="${J[d.key].calMax}" min="${-d.angLim}" max="${d.angLim}" step="1">
        <span class="cu">°</span>
      </div>

      <!-- ── Calibración del CERO PWM ─────────────────────────── -->
      <div class="cgr" style="grid-template-columns:auto 28px 1fr 28px auto"
           title="PWM (en ticks PCA9685) que corresponde al 0° lógico de este servo. Ajusta hasta que la articulación quede mecánicamente alineada con el 0° de la página.">
        <span class="clb">Cero PWM</span>
        <button class="btn" onclick="trimZero('${d.key}', -1)" title="−1 tick">◀</button>
        <input type="number" class="inp-n" id="neu-${d.key}" value="${neutrals[d.key]}" min="${PULSE_HARD_MIN}" max="${PULSE_HARD_MAX}" step="1" style="text-align:center">
        <button class="btn" onclick="trimZero('${d.key}', +1)" title="+1 tick">▶</button>
        <span class="cu">tk</span>
      </div>
      <div class="cgr" style="grid-template-columns:1fr 1fr 1fr">
        <button class="btn" onclick="captureZero('${d.key}')" title="Toma la posición física actual como 0° lógico">📌 Fijar cero aquí</button>
        <button class="btn gh" onclick="testZero('${d.key}')" title="Mueve el servo a 0° con la calibración actual">Probar 0°</button>
        <button class="btn" onclick="resetZero('${d.key}')" title="Restablece el cero al PWM por defecto">↺ Cero</button>
      </div>
    </div>`
  ).join('');
}

function buildHomeUI() {
  const wrap = document.getElementById('home-wrap');
  if (!wrap) return;
  wrap.innerHTML = JDEFS.map(d => `
    <div class="cb">
      <div class="cbn">${d.lbl}</div>
      <div class="cgr">
        <span class="clb">HOME °</span>
        <input type="number" class="inp-n" id="hm-${d.key}" value="${getJointHome(d.key)}" min="${-d.angLim}" max="${d.angLim}" step="1">
        <span class="cu">°</span>
      </div>
      <div class="cgr" style="grid-template-columns:1fr 1fr">
        <button class="btn" data-home-current="${d.key}">Usar actual</button>
        <button class="btn gh" data-home-go="${d.key}">Ir HOME</button>
      </div>
    </div>`
  ).join('');
}

function refreshHomeInputs() {
  JDEFS.forEach(d => {
    const inp = document.getElementById('hm-' + d.key);
    if (!inp) return;
    inp.min = String(-d.angLim);
    inp.max = String(d.angLim);
    inp.step = '1';
    inp.value = String(getJointHome(d.key));
  });
}

function applyHomeCalib() {
  let allValid = true;
  JDEFS.forEach(d => {
    const inp = document.getElementById('hm-' + d.key);
    if (!inp) return;
    const raw = parseFloat(inp.value);
    if (isNaN(raw) || raw < -d.angLim || raw > d.angLim) {
      log(`Posición base no válida en ${d.lbl}: debe estar entre ${-d.angLim}° y ${d.angLim}°`, 'err');
      allValid = false;
      return;
    }
    inp.value = String(setJointHome(d.key, raw));
  });
  refreshHomeInputs();
  return allValid;
}


/* ──────────────────────────────────────────────────────────────
   CALIBRACIÓN DEL CERO POR SERVO
   ────────────────────────────────────────────────────────────── */

/* Trim manual: ±1 tick PWM al cero lógico, aplicado en caliente. */
function trimZero(key, delta) {
  const inp = document.getElementById('neu-' + key);
  if (!inp) return;
  let v = parseInt(inp.value) + delta;
  v = clamp(v, PULSE_HARD_MIN, PULSE_HARD_MAX);
  inp.value = v;
  neutrals[key] = v;
  saveNeutrals();
  if (typeof sendNeutrals === 'function') sendNeutrals();
  log(`${key}: cero PWM = ${v}`, 'info');
}

/* Captura la posición ACTUAL como nuevo 0°: el servo debe estar
   mecánicamente colocado en el ángulo que el usuario considera "0".
   Ajusta el PWM neutro para que la posición lógica actual se traduzca
   a ese PWM. */
function captureZero(key) {
  if (!J[key]) return;
  const inp = document.getElementById('neu-' + key);
  // PWM actual estimado = neutro + angPos*PWM_PER_DEG.
  // Queremos que esa misma PWM sea ahora "el nuevo neutro".
  const pwmNow = (neutrals[key] || NEUTRAL_DEFAULT) + Math.round(J[key].angPos * PWM_PER_DEG);
  const v = clamp(pwmNow, PULSE_HARD_MIN, PULSE_HARD_MAX);
  neutrals[key] = v;
  if (inp) inp.value = v;
  // Tras recalibrar, lo que era angPos pasa a ser 0 lógico.
  setJointTarget(key, 0);
  saveNeutrals();
  if (typeof sendNeutrals === 'function') sendNeutrals();
  log(`${key}: cero fijado en PWM ${v} (posición actual = 0°)`, 'ok');
}

/* Mueve el servo a 0° usando la calibración actual. */
function testZero(key) {
  if (!J[key]) return;
  setJointTarget(key, 0);
  log(`${key}: enviando a 0° con la calibración actual`, 'info');
}

/* Restablece el cero PWM al valor por defecto del centro. */
function resetZero(key) {
  if (!J[key]) return;
  neutrals[key] = NEUTRAL_DEFAULT;
  const inp = document.getElementById('neu-' + key);
  if (inp) inp.value = NEUTRAL_DEFAULT;
  saveNeutrals();
  if (typeof sendNeutrals === 'function') sendNeutrals();
  log(`${key}: cero PWM restablecido (${NEUTRAL_DEFAULT})`, 'info');
}


/* ──────────────────────────────────────────────────────────────
   APLICAR / VALIDAR CALIBRACIÓN
   ────────────────────────────────────────────────────────────── */
function applyCalib() {
  let allValid = true;

  JDEFS.forEach(d => {
    const mn = parseFloat(document.getElementById('cm-' + d.key).value);
    const mx = parseFloat(document.getElementById('cx-' + d.key).value);
    const nu = parseInt(document.getElementById('neu-' + d.key)?.value ?? neutrals[d.key]);
    if (!isNaN(nu) && nu >= PULSE_HARD_MIN && nu <= PULSE_HARD_MAX) neutrals[d.key] = nu;

    if (
      isNaN(mn) || isNaN(mx) || mn >= mx ||
      mn < -d.angLim || mx > d.angLim
    ) {
      log(`Rango inválido en ${d.lbl}: mín debe ser < máx y dentro de ±${d.angLim}°`, 'err');
      allValid = false;
      return;
    }

    J[d.key].calMin = mn;
    J[d.key].calMax = mx;

    // Actualizar sliders manuales
    ['sl-', 'ard-sl-'].forEach(prefix => {
      const sl = document.getElementById(prefix + d.key);
      if (sl) { sl.min = mn; sl.max = mx; }
    });

    // Etiquetas visibles
    const lmin = document.getElementById('lm-' + d.key + '-min');
    const lmax = document.getElementById('lm-' + d.key + '-max');
    if (lmin) lmin.textContent = mn + '°';
    if (lmax) lmax.textContent = mx + '°';

    // Re-clampear referencia HOME y target al nuevo rango
    setJointHome(d.key, getJointHome(d.key));
    _setJointTargetRaw(d.key, clampJointDeg(d.key, J[d.key].target));
  });

  if (allValid) {
    if (typeof refreshManualRangeUi === 'function') refreshManualRangeUi();
    refreshHomeInputs();
  }
  return allValid;
}


/* ──────────────────────────────────────────────────────────────
   GUARDAR PARA SIEMPRE (persistencia integral)
   Guarda límites + cero PWM + HOME por servo en localStorage,
   y los empuja al equipo conectado para que queden activos al
   instante. Al recargar la página, todo se restablece.
   ────────────────────────────────────────────────────────────── */
function saveCalibForever({ silent = false } = {}) {
  if (!applyCalib() || !applyHomeCalib()) return false;
  if (typeof syncLastCmd === 'function') syncLastCmd();
  const data = {};
  JDEFS.forEach(x => {
    data[x.key] = {
      min:  J[x.key].calMin,
      max:  J[x.key].calMax,
      home: getJointHome(x.key),
      zero: neutrals[x.key],
    };
  });
  try {
    localStorage.setItem(CAL_KEY, JSON.stringify(data));
    saveNeutrals();
    if (typeof sendNeutrals === 'function') sendNeutrals();
    if (typeof sendCalibLimits === 'function') sendCalibLimits();
    if (!silent) log('Ajustes guardados PARA SIEMPRE — se restablecerán al recargar la página', 'ok');
    return true;
  } catch (e) {
    log('No fue posible guardar los ajustes', 'err');
    return false;
  }
}


/* ──────────────────────────────────────────────────────────────
   BOTONES — guardar / cargar / restablecer
   ────────────────────────────────────────────────────────────── */
document.getElementById('btn-save-cal').addEventListener('click', () => {
  saveCalibForever();
});

const btnSaveForever = document.getElementById('btn-save-forever');
if (btnSaveForever) {
  btnSaveForever.addEventListener('click', () => {
    if (!saveCalibForever()) return;
    log('✓ Configuración persistida — disponible siempre que abras la página', 'ok');
  });
}

document.getElementById('btn-load-cal').addEventListener('click', () => {
  try {
    const saved = localStorage.getItem(CAL_KEY);
    if (!saved) { log('No hay ajustes guardados', 'err'); return; }
    const data = JSON.parse(saved);
    JDEFS.forEach(x => {
      const e = data[x.key]; if (!e) return;
      const cm = document.getElementById('cm-' + x.key);
      const cx = document.getElementById('cx-' + x.key);
      const nu = document.getElementById('neu-' + x.key);
      const hm = document.getElementById('hm-' + x.key);
      if (cm && typeof e.min === 'number') cm.value = e.min;
      if (cx && typeof e.max === 'number') cx.value = e.max;
      if (nu && typeof e.zero === 'number') nu.value = e.zero;
      if (hm && typeof e.home === 'number') hm.value = e.home;
      if (typeof e.zero === 'number' && e.zero >= PULSE_HARD_MIN && e.zero <= PULSE_HARD_MAX) {
        neutrals[x.key] = e.zero;
      }
    });
    if (!applyCalib() || !applyHomeCalib()) return;
    if (typeof syncLastCmd === 'function') syncLastCmd();
    saveNeutrals();
    if (typeof sendNeutrals === 'function') sendNeutrals();
    if (typeof sendCalibLimits === 'function') sendCalibLimits();
    log('Ajustes y posición base recuperados correctamente', 'ok');
  } catch (e) {
    log('No fue posible recuperar los ajustes', 'err');
  }
});

document.getElementById('btn-reset-cal').addEventListener('click', () => {
  JDEFS.forEach(d => {
    document.getElementById('cm-' + d.key).value = CAL_DEFAULTS[d.key].min;
    document.getElementById('cx-' + d.key).value = CAL_DEFAULTS[d.key].max;
    const neuEl = document.getElementById('neu-' + d.key);
    if (neuEl) neuEl.value = NEUTRAL_DEFAULT;
    neutrals[d.key] = NEUTRAL_DEFAULT;
    const homeEl = document.getElementById('hm-' + d.key);
    if (homeEl) homeEl.value = HOME_DEFAULTS[d.key];
  });
  applyCalib();
  applyHomeCalib();
  if (typeof syncLastCmd === 'function') syncLastCmd();
  saveNeutrals();
  if (typeof sendNeutrals === 'function') sendNeutrals();
  log('Los ajustes y la posición base se restablecieron a sus valores iniciales', 'info');
});


/* ──────────────────────────────────────────────────────────────
   IR A MÍNIMOS / MÁXIMOS
   ────────────────────────────────────────────────────────────── */
document.getElementById('btn-go-min').addEventListener('click', () => {
  JDEFS.forEach(d => setJointTarget(d.key, J[d.key].calMin));
  log('Llevando el equipo a posiciones mínimas', 'info');
});
document.getElementById('btn-go-max').addEventListener('click', () => {
  JDEFS.forEach(d => setJointTarget(d.key, J[d.key].calMax));
  log('Llevando el equipo a posiciones máximas', 'info');
});

document.getElementById('btn-capture-home').addEventListener('click', () => {
  const pose = captureCurrentPoseAsHome();
  JDEFS.forEach(d => {
    const inp = document.getElementById('hm-' + d.key);
    if (inp) inp.value = String(pose[d.key]);
  });
  log('La posición actual se guardó como referencia temporal — pulsa Guardar para conservarla', 'ok');
});

document.getElementById('btn-go-home-ref').addEventListener('click', () => {
  if (!applyHomeCalib()) return;
  moveToHomePose();
  log('Moviendo a la posición base', 'info');
});

document.getElementById('btn-reset-home').addEventListener('click', () => {
  JDEFS.forEach(d => {
    const inp = document.getElementById('hm-' + d.key);
    if (inp) inp.value = HOME_DEFAULTS[d.key];
  });
  applyHomeCalib();
  log('La posición base volvió a su valor inicial', 'info');
});


/* ──────────────────────────────────────────────────────────────
   INICIALIZACIÓN
   ────────────────────────────────────────────────────────────── */
buildCalibUI();
buildHomeUI();
refreshHomeInputs();

document.getElementById('home-wrap').addEventListener('click', e => {
  const currentBtn = e.target.closest('button[data-home-current]');
  if (currentBtn) {
    const key = currentBtn.dataset.homeCurrent;
    setJointHome(key, J[key].angPos);
    refreshHomeInputs();
    log(`${key}: posición base actualizada con la posición actual`, 'ok');
    return;
  }
  const goBtn = e.target.closest('button[data-home-go]');
  if (goBtn) {
    const key = goBtn.dataset.homeGo;
    if (!applyHomeCalib()) return;
    setJointTarget(key, getJointHome(key));
    log(`${key}: moviendo a la posición base`, 'info');
  }
});

// Listener: cualquier cambio en el input del cero PWM → aplica en caliente
document.getElementById('calib-wrap').addEventListener('change', e => {
  if (!e.target.id || !e.target.id.startsWith('neu-')) return;
  const key = e.target.id.slice(4);
  const v = clamp(parseInt(e.target.value) || NEUTRAL_DEFAULT, PULSE_HARD_MIN, PULSE_HARD_MAX);
  e.target.value = v;
  neutrals[key] = v;
  saveNeutrals();
  if (typeof sendNeutrals === 'function') sendNeutrals();
  log(`${key}: cero PWM → ${v}`, 'info');
});

// Carga automática de calibración guardada al iniciar
try {
  const saved = localStorage.getItem(CAL_KEY);
  if (saved) {
    const data = JSON.parse(saved);
    JDEFS.forEach(x => {
      const e = data[x.key]; if (!e) return;
      if (typeof e.min === 'number' && typeof e.max === 'number' && e.min < e.max) {
        J[x.key].calMin = clamp(e.min, -x.angLim, x.angLim);
        J[x.key].calMax = clamp(e.max, -x.angLim, x.angLim);
      }
      if (typeof e.zero === 'number' && e.zero >= PULSE_HARD_MIN && e.zero <= PULSE_HARD_MAX) {
        neutrals[x.key] = e.zero;
      }
      const home = typeof e.home === 'number' ? e.home : HOME_DEFAULTS[x.key];
      setJointHome(x.key, home);
    });
    buildCalibUI();
    buildHomeUI();
    refreshHomeInputs();
    if (typeof refreshManualRangeUi === 'function') refreshManualRangeUi();
    log('Se restauraron los ajustes guardados de la sesión anterior', 'info');
  }
} catch (e) {
  /* defaults */
}
