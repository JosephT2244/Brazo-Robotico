/* ════════════════════════════════════════════════
   arduino.js — Control Serial RoboArm IPN v5.0 (POSICIÓN)
   ────────────────────────────────────────────────────────────────
   Servos MG995 Hi-SPEED de 180° controlados por POSICIÓN angular.

   PROTOCOLO:
     TX → Arduino: "B:90.0,H:90.0,C:90.0,W:-90.0,G:15.0\n"
       (ángulos en GRADOS, signo respecto al cero calibrado)
     RX ← Arduino: "OK B:90 H:90 C:90 W:-90 G:15\n" | "PONG" | "READY"

   COMANDOS especiales:
     PING            → PONG
     HOME            → todos los servos a 0° lógico
     Z:b,h,c,w,g     → fija el PWM (ticks PCA9685) que corresponde al 0°
                       de cada servo (calibración del cero)
     LIM:b-,b+,h-,h+,c-,c+,w-,w+,g-,g+
                     → fija los límites angulares por servo en el firmware

   Dependencias: shared.js (J, JDEFS, clamp, lerp, batchJoints, log, modal)
   ════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════
   MAPA DE CANALES — relación servo ↔ canal PCA9685
   ══════════════════════════════════════════════ */
const CHAN_DEFAULTS = { base:4, sho:3, elb:2, wri:1, grip:0 };
const CHAN_KEY      = 'roboarm-channels-v5';
const totalRangeLabel = total => `${total}° totales`;

let chanMap = { ...CHAN_DEFAULTS };
try {
  const saved = localStorage.getItem(CHAN_KEY);
  if (saved) {
    const parsed = JSON.parse(saved);
    const valid = ['base','sho','elb','wri','grip'].every(k =>
      typeof parsed[k] === 'number' && parsed[k] >= 0 && parsed[k] <= 15
    );
    if (valid) chanMap = parsed;
  }
} catch(e) { /* defaults */ }

/* Meta-info por servo (para firmware y telemetría) */
const SERVO_META = {
  base: { label:'Base',   varName:'CH_BASE',     min:PHYSICAL_MIN.base, max:PHYSICAL_MAX.base, range:totalRangeLabel(PHYSICAL_TOTAL.base) },
  sho:  { label:'Hombro', varName:'CH_SHOULDER', min:PHYSICAL_MIN.sho,  max:PHYSICAL_MAX.sho,  range:totalRangeLabel(PHYSICAL_TOTAL.sho)  },
  elb:  { label:'Codo',   varName:'CH_ELBOW',    min:PHYSICAL_MIN.elb,  max:PHYSICAL_MAX.elb,  range:totalRangeLabel(PHYSICAL_TOTAL.elb)  },
  wri:  { label:'Muñeca', varName:'CH_WRIST',    min:PHYSICAL_MIN.wri,  max:PHYSICAL_MAX.wri,  range:totalRangeLabel(PHYSICAL_TOTAL.wri)  },
  grip: { label:'Pinza',  varName:'CH_GRIPPER',  min:PHYSICAL_MIN.grip, max:PHYSICAL_MAX.grip, range:totalRangeLabel(PHYSICAL_TOTAL.grip) },
};


/* ══════════════════════════════════════════════
   CALIBRACIÓN DE CERO POR SERVO
   ──────────────────────────────────────────────────────────────
   Cada MG995 tiene su propio "centro" físico. El usuario calibra
   el PWM (en ticks PCA9685) que corresponde a "0° lógico" de cada
   servo. Por defecto = 307 (≈1500 µs, centro estándar). El offset
   se guarda en localStorage como "neutro" por servo.
   ══════════════════════════════════════════════ */
const PULSE_HARD_MIN = 102;   // ≈ 500 µs (0° del servo MG995)
const PULSE_HARD_MAX = 512;   // ≈ 2500 µs (180° del servo MG995)
const PWM_PER_DEG    = (PULSE_HARD_MAX - PULSE_HARD_MIN) / 180;  // ≈ 2.28 ticks/°
const NEUTRAL_KEY     = 'roboarm-zeros-v1';
const NEUTRAL_DEFAULT = Math.round((PULSE_HARD_MIN + PULSE_HARD_MAX) / 2);  // 307

let neutrals = { base:NEUTRAL_DEFAULT, sho:NEUTRAL_DEFAULT, elb:NEUTRAL_DEFAULT, wri:NEUTRAL_DEFAULT, grip:NEUTRAL_DEFAULT };
try {
  // Limpia versiones previas que mezclaban "neutro de velocidad"
  ['roboarm-neutrals-v1','roboarm-neutrals-v2','roboarm-neutrals-v3'].forEach(k => localStorage.removeItem(k));
  const saved = JSON.parse(localStorage.getItem(NEUTRAL_KEY) || 'null');
  if (saved) ['base','sho','elb','wri','grip'].forEach(k => {
    const n = parseInt(saved[k]);
    if (n >= PULSE_HARD_MIN && n <= PULSE_HARD_MAX) neutrals[k] = n;
  });
} catch(e) { /* defaults */ }

function saveNeutrals() {
  try { localStorage.setItem(NEUTRAL_KEY, JSON.stringify(neutrals)); } catch(e) {}
}

/** Envía al Arduino los ceros PWM calibrados. */
function sendNeutrals() {
  if (!writer) return;
  const cmd = `Z:${neutrals.base},${neutrals.sho},${neutrals.elb},${neutrals.wri},${neutrals.grip}`;
  return sendRaw(cmd);
}

/** Refresca cada 8 s los ceros (por si el firmware se reinició silencioso). */
let _neuRefreshTimer = null;
function startNeuRefresh() {
  clearInterval(_neuRefreshTimer);
  _neuRefreshTimer = setInterval(() => {
    if (writer) sendNeutrals();
  }, 8000);
}
function stopNeuRefresh() {
  clearInterval(_neuRefreshTimer);
  _neuRefreshTimer = null;
}

/** Convierte ángulo (°) → PWM (ticks PCA9685) usando el neutro calibrado. */
function angleToPwm(key, deg) {
  const n = neutrals[key] ?? NEUTRAL_DEFAULT;
  const v = n + Math.round(deg * PWM_PER_DEG);
  return clamp(v, PULSE_HARD_MIN, PULSE_HARD_MAX);
}

function formatLimitDeg(deg) {
  return String(Math.round(deg * 100) / 100);
}

/** Envía los límites angulares calibrados al firmware (clamp duro). */
function sendCalibLimits() {
  if (!writer) return;
  const order = ['base','sho','elb','wri','grip'];
  const parts = [];
  order.forEach(k => {
    parts.push(formatLimitDeg(jointMin(k)), formatLimitDeg(jointMax(k)));
  });
  return sendRaw(`LIM:${parts.join(',')}`);
}


/* ══════════════════════════════════════════════
   GENERADOR DE FIRMWARE
   Genera un .ino que usa PCA9685 en modo POSICIÓN.
   Incluye: conversión ángulo→PWM, ZERO trim, límites duros.
   ══════════════════════════════════════════════ */
function generateFirmware() {
  const chanComment = ['base','sho','elb','wri','grip']
    .map(k => `//    CH${chanMap[k]} = ${SERVO_META[k].label.padEnd(7)} (${SERVO_META[k].range})`)
    .join('\n');

  const defineLines = ['base','sho','elb','wri','grip']
    .map(k => `#define ${SERVO_META[k].varName.padEnd(13)} ${chanMap[k]}`)
    .join('\n');

  const limMin = JDEFS.map(d => formatLimitDeg(jointMin(d.key))).join(', ');
  const limMax = JDEFS.map(d => formatLimitDeg(jointMax(d.key))).join(', ');

  return `// ═══════════════════════════════════════════
//  RoboArm IPN — Firmware v5.1  (POSICIÓN · MG995 Hi-SPEED 180°)
//
//  ESTE FIRMWARE ES EXCLUSIVAMENTE PARA SERVOS DE ÁNGULO (POSICIÓN):
//    • Cada comando especifica un ÁNGULO en grados.
//    • La conversión grados → PWM se hace por la fórmula:
//          PWM = zeroPwm[i] + grados * (PULSE_HARD_MAX - PULSE_HARD_MIN) / 180
//      donde zeroPwm[i] es el PWM calibrado del 0° lógico de cada servo.
//    • NO existe lógica de "velocidad" ni de "pulsos por segundos".
//      El servo MG995 mueve internamente al ángulo solicitado y mantiene
//      esa posición mientras reciba la señal PWM correspondiente.
//
//  Hardware: Arduino Uno/Mega + PCA9685 + 5× MG995 Hi-SPEED 180°
//
//  CONEXIONES PCA9685:
//    Arduino 5V  → VCC    (alimentación lógica del módulo)
//    Arduino GND → GND    (tierra lógica)
//    Arduino SDA → SDA    (UNO: A4  / MEGA: pin 20)
//    Arduino SCL → SCL    (UNO: A5  / MEGA: pin 21)
//    Fuente 6V/8A (+) → V+  (alimentación de servos)
//    Fuente 6V/8A (-) → GND (tierra común — OBLIGATORIO)
//
//  CANALES PCA9685 (configurados desde la web):
${chanComment}
//
//  Protocolo RX: "B:90.0,H:90.0,C:90.0,W:-90.0,G:15.0\\n" (grados)
//  Protocolo TX: "OK B:90 H:90 C:90 W:-90 G:15\\n"
//
//  Comandos especiales:
//    PING                  → PONG
//    HOME                  → todos los servos a 0° lógico
//    Z:b,h,c,w,g           → calibración del cero PWM por servo
//    LIM:b-,b+,...,g-,g+   → límites angulares por servo (firmware)
//    STOP                  → PARO DE EMERGENCIA: el firmware FIJA cada
//                            servo en su PWM actual y descarta cualquier
//                            comando de movimiento posterior. Los servos
//                            mantienen exactamente su posición actual
//                            (no se mueven a "neutro" ni a 0°).
//    RESUME                → libera el bloqueo del PARO. A partir de
//                            aquí los movimientos vuelven a aceptarse.
//    OFF                   → corta la señal PWM (servos quedan libres).
// ═══════════════════════════════════════════

#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

// PCA9685 a 50 Hz. Período 20 ms / 4096 ticks ⇒ 1 tick ≈ 4.88 µs.
#define SERVO_FREQ        50
#define PULSE_HARD_MIN    ${PULSE_HARD_MIN}     // ≈ 500 µs  → 0°  del MG995
#define PULSE_HARD_MAX    ${PULSE_HARD_MAX}     // ≈ 2500 µs → 180° del MG995

// 1° ≈ ${PWM_PER_DEG.toFixed(3)} ticks. Usamos un múltiplo entero por simplicidad.
#define PWM_PER_DEG_X100  ${Math.round(PWM_PER_DEG * 100)}

// ── Asignación de canales ──────────────────────────────────────
${defineLines}

const uint8_t CH_IDX[5] = { CH_BASE, CH_SHOULDER, CH_ELBOW, CH_WRIST, CH_GRIPPER };

// PWM correspondiente al 0° lógico de cada servo (calibrable en caliente con Z:)
uint16_t zeroPwm[5] = { ${neutrals.base}, ${neutrals.sho}, ${neutrals.elb}, ${neutrals.wri}, ${neutrals.grip} };

// Límites angulares por servo (en GRADOS, ya restringidos a la calibración del usuario)
float limMin[5] = { ${limMin} };
float limMax[5] = { ${limMax} };

// Última posición conocida (en GRADOS) por servo.
// Cada servo MG995 mantiene esta posición mientras la PCA9685 emita
// el PWM correspondiente — no se necesita "refresh" continuo.
float lastDeg[5] = { 0, 0, 0, 0, 0 };
bool outputsEnabled = false;

// Estado del PARO DE EMERGENCIA. Mientras "frozen" sea true:
//   • Los servos siguen recibiendo SU PWM actual (mantienen posición).
//   • Cualquier comando de movimiento (B:/H:/C:/W:/G:) es DESCARTADO.
//   • Sólo RESUME, OFF, PING o calibración pueden cambiar el estado.
// Esto garantiza que un STOP no envía a los servos a un "neutro" que
// pudiera no estar correctamente calibrado: el servo se queda
// exactamente donde lo dejó el último comando.
bool frozen = false;

String buf = "";
unsigned long _lastAtPos = 0;

uint16_t angleToPwm(uint8_t i, float deg) {
  if (deg < limMin[i]) deg = limMin[i];
  if (deg > limMax[i]) deg = limMax[i];
  long delta = (long)(deg * (float)PWM_PER_DEG_X100 / 100.0f);
  long v = (long)zeroPwm[i] + delta;
  if (v < PULSE_HARD_MIN) v = PULSE_HARD_MIN;
  if (v > PULSE_HARD_MAX) v = PULSE_HARD_MAX;
  return (uint16_t)v;
}

void disableServoSignals() {
  for (uint8_t i = 0; i < 5; i++) pwm.setPWM(CH_IDX[i], 0, 4096);
}

void armOutputs() {
  if (outputsEnabled) return;
  outputsEnabled = true;
}

void writeServo(uint8_t i, float deg) {
  lastDeg[i] = deg;
  if (!outputsEnabled) return;
  pwm.setPWM(CH_IDX[i], 0, angleToPwm(i, deg));
}

void writeAll() {
  for (uint8_t i = 0; i < 5; i++)
    pwm.setPWM(CH_IDX[i], 0, angleToPwm(i, lastDeg[i]));
}

void parseCmd(String cmd) {
  cmd.trim();
  if (!cmd.length()) return;

  if (cmd == "PING") { Serial.println("PONG"); return; }

  // ── PARO DE EMERGENCIA ────────────────────────────────────
  // Congela el firmware en la posición actual de cada servo.
  // Re-emitimos las últimas PWM para asegurar que la PCA9685 las
  // tenga vivas y los servos NO se muevan a un valor por error.
  if (cmd == "STOP") {
    frozen = true;
    armOutputs();
    writeAll();
    Serial.println("OK STOP");
    return;
  }

  // Libera el bloqueo del PARO. A partir de aquí los movimientos
  // vuelven a aceptarse normalmente.
  if (cmd == "RESUME") {
    frozen = false;
    Serial.println("OK RESUME");
    return;
  }

  // Corta la señal PWM (servos quedan libres).
  if (cmd == "OFF") {
    frozen = true;
    outputsEnabled = false;
    disableServoSignals();
    Serial.println("OK OFF");
    return;
  }

  if (cmd == "HOME") {
    if (frozen) { Serial.println("BLOCKED frozen"); return; }
    for (uint8_t i = 0; i < 5; i++) lastDeg[i] = 0;
    armOutputs();
    writeAll();
    Serial.println("OK HOME");
    return;
  }

  // Z:b,h,c,w,g  → calibración del cero (PWM ticks por servo)
  if (cmd.startsWith("Z:")) {
    String body = cmd.substring(2);
    int idx = 0, s2 = 0;
    while (s2 < (int)body.length() && idx < 5) {
      int cm = body.indexOf(',', s2); if (cm < 0) cm = body.length();
      long v = body.substring(s2, cm).toInt();
      if (v >= PULSE_HARD_MIN && v <= PULSE_HARD_MAX) zeroPwm[idx] = (uint16_t)v;
      s2 = cm + 1; idx++;
    }
    Serial.print("OK Z");
    for (uint8_t i = 0; i < 5; i++) { Serial.print(' '); Serial.print(zeroPwm[i]); }
    Serial.println();
    return;
  }

  // LIM:b-,b+,h-,h+,c-,c+,w-,w+,g-,g+
  if (cmd.startsWith("LIM:")) {
    String body = cmd.substring(4);
    int idx = 0, s2 = 0;
    while (s2 < (int)body.length() && idx < 10) {
      int cm = body.indexOf(',', s2); if (cm < 0) cm = body.length();
      float v = body.substring(s2, cm).toFloat();
      if (v >= -127 && v <= 127) {
        if ((idx & 1) == 0) limMin[idx >> 1] = v;
        else                limMax[idx >> 1] = v;
      }
      s2 = cm + 1; idx++;
    }
    Serial.println("OK LIM");
    return;
  }

  // Posiciones angulares: "B:90.0,H:90.0,C:90.0,W:-90.0,G:15.0"
  // Si el firmware está en PARO (frozen), descartamos por completo.
  if (frozen) {
    Serial.println("BLOCKED frozen");
    return;
  }
  int s = 0;
  bool hasMotionCmd = false;
  while (s < (int)cmd.length()) {
    int cm = cmd.indexOf(',', s); if (cm < 0) cm = cmd.length();
    String tok = cmd.substring(s, cm);
    int col = tok.indexOf(':');
    if (col > 0) {
      float v = tok.substring(col + 1).toFloat();
      uint8_t i = 255;
      switch (tok.charAt(0)) {
        case 'B': i = 0; break;
        case 'H': i = 1; break;
        case 'C': i = 2; break;
        case 'W': i = 3; break;
        case 'G': i = 4; break;
      }
      if (i < 5) { writeServo(i, v); hasMotionCmd = true; }
    }
    s = cm + 1;
  }
  if (hasMotionCmd) armOutputs();
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  pwm.begin();
  pwm.setOscillatorFrequency(27000000);
  pwm.setPWMFreq(SERVO_FREQ);
  delay(10);
  disableServoSignals();
  Serial.println("READY IPN-RoboArm v5.0");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\\n') { parseCmd(buf); buf = ""; }
    else if (buf.length() < 96) buf += c;
  }
  unsigned long now = millis();
  if (outputsEnabled && now - _lastAtPos >= 800) {
    Serial.println("AT_POS");
    _lastAtPos = now;
  }
}`;
}


/* ══════════════════════════════════════════════
   GESTIÓN DEL MAPA DE CANALES
   ══════════════════════════════════════════════ */
function validateChannels() {
  const used = {};
  for (const [servo, ch] of Object.entries(chanMap)) {
    if (used[ch] !== undefined) {
      const a = SERVO_META[used[ch]].label;
      const b = SERVO_META[servo].label;
      return `⚠ Canal ${ch} asignado a ${a} Y ${b}`;
    }
    used[ch] = servo;
  }
  return null;
}

function readChannelsFromUI() {
  ['base','sho','elb','wri','grip'].forEach(k => {
    const el = document.getElementById('chan-' + k);
    if (el) chanMap[k] = parseInt(el.value);
  });
}

function applyChannelsToUI() {
  ['base','sho','elb','wri','grip'].forEach(k => {
    const el = document.getElementById('chan-' + k);
    if (el) el.value = String(chanMap[k]);
  });
}

function refreshChannelStatus() {
  const err  = validateChannels();
  const okEl = document.getElementById('chan-ok');
  const fwEl = document.getElementById('fw');

  if (okEl) {
    if (err) {
      okEl.textContent = err;
      okEl.style.color = 'var(--err)';
    } else {
      okEl.textContent = '✓ Configuración válida — firmware actualizado';
      okEl.style.color = 'var(--ok)';
    }
  }

  if (fwEl) fwEl.textContent = generateFirmware();
  updateTelemChannels();
  refreshChanLog();
}

function updateTelemChannels() {
  ['base','sho','elb','wri','grip'].forEach(k => {
    const el = document.getElementById('stg-' + k + '-ch');
    if (el) el.textContent = chanMap[k];
  });
}

function refreshChanLog() {
  const parts = ['base','sho','elb','wri','grip']
    .map(k => `CH${chanMap[k]}=${SERVO_META[k].label}`)
    .join('  ');
  const slogEl = document.getElementById('slog');
  if (slogEl) {
    const existing = slogEl.querySelector('.chan-log-line');
    if (existing) existing.textContent = '[canales] ' + parts;
  }
}

function saveChannels() {
  readChannelsFromUI();
  const err = validateChannels();
  if (err) { log(err, 'err'); return; }
  localStorage.setItem(CHAN_KEY, JSON.stringify(chanMap));
  refreshChannelStatus();
  log('Asignación de canales guardada ✓', 'ok');
  slog('Canales actualizados: ' + ['base','sho','elb','wri','grip']
    .map(k=>`CH${chanMap[k]}=${SERVO_META[k].label}`).join(' '), 's-sy');
}

function resetChannels() {
  chanMap = { ...CHAN_DEFAULTS };
  applyChannelsToUI();
  refreshChannelStatus();
  log('Canales restablecidos a valores por defecto', 'info');
}


/* ══════════════════════════════════════════════
   COMUNICACIÓN SERIAL
   ══════════════════════════════════════════════ */
let port=null, writer=null, reader=null;
let serialHz=30, serialT=null;
let pktCount=0, lastTxMs=0;
let _pendingPort=null;
let _readyTimer=null;
let _pingTimer=null;
let _uploadAfterReady=false;
let _serverAvail=false;
let _uploadInFlight=false;
let _ignoreHotplugDuringUpload=false;
let _reconnectAfterUploadTimer=null;
let _idleSyncInFlight=null;
const _rxWaiters = [];
const READY_TIMEOUT_MS = 1200;
const PING_TIMEOUT_MS  = 1200;

function _serialPortLabel(serialPort) {
  try {
    const info = serialPort?.getInfo?.();
    const vid = info?.usbVendorId;
    const pid = info?.usbProductId;
    if (vid && pid) {
      return `USB ${vid.toString(16).toUpperCase()}:${pid.toString(16).toUpperCase()}`;
    }
  } catch(e) {}
  return '';
}

function showAutoConnectBanner(serialPort) {
  _pendingPort = serialPort;
  const b = document.getElementById('auto-connect-banner');
  const msg = document.getElementById('banner-msg');
  const label = _serialPortLabel(serialPort);
  if (msg) msg.textContent = label
    ? `Arduino detectado (${label}) — elige cómo continuar`
    : 'Arduino detectado — elige cómo continuar';
  if (b) b.classList.add('visible');
}

function hideAutoConnectBanner() {
  const b = document.getElementById('auto-connect-banner');
  if (b) b.classList.remove('visible');
  _pendingPort = null;
}

function _readyFallback() {
  clearTimeout(_readyTimer);
  clearTimeout(_pingTimer);
  _readyTimer = setTimeout(() => {
    if (!port) return;
    log('Sin confirmación inicial — verificando la comunicación del equipo…', 'info');
    sendRaw('PING');
    _pingTimer = setTimeout(() => {
      if (port && !serialT) {
        if (_uploadAfterReady) {
          if (_serverAvail) {
            log('Se detectó una configuración distinta — iniciando la carga solicitada', 'info');
            slog('Sin respuesta inicial — iniciando la carga solicitada', 's-sy');
            uploadFirmware();
          } else {
            log('No se reconoció la configuración actual — abre start-server.bat para habilitar la carga', 'err');
            slog('Inicia start-server.bat para habilitar la carga desde la plataforma', 's-er');
          }
        } else {
          log('Se detectó una configuración diferente — no se reemplazará hasta que lo solicites', 'err');
          slog('Usa "⬆ Cargar al equipo" si deseas instalar la configuración recomendada', 's-er');
        }
      }
    }, PING_TIMEOUT_MS);
  }, READY_TIMEOUT_MS);
}

async function _safeOpenPort(p) {
  const withTimeout = (pr, ms, msg) => Promise.race([
    pr,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
  const tryOpen = () => withTimeout(
    p.open({ baudRate: 115200 }),
    5000,
    'Timeout abriendo puerto (¿en uso por otro programa?)',
  );
  try {
    await tryOpen();
  } catch (e) {
    if (/already open|InvalidStateError/i.test(e.message || '')) {
      try { await withTimeout(p.close(), 1500, 'timeout close'); } catch {}
      await new Promise(r => setTimeout(r, 300));
      await tryOpen();
    } else {
      throw e;
    }
  }
}

async function autoConnectPort(serialPort, opts = false) {
  if (port) return;
  const suppressFallback = !!(opts && typeof opts === 'object' && opts.suppressFallback);
  try {
    port = serialPort;
    await _safeOpenPort(port);
    writer = port.writable.getWriter();
    const info = port.getInfo();
    const pn = document.getElementById('port-name');
    if (pn) pn.textContent = info.usbProductId
      ? `USB 0x${info.usbProductId.toString(16).toUpperCase()}` : 'USB Serial';
    const st = document.getElementById('serial-txt');
    if (st) st.textContent = 'Conectado @ 115200 baud';
    setConnStatus(true);
    hideAutoConnectBanner();
    slog('Puerto abierto @ 115200 baud — esperando READY…');
    startReader();
    if (!suppressFallback) _readyFallback();
  } catch(e) {
    port = null;
    log('Error al conectar: ' + e.message, 'err');
    slog('Error: ' + e.message, 's-er');
  }
}

/** Construye comando de POSICIÓN suavizada: "B:90.0,H:90.0,C:90.0,W:-90.0,G:15.0" */
function buildCmd() {
  return [
    `B:${clampJointDeg('base', J.base.angPos).toFixed(2)}`,
    `H:${clampJointDeg('sho',  J.sho.angPos ).toFixed(2)}`,
    `C:${clampJointDeg('elb',  J.elb.angPos ).toFixed(2)}`,
    `W:${clampJointDeg('wri',  J.wri.angPos ).toFixed(2)}`,
    `G:${clampJointDeg('grip', J.grip.angPos).toFixed(2)}`,
  ].join(',');
}


/* ── Telemetría ──────────────────────────────────────────────── */
let _prevJ = {};

function updateTelemetry() {
  ['base','sho','elb','wri','grip'].forEach(k => {
    const j   = J[k];
    const ang = j.angPos;
    const lbl = `${ang.toFixed(0)}° → ${j.target.toFixed(0)}°`;
    const pw  = angleToPwm(k, ang);
    const pct = (clamp(ang, -j.angLim, j.angLim) + j.angLim) / (2 * j.angLim) * 100;
    const aEl = document.getElementById('stg-'+k+'-ang');
    const pEl = document.getElementById('stg-'+k+'-pwm');
    const bEl = document.getElementById('stg-'+k+'-bar');
    if (aEl) aEl.textContent = lbl;
    if (pEl) pEl.textContent = pw;
    if (bEl) bEl.style.width = clamp(pct,0,100) + '%';
  });
  const pktEl = document.getElementById('ard-pkt-cnt');
  if (pktEl) pktEl.textContent = pktCount.toLocaleString();
}

(function telemLoop(){
  const changed = JDEFS.some(d =>
    Math.abs(J[d.key].angPos - (_prevJ[d.key+'_a']||0)) > 0.5 ||
    Math.abs(J[d.key].target - (_prevJ[d.key+'_t']||0)) > 0.5);
  if (changed) {
    updateTelemetry();
    JDEFS.forEach(d => { _prevJ[d.key+'_a']=J[d.key].angPos; _prevJ[d.key+'_t']=J[d.key].target; });
  }
  requestAnimationFrame(telemLoop);
})();
updateTelemetry();


/* ── Consola serial ──────────────────────────────────────────── */
const _slogBuf        = [];
let   _slogFlushPend  = false;
let   _slogLastKey    = '';
let   _slogLastCount  = 0;
let   _slogLastDiv    = null;
let   _slogLastBase   = '';
const SLOG_MAX        = 300;

function slog(msg, cls='s-sy') {
  const key = cls + '|' + msg;
  if (key === _slogLastKey && _slogLastDiv) {
    _slogLastCount++;
    _slogLastDiv.textContent = _slogLastBase + ' (×' + _slogLastCount + ')';
    return;
  }
  _slogLastKey   = key;
  _slogLastCount = 1;
  _slogBuf.push({ msg, cls, t: Date.now() });
  if (!_slogFlushPend) {
    _slogFlushPend = true;
    requestAnimationFrame(_flushSlog);
  }
}

function _fmtTime(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2,'0') + ':' +
         String(d.getMinutes()).padStart(2,'0') + ':' +
         String(d.getSeconds()).padStart(2,'0');
}

function _flushSlog() {
  _slogFlushPend = false;
  const el = document.getElementById('slog');
  if (!el || !_slogBuf.length) return;
  const frag = document.createDocumentFragment();
  let last = null, lastBase = '';
  for (let i = 0; i < _slogBuf.length; i++) {
    const { msg, cls, t } = _slogBuf[i];
    const div = document.createElement('div');
    div.className = cls;
    const base = '[' + _fmtTime(t) + '] ' + msg;
    div.textContent = base;
    frag.appendChild(div);
    last = div; lastBase = base;
  }
  _slogBuf.length = 0;
  el.appendChild(frag);
  _slogLastDiv  = last;
  _slogLastBase = lastBase;
  const over = el.children.length - SLOG_MAX;
  if (over > 0) {
    for (let i = 0; i < over; i++) el.removeChild(el.firstChild);
    if (!el.contains(_slogLastDiv)) { _slogLastDiv = null; _slogLastKey = ''; }
  }
  el.scrollTop = el.scrollHeight;
}


/* ── Envío ───────────────────────────────────────────────────── */
async function sendRaw(cmd) {
  if (!writer) return;
  try {
    lastTxMs = performance.now();
    await writer.write(new TextEncoder().encode(cmd + '\n'));
    slog('→ ' + cmd, 's-tx');
    pktCount++;
    updateTelemetry();
  } catch(e) {
    slog('TX error: ' + e.message, 's-er');
    disconnectSerial();
  }
}

let _lastSentCmd = null;
let _lastSendMs  = 0;

function syncLastCmd() { _lastSentCmd = buildCmd(); _lastSendMs = performance.now(); }

function _sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitSerialLine(match, timeoutMs = 700) {
  const test = typeof match === 'function'
    ? match
    : line => String(line || '').includes(String(match));
  return new Promise((resolve, reject) => {
    let waiter = null;
    const timer = setTimeout(() => {
      const idx = _rxWaiters.indexOf(waiter);
      if (idx >= 0) _rxWaiters.splice(idx, 1);
      reject(new Error('Timeout esperando respuesta serial'));
    }, timeoutMs);
    waiter = {
      test,
      done: line => {
        clearTimeout(timer);
        resolve(line);
      },
    };
    _rxWaiters.push(waiter);
  });
}

function _dispatchSerialWaiters(line) {
  for (let i = _rxWaiters.length - 1; i >= 0; i--) {
    const waiter = _rxWaiters[i];
    let ok = false;
    try { ok = waiter.test(line); } catch {}
    if (!ok) continue;
    _rxWaiters.splice(i, 1);
    try { waiter.done(line); } catch {}
  }
}

async function ensureSafeIdle(source = 'serial') {
  if (!writer) return;
  if (_idleSyncInFlight) return _idleSyncInFlight;

  _idleSyncInFlight = (async () => {
    clearInterval(serialT); serialT = null;
    stopNeuRefresh();

    // Empuja varios envíos de calibración para vencer ruido inicial.
    for (let i = 0; i < 2; i++) {
      try {
        await sendNeutrals();
        await waitSerialLine(line => line.startsWith('OK Z'), 350);
      } catch {}

      try {
        await sendCalibLimits();
        await waitSerialLine(line => line.startsWith('OK LIM'), 350);
      } catch {}

      await _sleepMs(120);
    }

    const poseCmd = buildCmd();
    try { await sendRaw(poseCmd); } catch {}
    _lastSentCmd = poseCmd;
    _lastSendMs = performance.now();
    startNeuRefresh();
    serialT = setInterval(sendPos, Math.round(1000 / serialHz));
    log(`Sincronización aplicada sin volver a HOME (${source})`, 'info');
  })().finally(() => {
    _idleSyncInFlight = null;
  });

  return _idleSyncInFlight;
}

const MIN_TX_MS = 25;

// PARO DE EMERGENCIA — flag global del lado de la página.
// Mientras esté activo, sendPos() NO transmite ningún comando de
// movimiento al firmware, sin importar lo que pidan los sliders, la
// visión, los presets o el teclado. El firmware además recibió STOP
// y descarta cualquier comando de movimiento que se le envíe.
window.__emergencyStop = false;

function sendPos() {
  if (window.__emergencyStop) return;        // bloqueo total mientras hay STOP
  const now = performance.now();
  if (now - _lastSendMs < MIN_TX_MS) return;

  const cmd = buildCmd();
  if (cmd === _lastSentCmd) return;

  _lastSentCmd = cmd;
  _lastSendMs  = now;
  sendRaw(cmd);
}


/* ── Estado visual ───────────────────────────────────────────── */
function setConnStatus(ok) {
  const ids = { dot:'ard-dot', lbl:'ard-ind-lbl', meta:'ard-meta',
                btn:'btn-conn', chip:'st-serial' };
  const dot  = document.getElementById(ids.dot);
  const lbl  = document.getElementById(ids.lbl);
  const meta = document.getElementById(ids.meta);
  const btn  = document.getElementById(ids.btn);
  const chip = document.getElementById(ids.chip);

  if (ok) {
    if (dot)  dot.classList.add('connected');
    if (lbl)  { lbl.textContent='CONECTADO'; lbl.classList.add('connected'); }
    if (meta) meta.style.display = 'grid';
    if (btn)  { btn.textContent='Desconectar'; btn.className='btn d ard-conn-btn'; }
    if (chip) chip.className = 'chip on';
    document.getElementById('ft-ser').textContent = 'Serial: ON';
    ['btn-home-ser','btn-ping','btn-emergency'].forEach(id => {
      const e = document.getElementById(id);
      if (e) { e.disabled=false; e.style.opacity='1'; }
    });
  } else {
    if (dot)  dot.classList.remove('connected');
    if (lbl)  { lbl.textContent='DESCONECTADO'; lbl.classList.remove('connected'); }
    if (meta) meta.style.display = 'none';
    if (btn)  { btn.textContent='⚡ Conectar'; btn.className='btn p ard-conn-btn'; }
    if (chip) chip.className = 'chip';
    document.getElementById('ft-ser').textContent = 'Serial: —';
    ['serial-txt','port-name','ard-latency'].forEach(id => {
      const e = document.getElementById(id); if (e) e.textContent = '—';
    });
    const pc = document.getElementById('ard-pkt-cnt'); if (pc) pc.textContent = '0';
    ['btn-home-ser','btn-ping','btn-emergency'].forEach(id => {
      const e = document.getElementById(id);
      if (e) { e.disabled=true; e.style.opacity='.4'; }
    });
    pktCount = 0;
  }
}


/* ── Reader asíncrono ────────────────────────────────────────── */
async function startReader() {
  reader = port.readable.getReader();
  const dec = new TextDecoder(); let rxBuf = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      rxBuf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = rxBuf.indexOf('\n')) !== -1) {
        const line = rxBuf.substring(0,nl).trim();
        rxBuf = rxBuf.substring(nl+1);
        if (!line) continue;
        if (line === 'AT_POS') continue;
        _dispatchSerialWaiters(line);
        slog('← ' + line, 's-rx');
        if (line.startsWith('OK') && lastTxMs > 0) {
          const lat = Math.round(performance.now() - lastTxMs);
          const el = document.getElementById('ard-latency'); if (el) el.textContent = lat+' ms';
        }
        if (line === 'PONG') {
          clearTimeout(_pingTimer);
          if (!serialT) {
            clearInterval(serialT);
            log('Configuración verificada ✓ — sincronizando la plataforma…', 'info');
            await ensureSafeIdle('PONG');
            log('Todo listo: ya puedes operar el equipo o activar la cámara', 'ok');
          }
        }
        if (line.startsWith('READY')) {
          clearTimeout(_readyTimer);
          clearTimeout(_pingTimer);
          if (!line.includes('IPN-RoboArm')) {
            log('Se detectó una configuración diferente', 'err');
            slog('Configuración distinta detectada (' + line + ')', 's-er');
            if (_uploadAfterReady) {
              if (_serverAvail) { uploadFirmware(); }
              else { slog('Abre start-server.bat para habilitar la carga', 's-er'); }
            } else {
              slog('Usa "⬆ Cargar al equipo" si deseas reemplazar esta configuración', 's-er');
            }
            return;
          }
          log('Equipo conectado correctamente', 'ok');
          log('Sincronizando datos iniciales desde la plataforma…', 'info');
          await ensureSafeIdle('READY');
          log('Todo listo: ya puedes operar el equipo o activar la cámara', 'ok');
          if (_uploadAfterReady) { _uploadAfterReady = false; uploadFirmware(); }
        }
      }
    }
  } catch(e) { if (e.name!=='AbortError') slog('RX error: '+e.message,'s-er'); }
}


/* ── Conectar (con diálogo de selección de puerto) ──────────── */
async function connectSerial() {
  if (!('serial' in navigator)) {
      modal('Conexión USB no disponible',
        'Esta función requiere Chrome o Edge versión 89 o superior.\nLa página debe abrirse desde HTTPS o localhost.\nNo está disponible en Firefox ni Safari.');
    return;
  }
  try {
    if (port) { try { await disconnectSerial(); } catch {} }
    port = await navigator.serial.requestPort();
    await _safeOpenPort(port);
    writer = port.writable.getWriter();
    const info = port.getInfo();
    const pn = document.getElementById('port-name');
    if (pn) pn.textContent = info.usbProductId
      ? `USB 0x${info.usbProductId.toString(16).toUpperCase()}` : 'USB Serial';
    const st = document.getElementById('serial-txt');
    if (st) st.textContent = 'Conectado a 115200 baud';
    slog('Puerto abierto — esperando confirmación del equipo…');
    log('Conexión USB establecida', 'ok');
    setConnStatus(true);
    _readyFallback();
    startReader();
  } catch(e) {
    if (e.name !== 'NotFoundError') log('Error serial: ' + e.message, 'err');
    slog('Error: ' + e.message, 's-er');
  }
}


/* ── Desconectar ─────────────────────────────────────────────── */
function _withTimeout(pr, ms) {
  return Promise.race([
    pr,
    new Promise(resolve => setTimeout(resolve, ms)),
  ]);
}

async function disconnectSerial() {
  clearTimeout(_reconnectAfterUploadTimer); _reconnectAfterUploadTimer = null;
  clearInterval(serialT); serialT = null;
  clearTimeout(_readyTimer); _readyTimer = null;
  clearTimeout(_pingTimer);  _pingTimer  = null;
  _idleSyncInFlight = null;
  _rxWaiters.length = 0;
  stopNeuRefresh();
  if (reader) {
    try { await _withTimeout(reader.cancel(), 800); } catch(e){}
    try { reader.releaseLock(); } catch(e){}
    reader = null;
  }
  if (writer) {
    try { await _withTimeout(writer.close(), 800); } catch(e){}
    try { writer.releaseLock(); } catch(e){}
    writer = null;
  }
  if (port) {
    try { await _withTimeout(port.close(), 1200); } catch(e){}
    port = null;
    await new Promise(r => setTimeout(r, 150));
  }
  setConnStatus(false);
  slog('Desconectado'); log('Serial desconectado', 'info');
}


/* ──────────────────────────────────────────────────────────────
   PARO DE EMERGENCIA — comportamiento SEGURO
   ────────────────────────────────────────────────────────────────
   Filosofía:
   • NUNCA mover los servos a un "neutro" o a "0°" porque podría no
     estar bien calibrado. Los servos se quedan EXACTAMENTE donde
     estén en este instante.
   • NO se limita a parar la transmisión PWM dejando al Arduino con
     comandos viejos pendientes — al enviar STOP, el firmware ENTRA
     en estado "frozen" y descarta cualquier comando de movimiento.
   • La página también levanta un flag global (window.__emergencyStop)
     para que ningún módulo (manual, visión, presets, teclado) pueda
     emitir ningún movimiento hasta que el operador reanude.
   • Si el equipo no está conectado, el bloqueo aún se aplica al lado
     de la página para impedir movimientos al reconectar.
   ────────────────────────────────────────────────────────────── */
async function emergencyStop() {
  // 1) Bloqueo del lado de la página — fuerza que TODOS los módulos
  //    se queden quietos en su estimación angular actual.
  window.__emergencyStop = true;
  JDEFS.forEach(d => {
    setJointTarget(d.key, J[d.key].angPos);
    if (J[d.key]) J[d.key].target = J[d.key].angPos;
  });

  // 2) Bloqueo del lado del firmware — STOP fija las PWM actuales y
  //    rechaza cualquier comando de movimiento posterior.
  if (writer) {
    try {
      // Enviamos varias veces por si la primera se pierde por ruido.
      await sendRaw('STOP');
      await _sleepMs(40);
      await sendRaw('STOP');
    } catch {}
  }

  // 3) Detenemos el envío periódico para que la cola serial no esté
  //    ocupada con comandos que el firmware igual descartaría.
  clearInterval(serialT); serialT = null;

  // 4) Feedback visual
  document.body.classList.add('estop-active');
  const stopBtn = document.getElementById('btn-global-stop');
  if (stopBtn) stopBtn.classList.add('estop-armed');
  log('⛔ PARO DE EMERGENCIA — servos congelados en su posición actual', 'err');
  slog('STOP global enviado al firmware (frozen)', 's-er');
}

/** Reanuda la operación normal después de un PARO. NO mueve los servos. */
async function resumeOperation() {
  window.__emergencyStop = false;
  if (writer) {
    try {
      await sendRaw('RESUME');
    } catch {}
  }
  // Reanudar el envío periódico
  if (writer && !serialT) {
    serialT = setInterval(sendPos, Math.round(1000 / serialHz));
  }
  document.body.classList.remove('estop-active');
  const stopBtn = document.getElementById('btn-global-stop');
  if (stopBtn) stopBtn.classList.remove('estop-armed');
  log('Operación reanudada — los servos vuelven a aceptar comandos', 'ok');
}

/** HOME global — accesible desde cualquier pestaña. Reanuda primero
 *  si el sistema estaba en PARO, luego mueve cada servo a su HOME
 *  calibrado (NO a 0° fijo, sino al HOME que el usuario configuró). */
async function globalHome() {
  // Si estábamos en PARO, primero reanudamos el firmware.
  if (window.__emergencyStop) {
    await resumeOperation();
  }
  // Mover a la pose HOME del usuario (validada y persistida)
  if (typeof moveToHomePose === 'function') {
    moveToHomePose();
  } else {
    JDEFS.forEach(d => setJointTarget(d.key, getJointHome(d.key)));
  }
  // Forzar transmisión inmediata
  _lastSentCmd = null;
  if (writer) sendPos();
  log('⌂ HOME — moviendo a la posición base calibrada', 'ok');
}

// Exponer globalmente para que cualquier módulo o botón pueda llamarlas.
window.emergencyStop    = emergencyStop;
window.resumeOperation  = resumeOperation;
window.globalHome       = globalHome;


/* ── Presets ─────────────────────────────────────────────────── */
const PRESET_KEY = 'roboarm-presets-v11';
let presets = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}');

function savePreset(slot) {
  const name = document.getElementById('preset-name-' + slot);
  if (!name || !name.value.trim()) { log('Escribe un nombre para el preset','err'); return; }
  presets[slot] = {
    name: name.value.trim(),
    base: J.base.target, sho:  J.sho.target,
    elb:  J.elb.target,  wri:  J.wri.target,
    grip: J.grip.target,
  };
  localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  renderPresets(); log('Preset "'+presets[slot].name+'" guardado','ok');
}
function loadPreset(slot) {
  const p = presets[slot]; if (!p) { log('No hay preset en slot '+slot,'err'); return; }
  batchJoints({ base:p.base, sho:p.sho, elb:p.elb, wri:p.wri, grip:p.grip });
  log('Preset "'+p.name+'" cargado','ok');
}
function deletePreset(slot) {
  delete presets[slot];
  localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  renderPresets();
}
function renderPresets() {
  const wrap = document.getElementById('presets-wrap'); if (!wrap) return;
  wrap.innerHTML = [0,1,2,3].map(i => {
    const p = presets[i];
    return `<div class="preset-row">
      <input type="text" class="inp preset-name-inp" id="preset-name-${i}"
             placeholder="Slot ${i+1}" value="${p?p.name:''}" style="flex:1;font-size:8.5px">
      <button class="btn gh" onclick="savePreset(${i})" title="Guardar posición actual">💾</button>
      <button class="btn" onclick="loadPreset(${i})" title="Cargar preset" ${!p?'disabled style="opacity:.4"':''}>▶</button>
      <button class="btn" onclick="deletePreset(${i})" title="Borrar" ${!p?'disabled style="opacity:.4"':''} style="color:#903030">✕</button>
    </div>`;
  }).join('');
}
renderPresets();


/* ── Recorrido completo de servo dentro de límites calibrados ─── */
const activeSweeps = new Set();

async function waitJointNear(key, target) {
  while (activeSweeps.has(key) && !window.__emergencyStop) {
    if (Math.abs(J[key].angPos - target) <= 0.2) return true;
    await _sleepMs(80);
  }
  return false;
}

async function sweepServo(key) {
  if (!J[key] || window.__emergencyStop) return;
  if (activeSweeps.has(key)) {
    activeSweeps.delete(key);
    setJointTarget(key, J[key].angPos);
    log(`${key}: recorrido detenido`, 'info');
    return;
  }

  const mn = jointMin(key);
  const mx = jointMax(key);
  activeSweeps.add(key);
  log(`${key}: recorrido completo ${mn}° → ${mx}°`, 'info');

  try {
    setJointTarget(key, mn);
    if (!(await waitJointNear(key, mn))) return;
    setJointTarget(key, mx);
    await waitJointNear(key, mx);
  } finally {
    activeSweeps.delete(key);
  }
}


/* ══════════════════════════════════════════════
   SUBIDA DE FIRMWARE
   ══════════════════════════════════════════════ */
async function checkServer() {
  try {
    const r = await fetch('http://localhost:8080/status',
      { signal: AbortSignal.timeout(1500) });
    const d = await r.json();
    _serverAvail = d.ok === true;
  } catch { _serverAvail = false; }
  updateUploadUI();
}

function updateUploadUI() {
  const bannerBtn = document.getElementById('banner-btn-upload');
  if (bannerBtn) bannerBtn.style.display = '';
  const tabBtn = document.getElementById('btn-upload-fw');
  if (tabBtn) {
    tabBtn.disabled  = false;
    tabBtn.style.opacity = '1';
    tabBtn.title = _serverAvail
      ? 'Cargar la configuración al equipo con el servicio local disponible'
      : 'Haz clic para ver cómo habilitar la carga automática';
  }
  const dlBtn = document.getElementById('btn-dl-fw');
  if (dlBtn) dlBtn.style.display = '';
}

function showServerHelp() {
  modal('Activa la carga automática desde la plataforma',
    'Para cargar la configuración del controlador sin salir de esta plataforma,\n' +
    'necesitas iniciar el servicio local de apoyo.\n\n' +
    '1) Haz doble clic en start-server.bat dentro de la carpeta del proyecto.\n' +
    '2) Se abrirá una ventana de apoyo; déjala abierta.\n' +
    '3) Regresa aquí y pulsa "⬆ Cargar al equipo" nuevamente.\n\n' +
    'Requisitos iniciales:\n' +
    '• Node.js:       https://nodejs.org\n' +
    '• arduino-cli:  winget install ArduinoSA.CLI\n' +
    '                arduino-cli core install arduino:avr');
}

async function detectBoardInfo() {
  if (!_serverAvail) return null;
  try {
    const r = await fetch('http://localhost:8080/detect',
      { signal: AbortSignal.timeout(2500) });
    const d = await r.json();
    return d && (d.board || d.port || d.name) ? d : null;
  } catch {
    return null;
  }
}

function shouldUseServerUploader(boardInfo) {
  const fqbn = String(boardInfo?.board || '').toLowerCase();
  return !!fqbn && fqbn !== 'arduino:avr:uno';
}

async function uploadViaServer(inoSource, boardInfo = null, note = '') {
  if (note) {
    log(note, 'info');
    slog(note, 's-sy');
  }
  const fqbn = boardInfo?.board || undefined;
  const port = boardInfo?.port || undefined;
  const r = await fetch('http://localhost:8080/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ino: inoSource, fqbn, port }),
    signal: AbortSignal.timeout(90000),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || d.output || 'arduino-cli upload falló');
  return d;
}

function _serialPortIdentity(serialPort) {
  try { return serialPort?.getInfo?.() || null; } catch { return null; }
}

function _serialPortScore(serialPort, preferredInfo = null) {
  const info = _serialPortIdentity(serialPort);
  if (!info) return 0;
  let score = 0;
  if (preferredInfo?.usbVendorId && info.usbVendorId === preferredInfo.usbVendorId) score += 20;
  if (preferredInfo?.usbProductId && info.usbProductId === preferredInfo.usbProductId) score += 50;
  return score;
}

function _sortPortsForReconnect(ports, preferredPort = null) {
  const preferredInfo = _serialPortIdentity(preferredPort) || preferredPort || null;
  return [...ports].sort((a, b) => _serialPortScore(b, preferredInfo) - _serialPortScore(a, preferredInfo));
}

function _isReadyFirmwareLine(line) {
  const txt = String(line || '');
  return txt === 'PONG' || (txt.startsWith('READY') && txt.includes('IPN-RoboArm'));
}

async function waitForReadyFirmware(timeoutMs = 900) {
  if (serialT || _idleSyncInFlight) return 'ACTIVE';
  try {
    return await waitSerialLine(_isReadyFirmwareLine, timeoutMs);
  } catch {
    return null;
  }
}

async function probeCurrentFirmwareHandshake({
  initialWaitMs = 2200,
  pingAttempts = 4,
  perPingTimeoutMs = 900,
} = {}) {
  let hello = await waitForReadyFirmware(initialWaitMs);
  if (hello) return hello;

  for (let i = 0; i < pingAttempts; i++) {
    if (!port || !writer) break;
    try { await sendRaw('PING'); } catch {}
    hello = await waitForReadyFirmware(perPingTimeoutMs);
    if (hello) return hello;
    await _sleepMs(220);
  }
  return null;
}

function scheduleReconnectAfterUpload(preferredPort = null) {
  clearTimeout(_reconnectAfterUploadTimer);
  const reconnect = async (attempt = 0) => {
    if (attempt >= 5 || port || _uploadInFlight) return;
    try {
      const authorized = await navigator.serial.getPorts();
      const ports = _sortPortsForReconnect(authorized, preferredPort);
      for (const candidate of ports) {
        if (port || _uploadInFlight) return;
        await autoConnectPort(candidate, { suppressFallback: true });
        const hello = await probeCurrentFirmwareHandshake();
        if (hello) return;
        if (port && !serialT) await disconnectSerial();
        await _sleepMs(300);
      }
    } catch (e) {
      slog('Reintento conexión ' + (attempt + 1) + ': ' + e.message, 's-er');
    }
    _reconnectAfterUploadTimer = setTimeout(() => reconnect(attempt + 1), 1100 + attempt * 500);
  };
  _reconnectAfterUploadTimer = setTimeout(() => reconnect(0), 3200);
}

document.getElementById('btn-dl-fw').addEventListener('click', () => {
  const code = document.getElementById('fw').textContent;
  if (!code.trim()) { log('Primero genera el archivo de configuración', 'err'); return; }
  const blob = new Blob([code], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roboarm_fw.ino';
  a.click();
  URL.revokeObjectURL(a.href);
  log('Archivo descargado correctamente — ya puedes cargarlo desde Arduino IDE', 'ok');
});

async function uploadFirmware() {
  if (_uploadInFlight) {
    log('Ya hay una carga en proceso — espera a que finalice', 'info');
    return;
  }
  if (!_serverAvail) {
    await checkServer();
    if (!_serverAvail) {
      showServerHelp();
      log('Inicia start-server.bat y vuelve a intentar la carga', 'err');
      return;
    }
  }

  _uploadInFlight = true;
  _ignoreHotplugDuringUpload = true;
  _uploadAfterReady = false;
  clearTimeout(_readyTimer); _readyTimer = null;
  clearTimeout(_pingTimer);  _pingTimer  = null;
  hideAutoConnectBanner();

  const inoSource = generateFirmware();
  const boardInfo = await detectBoardInfo();
  const useServerDirect = shouldUseServerUploader(boardInfo);

  let flashPort = port;
  if (!useServerDirect && !flashPort) {
    const ports = await navigator.serial.getPorts();
    if (ports.length === 0) {
      _uploadInFlight = false;
      _ignoreHotplugDuringUpload = false;
      log('Aún no hay un equipo autorizado — pulsa ⚡ Conectar primero', 'err');
      return;
    }
    flashPort = ports[0];
  }

  try {
    await disconnectSerial();
    await new Promise(r => setTimeout(r, 350));

    if (useServerDirect) {
      const boardLbl = boardInfo?.name || boardInfo?.board || 'placa detectada';
      log(`Equipo detectado: ${boardLbl} — usando carga asistida`, 'info');
      slog(`Equipo detectado: ${boardLbl} — iniciando carga asistida`, 's-sy');
      await uploadViaServer(inoSource, boardInfo);
    } else {
      log('Preparando archivo de control…', 'info');
      slog('Preparando archivo con arduino-cli…', 's-sy');
      let hex;
      try {
        const r = await fetch('http://localhost:8080/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ino: inoSource, fqbn: boardInfo?.board || 'arduino:avr:uno' }),
          signal: AbortSignal.timeout(60000),
        });
        const d = await r.json();
        if (!d.ok) {
          log('No fue posible preparar el archivo: ' + (d.error || 'revisa la consola del servidor'), 'err');
          slog('Preparación fallida: ' + (d.error || d.output || '').slice(0, 200), 's-er');
          return;
        }
        hex = d.hex;
        log('Archivo listo — cargando en el equipo…', 'ok');
        slog('✓ Compilado — subiendo por USB (STK500)…', 's-sy');
      } catch(e) {
        log('Sin respuesta del servidor: ' + e.message, 'err');
        slog('No se pudo preparar el archivo — reintenta después de iniciar start-server.bat', 's-er');
        return;
      }

      try {
        await flashArduino(flashPort, hex, pct => {
          const pEl = document.getElementById('upload-progress');
          if (pEl) pEl.textContent = Math.round(pct * 100) + '%';
          if (pct < 1) slog('⬆ Subiendo… ' + Math.round(pct * 100) + '%', 's-sy');
        });
      } catch (stkErr) {
        slog('La carga inicial falló — reintentando con arduino-cli…', 's-sy');
        log('La carga inicial falló — reintentando con arduino-cli…', 'info');
        await uploadViaServer(inoSource, boardInfo);
      }
    }

    log('Configuración cargada correctamente ✓ — reconectando…', 'ok');
    slog('Configuración aplicada — el equipo se está reiniciando', 's-ok');
    scheduleReconnectAfterUpload(flashPort);
  } catch(e) {
    log('Error al cargar la configuración: ' + e.message, 'err');
    slog('Error durante la carga: ' + e.message, 's-er');
  } finally {
    const pEl = document.getElementById('upload-progress');
    if (pEl) pEl.textContent = '';
    _uploadInFlight = false;
    setTimeout(() => { _ignoreHotplugDuringUpload = false; }, 1200);
  }
}


/* ══════════════════════════════════════════════
   LISTENERS
   ══════════════════════════════════════════════ */

document.getElementById('btn-conn').addEventListener('click', () => {
  if (port) { disconnectSerial(); return; }
  _uploadAfterReady = false;
  connectSerial();
});

document.getElementById('btn-home-ser').addEventListener('click', () => globalHome());

document.getElementById('btn-ping').addEventListener('click', () => sendRaw('PING'));
document.getElementById('btn-emergency').addEventListener('click', emergencyStop);

document.getElementById('btn-send-raw').addEventListener('click', () => {
  const v=document.getElementById('inp-cmd').value.trim(); if(v) sendRaw(v);
});

document.getElementById('inp-cmd').addEventListener('keydown', e => {
  if(e.key==='Enter') { const v=e.target.value.trim(); if(v) sendRaw(v); }
});

document.getElementById('btn-clr').addEventListener('click', () => {
  document.getElementById('slog').innerHTML='';
  _slogLastDiv = null; _slogLastKey = ''; _slogLastCount = 0;
});

document.getElementById('btn-copy-fw').addEventListener('click', () =>
  navigator.clipboard.writeText(document.getElementById('fw').textContent || generateFirmware())
    .then(() => log('Firmware copiado al portapapeles ✓','ok'))
    .catch(() => log('Error al copiar firmware','err'))
);

// Frecuencia de transmisión
const _hzSl = document.getElementById('sl-hz');
if (_hzSl) _hzSl.addEventListener('input', function() {
  serialHz = parseInt(this.value);
  document.getElementById('lv-hz').textContent = serialHz + ' Hz';
  if (serialT) { clearInterval(serialT); serialT=setInterval(sendPos, Math.round(1000/serialHz)); }
});

// Velocidad de comando: rampa angular antes de enviar al firmware.
const _servoSpeedSl = document.getElementById('sl-servo-speed');
const _servoSpeedLbl = document.getElementById('lv-servo-speed');
if (_servoSpeedSl && typeof getServoCommandSpeed === 'function' && typeof setServoCommandSpeed === 'function') {
  const fmtSpeed = v => {
    const n = Number(v);
    return (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1)) + '°/s';
  };
  const current = getServoCommandSpeed();
  _servoSpeedSl.value = String(current);
  if (_servoSpeedLbl) _servoSpeedLbl.textContent = fmtSpeed(current);
  _servoSpeedSl.addEventListener('input', function() {
    const v = setServoCommandSpeed(parseFloat(this.value));
    this.value = String(v);
    if (_servoSpeedLbl) _servoSpeedLbl.textContent = fmtSpeed(v);
  });
}

// Auto-inicio
const _autoChk = document.getElementById('chk-autostart');
if (_autoChk) _autoChk.addEventListener('change', function() {
  log('Auto-inicio: '+(this.checked?'activado':'desactivado'),'info');
});

// Sliders espejo del panel Arduino
['base','sho','elb','wri','grip'].forEach(k => {
  const sl = document.getElementById('ard-sl-'+k);
  if (sl) sl.addEventListener('input', function() {
    setJointTarget(k, parseFloat(this.value));
  });
});

// Botones sweep
['base','sho','elb','wri','grip'].forEach(k => {
  const btn = document.getElementById('ard-sweep-'+k);
  if (btn) btn.addEventListener('click', () => sweepServo(k));
});

// Cambio en cualquier select de canal → validar en tiempo real
document.querySelectorAll('.chan-sel').forEach(sel => {
  sel.addEventListener('change', () => {
    readChannelsFromUI();
    const err = validateChannels();
    ['base','sho','elb','wri','grip'].forEach(k => {
      const row = document.getElementById('chanrow-'+k);
      if (row) row.classList.remove('chan-conflict');
    });
    if (err) {
      const used = {};
      ['base','sho','elb','wri','grip'].forEach(k => {
        const ch = chanMap[k];
        if (used[ch] !== undefined) {
          const rowA = document.getElementById('chanrow-'+used[ch]);
          const rowB = document.getElementById('chanrow-'+k);
          if (rowA) rowA.classList.add('chan-conflict');
          if (rowB) rowB.classList.add('chan-conflict');
        } else {
          used[ch] = k;
        }
      });
    }
    refreshChannelStatus();
  });
});

document.getElementById('btn-chan-save').addEventListener('click', saveChannels);
document.getElementById('btn-chan-reset').addEventListener('click', resetChannels);

/* ── Botones GLOBALES de emergencia y HOME ─────────────────────
   Son visibles en TODO momento (pestañas, móvil, sin importar el
   tab activo). El STOP funciona aunque no haya equipo conectado:
   bloquea cualquier intento de movimiento desde la página. */
const _btnGlobalStop = document.getElementById('btn-global-stop');
const _btnGlobalHome = document.getElementById('btn-global-home');
if (_btnGlobalStop) {
  _btnGlobalStop.addEventListener('click', async () => {
    // Si ya estamos en PARO, este botón actúa como "Reanudar".
    if (window.__emergencyStop) {
      await resumeOperation();
      return;
    }
    await emergencyStop();
  });
}
if (_btnGlobalHome) {
  _btnGlobalHome.addEventListener('click', () => globalHome());
}

/* Atajo de teclado: tecla ESPACIO también dispara PARO global.
   Bypass de cualquier widget para máxima accesibilidad. */
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  // Permitir uso normal de espacio dentro de campos de texto.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  if (window.__emergencyStop) resumeOperation();
  else emergencyStop();
}, true);


/* ══════════════════════════════════════════════
   INICIALIZACIÓN
   ══════════════════════════════════════════════ */
applyChannelsToUI();
refreshChannelStatus();
updateTelemetry();
updateTelemChannels();

// Botones del banner de auto-conexión
document.getElementById('banner-btn-connect').addEventListener('click', () => {
  _uploadAfterReady = false;
  if (_pendingPort) autoConnectPort(_pendingPort);
  else connectSerial();
  hideAutoConnectBanner();
});
document.getElementById('banner-btn-ignore').addEventListener('click', hideAutoConnectBanner);
document.getElementById('banner-btn-upload').addEventListener('click', () => {
  _uploadAfterReady = true;
  if (_pendingPort) autoConnectPort(_pendingPort);
  else connectSerial();
  hideAutoConnectBanner();
});

const _uploadBtn = document.getElementById('btn-upload-fw');
if (_uploadBtn) _uploadBtn.addEventListener('click', uploadFirmware);

if ('serial' in navigator) {
  navigator.serial.getPorts().then(ports => {
    if (ports.length > 0 && !port) {
      setTimeout(() => { if (!port) showAutoConnectBanner(ports[0]); }, 400);
    }
  }).catch(() => {});

  navigator.serial.addEventListener('connect', e => {
    if (_ignoreHotplugDuringUpload) return;
    if (!port) showAutoConnectBanner(e.target);
  });

  navigator.serial.addEventListener('disconnect', e => {
    if (_ignoreHotplugDuringUpload) return;
    if (port && e.target === port) {
      disconnectSerial();
      log('Equipo desconectado', 'err');
    }
  });
}

const _baudSel = document.getElementById('sel-baud');
if (_baudSel) _baudSel.value = '115200';

checkServer();
setInterval(checkServer, 10000);

slog('Plataforma de control lista — modo POSICIÓN MG995');
const chanSummary = ['base','sho','elb','wri','grip']
  .map(k => `CH${chanMap[k]}=${SERVO_META[k].label}`).join('  ');
slog(chanSummary, 's-sy');
slog('Haz clic en ⚡ Conectar para seleccionar el equipo por USB');
