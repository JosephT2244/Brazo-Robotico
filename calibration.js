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
  base: { min: -PHYSICAL_LIMITS.base, max:  PHYSICAL_LIMITS.base },
  sho:  { min: -PHYSICAL_LIMITS.sho,  max:  PHYSICAL_LIMITS.sho  },
  elb:  { min: -PHYSICAL_LIMITS.elb,  max:  PHYSICAL_LIMITS.elb  },
  wri:  { min: -PHYSICAL_LIMITS.wri,  max:  PHYSICAL_LIMITS.wri  },
  grip: { min: -PHYSICAL_LIMITS.grip, max:  PHYSICAL_LIMITS.grip },
};
const LEGACY_CAL_DEFAULTS = {
  base: { min: -90, max:  90 },
  sho:  { min: -45, max:  45 },
  elb:  { min: -30, max:  30 },
  wri:  { min: -90, max:  90 },
  grip: { min: -30, max:  30 },
};
const HOME_DEFAULTS = {
  base: 0,
  sho:  0,
  elb:  0,
  wri:  0,
  grip: 0,
};

function normalizeCalRange(key, min, max) {
  const def = CAL_DEFAULTS[key];
  const legacy = LEGACY_CAL_DEFAULTS[key];
  if (!def) return { min, max, migrated: false };

  // Migra automáticamente el rango viejo de la UI manual (−10° a +10°),
  // que dejaba al control manual con solo 20° totales aunque el joint
  // real admitiera más recorrido.
  if (min === -10 && max === 10 && (def.min !== -10 || def.max !== 10)) {
    return { min: def.min, max: def.max, migrated: true };
  }

  // Si el usuario seguía con los topes de fábrica anteriores, ampliarlos
  // al nuevo rango físico sin tocar calibraciones personalizadas.
  if (legacy && min === legacy.min && max === legacy.max &&
      (def.min !== legacy.min || def.max !== legacy.max)) {
    return { min: def.min, max: def.max, migrated: true };
  }

  return { min, max, migrated: false };
}


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
        <span class="clb">Mín °</span>
        <input type="number" class="inp-n" id="cm-${d.key}" value="${J[d.key].calMin}" min="${-d.angLim}" max="${d.angLim}" step="1">
        <span class="cu">°</span>
      </div>
      <div class="cgr">
        <span class="clb">Máx °</span>
        <input type="number" class="inp-n" id="cx-${d.key}" value="${J[d.key].calMax}" min="${-d.angLim}" max="${d.angLim}" step="1">
        <span class="cu">°</span>
      </div>
      <div class="cgr">
        <span class="clb">Vel</span>
        <input type="number" class="inp-n" id="dps-${d.key}" value="${J[d.key].dps.toFixed(1)}" min="${MIN_SPEED_DPS}" max="60" step="0.5">
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
    log('Conecta el equipo primero para realizar este ajuste', 'err'); return;
  }
  setJointTarget(key, J[key].angPos);
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

  log(`Ajuste automático ${key}: buscando el punto estable… pulsa ESPACIO al detenerse`, 'info');
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
    log('Conecta el equipo primero', 'err'); return;
  }
  for (const d of JDEFS) setJointTarget(d.key, J[d.key].angPos);
  log('Todos los ejes quedaron en reposo — ajusta cada control hasta eliminar movimiento residual', 'info');
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
  // Pausar el ciclo de commit mientras medimos, para que no envíe pulsos propios
  // que interrumpan el test de 3 segundos continuos.
  if (typeof serialT !== 'undefined' && serialT) { clearInterval(serialT); serialT = null; }
  const ch = ({ base:'B', sho:'H', elb:'C', wri:'W', grip:'G' })[key];
  await sendRaw(`${ch}:${TEST_SECS.toFixed(3)}`);
  await new Promise(r => setTimeout(r, TEST_SECS * 1000 + 200));
  await sendRaw(`${ch}:0.000`);
  // Reactivar el intervalo de envío periódico
  if (typeof serialT !== 'undefined' && !serialT && typeof sendPos === 'function') {
    serialT = setInterval(sendPos, Math.round(1000 / (serialHz || 20)));
  }
  const ans = prompt(`¿Cuántos GRADOS se movió ${key.toUpperCase()} en ${TEST_SECS}s?`, '');
  const deg = parseFloat(ans);
  if (!isNaN(deg) && deg > 0) {
    const measuredDps = deg / TEST_SECS;
    J[key].dpsBase = measuredDps / (speedDps / DEFAULT_SPEED_DPS);
    applySpeedProfile(speedDps);
    document.getElementById('dps-' + key).value = J[key].dps.toFixed(1);
    saveDps();
    log(`${key} calibrado: ${measuredDps.toFixed(1)} °/s`, 'ok');
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
    if (
      isNaN(mn) || isNaN(mx) || mn >= mx ||
      mn < -d.angLim || mx > d.angLim
    ) {
      log(`Rango inválido en ${d.lbl}: mín debe ser < máx`, 'err');
      allValid = false;
      return;
    }

    // Actualizar límites en el estado global
    J[d.key].calMin = mn;
    J[d.key].calMax = mx;
    if (!isNaN(dp) && dp > 0) {
      J[d.key].dpsBase = dp / (speedDps / DEFAULT_SPEED_DPS);
    }

    // Actualizar el slider manual para que refleje los nuevos límites
    ['sl-', 'ard-sl-'].forEach(prefix => {
      const sl = document.getElementById(prefix + d.key);
      if (sl) { sl.min = mn; sl.max = mx; }
    });

    // Actualizar las etiquetas de límites visibles debajo del slider
    const lmin = document.getElementById('lm-' + d.key + '-min');
    const lmax = document.getElementById('lm-' + d.key + '-max');
    if (lmin) lmin.textContent = mn + '°';
    if (lmax) lmax.textContent = mx + '°';

    // Re-clampear el valor actual al nuevo rango (si estaba fuera de límites)
    setJointHome(d.key, getJointHome(d.key));
    _setJointTargetRaw(d.key, clampJointDeg(d.key, J[d.key].target));
    J[d.key].angPos = clampJointDeg(d.key, J[d.key].angPos);
    J[d.key].committed = clampJointDeg(d.key, J[d.key].committed);
  });

  if (allValid) {
    applySpeedProfile(speedDps);
    if (typeof refreshManualRangeUi === 'function') refreshManualRangeUi();
    refreshHomeInputs();
  }
  return allValid;
}


/* ──────────────────────────────────────────────────────────────
   BOTÓN: GUARDAR CALIBRACIÓN
   Aplica y persiste en localStorage.
   ────────────────────────────────────────────────────────────── */
document.getElementById('btn-save-cal').addEventListener('click', () => {
  if (!applyCalib() || !applyHomeCalib()) return;  // No guardar si hay errores
  if (typeof syncLastCmd === 'function') syncLastCmd();  // No mover servos al guardar
  const data = {};
  JDEFS.forEach(x => {
    data[x.key] = {
      min: J[x.key].calMin,
      max: J[x.key].calMax,
      dps: J[x.key].dpsBase,
      home: getJointHome(x.key),
    };
  });
  try {
    localStorage.setItem(CAL_KEY, JSON.stringify(data));
    saveDps();
    saveNeutrals();
    if (typeof sendNeutrals === 'function') sendNeutrals();
    log('Ajustes y posición base guardados correctamente', 'ok');
  } catch (e) {
    log('No fue posible guardar los ajustes', 'err');
  }
});


/* ──────────────────────────────────────────────────────────────
   BOTÓN: CARGAR CALIBRACIÓN
   Lee de localStorage y actualiza los inputs.
   ────────────────────────────────────────────────────────────── */
document.getElementById('btn-load-cal').addEventListener('click', () => {
  try {
    const saved = localStorage.getItem(CAL_KEY);
    if (!saved) { log('No hay ajustes guardados', 'err'); return; }
    const data = JSON.parse(saved);
    let migrated = false;
    JDEFS.forEach(x => {
      if (data[x.key]) {
        const parsedMin = parseFloat(data[x.key].min);
        const parsedMax = parseFloat(data[x.key].max);
        const fixed = normalizeCalRange(x.key, parsedMin, parsedMax);
        document.getElementById('cm-' + x.key).value = fixed.min;
        document.getElementById('cx-' + x.key).value = fixed.max;
        if (fixed.migrated) {
          data[x.key].min = fixed.min;
          data[x.key].max = fixed.max;
          migrated = true;
        }
        if (data[x.key].dps) {
          const el = document.getElementById('dps-' + x.key);
          if (el) el.value = (data[x.key].dps * (speedDps / DEFAULT_SPEED_DPS)).toFixed(1);
        }
        if (typeof data[x.key].home === 'number') {
          const homeEl = document.getElementById('hm-' + x.key);
          if (homeEl) homeEl.value = data[x.key].home;
        } else {
          data[x.key].home = HOME_DEFAULTS[x.key];
        }
      }
    });
    if (!applyCalib() || !applyHomeCalib()) return;
    if (typeof syncLastCmd === 'function') syncLastCmd();  // No mover servos al cargar
    if (migrated) {
      try { localStorage.setItem(CAL_KEY, JSON.stringify(data)); } catch (e) {}
      log('Ajustes recuperados y rangos anteriores actualizados automáticamente', 'ok');
    } else {
      log('Ajustes y posición base recuperados correctamente', 'ok');
    }
  } catch (e) {
    log('No fue posible recuperar los ajustes', 'err');
  }
});


/* ──────────────────────────────────────────────────────────────
   BOTÓN: RESTAURAR VALORES POR DEFECTO
   ────────────────────────────────────────────────────────────── */
document.getElementById('btn-reset-cal').addEventListener('click', () => {
  JDEFS.forEach(d => {
    document.getElementById('cm-' + d.key).value = CAL_DEFAULTS[d.key].min;
    document.getElementById('cx-' + d.key).value = CAL_DEFAULTS[d.key].max;
    const dpsEl = document.getElementById('dps-' + d.key);
    if (dpsEl) dpsEl.value = J[d.key].dps.toFixed(1);
    const homeEl = document.getElementById('hm-' + d.key);
    if (homeEl) homeEl.value = HOME_DEFAULTS[d.key];
  });
  applyCalib();
  applyHomeCalib();
  if (typeof syncLastCmd === 'function') syncLastCmd();  // No mover servos al restaurar
  log('Los ajustes y la posición base se restablecieron a sus valores iniciales', 'info');
});


/* ──────────────────────────────────────────────────────────────
   BOTONES: IR A MÍNIMOS / MÁXIMOS
   Mueve todas las articulaciones a sus límites de calibración.
   Útil para verificar el rango real del hardware.
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
  log('La posición actual se guardó como referencia temporal — pulsa Guardar ajustes para conservarla', 'ok');
});

document.getElementById('btn-go-home-ref').addEventListener('click', () => {
  if (!applyHomeCalib()) return;
  moveToHomePose();
  log('Moviendo a la posición base', 'info');
});

// Restituye solo la referencia HOME sin alterar los límites min/max.
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
   Construir la UI y cargar calibración previa si existe.
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

  // Botón contextual por articulación para ir a su HOME individual.
  const goBtn = e.target.closest('button[data-home-go]');
  if (goBtn) {
    const key = goBtn.dataset.homeGo;
    if (!applyHomeCalib()) return;
    setJointTarget(key, getJointHome(key));
    log(`${key}: moviendo a la posición base`, 'info');
  }
});

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
    let migrated = false;
    const normalized = {};
    JDEFS.forEach(x => {
      if (data[x.key]) {
        const parsedMin = parseFloat(data[x.key].min);
        const parsedMax = parseFloat(data[x.key].max);
        if (!isFinite(parsedMin) || !isFinite(parsedMax)) return;
        const fixed = normalizeCalRange(x.key, parsedMin, parsedMax);
        J[x.key].calMin = fixed.min;
        J[x.key].calMax = fixed.max;
        const home = typeof data[x.key].home === 'number' ? data[x.key].home : HOME_DEFAULTS[x.key];
        setJointHome(x.key, home);
        normalized[x.key] = { ...data[x.key], min: fixed.min, max: fixed.max, home };
        migrated ||= fixed.migrated;
        if (typeof data[x.key].dps === 'number' && data[x.key].dps > 0) {
          J[x.key].dpsBase = data[x.key].dps;
        }
      }
    });
    applySpeedProfile(speedDps);
    buildCalibUI();  // Reconstruir con los valores cargados
    buildHomeUI();
    refreshHomeInputs();
    if (typeof refreshManualRangeUi === 'function') refreshManualRangeUi();
    if (migrated) {
      try { localStorage.setItem(CAL_KEY, JSON.stringify(normalized)); } catch (e) {}
      log('Se restauraron los ajustes previos y se actualizaron los rangos anteriores automáticamente', 'info');
    } else {
      log('Se restauraron automáticamente los ajustes previos y la posición base', 'info');
    }
  }
} catch (e) {
  /* Si hay un error en el JSON guardado, simplemente usar los valores por defecto */
}
