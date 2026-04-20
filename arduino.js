/* ══════════════════════════════════ ══════════════
   arduino.js — Control Serial RoboArm IPN v4.0
   ────────────────────────────────────────────────────────────────
   CANALES PCA9685 — Configurables por el usuario desde la UI.
   Los valores por defecto son los del hardware físico, pero
   cualquier asignación canal↔servo puede cambiarse sin tocar código.

   El firmware se regenera automáticamente con cada cambio.

   PROTOCOLO:
     TX → Arduino: "B:90,H:90,C:20,W:90,G:0\n"
     RX ← Arduino: "OK B:90 H:90 C:20 W:90 G:0\n" | "PONG" | "READY"

   Dependencias: shared.js (J, JDEFS, clamp, lerp, batchJoints, log, modal)
   ════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   MAPA DE CANALES — corazón del sistema configurable
   ──────────────────────────────────────────────────────────────
   chanMap[servo] = número de canal PCA9685 (0–15)
   Se guarda en localStorage para persistir entre sesiones.
   ══════════════════════════════════════════════ */
const CHAN_DEFAULTS = { base:4, sho:3, elb:2, wri:1, grip:0 };
const CHAN_KEY      = 'roboarm-channels-v4';

// Cargar configuración guardada o usar defaults
let chanMap = { ...CHAN_DEFAULTS };
try {
  const saved = localStorage.getItem(CHAN_KEY);
  if (saved) {
    const parsed = JSON.parse(saved);
    // Validar que todas las claves existen y son números 0-15
    const valid = ['base','sho','elb','wri','grip'].every(k =>
      typeof parsed[k] === 'number' && parsed[k] >= 0 && parsed[k] <= 15
    );
    if (valid) chanMap = parsed;
  }
} catch(e) { /* usar defaults */ }

/* ── Meta-info de cada servo (para firmware y telemetría) ───── */
const SERVO_META = {
  base: { label:'Base',   varName:'CH_BASE',     min:0, max:90,  offset:+90, centered:true,  range:'0°–90°'   },
  sho:  { label:'Hombro', varName:'CH_SHOULDER', min:0,  max:90,  offset:0,   centered:false, range:'0°–90°'   },
  elb:  { label:'Codo',   varName:'CH_ELBOW',    min:0, max:80,  offset:0,   centered:false, range:'0°–80°'   },
  wri:  { label:'Muñeca', varName:'CH_WRIST',    min:0, max:190, offset:+90, centered:true,  range:'0°–190°'  },
  grip: { label:'Pinza',  varName:'CH_GRIPPER',  min:0, max:20,  offset:0,   centered:false, range:'0°–20°'   },
};

/* ══════════════════════════════════════════════
   TRIM NEUTRAL POR SERVO — corrige deriva cuando "parado"
   ──────────────────────────────────────────────────────────────
   Cada servo continuo tiene un PWM "neutro" ligeramente distinto
   (1500 µs ±50 µs). Si usamos el mismo valor para todos, algunos
   giran lentamente aunque el usuario los crea parados. El usuario
   calibra el trim y se guarda en localStorage.
   ══════════════════════════════════════════════ */
// v2: valores medidos por el usuario en su hardware real.
// base 312, hombro 314, codo 325, muñeca 332 (ajustar si deriva), pinza 312
const NEUTRAL_KEY     = 'roboarm-neutrals-v3';
const NEUTRAL_DEFAULT = 322;   // centro de la zona muerta medida (~321–325)
let neutrals = { base:312, sho:314, elb:325, wri:332, grip:313 };
try {
  localStorage.removeItem('roboarm-neutrals-v1');
  localStorage.removeItem('roboarm-neutrals-v2');  // limpiar versiones viejas
  const saved = JSON.parse(localStorage.getItem(NEUTRAL_KEY) || 'null');
  if (saved) ['base','sho','elb','wri','grip'].forEach(k => {
    const n = parseInt(saved[k]);
    if (n >= 260 && n <= 360) neutrals[k] = n;
  });
} catch(e) { /* defaults */ }

function saveNeutrals() {
  try { localStorage.setItem(NEUTRAL_KEY, JSON.stringify(neutrals)); } catch(e) {}
}

/** Envía al Arduino el comando NEU:b,h,c,w,g con los trims actuales. */
function sendNeutrals() {
  if (!writer) return;
  const cmd = `NEU:${neutrals.base},${neutrals.sho},${neutrals.elb},${neutrals.wri},${neutrals.grip}`;
  sendRaw(cmd);
}

/* ══════════════════════════════════════════════
   GENERADOR DE FIRMWARE — produce el .ino con los canales
   correctos según chanMap actual. Se llama cada vez que
   el usuario cambia un canal.
   ══════════════════════════════════════════════ */
function generateFirmware() {
  // Comentario de asignación legible
  const chanComment = ['base','sho','elb','wri','grip']
    .map(k => `//    CH${chanMap[k]} = ${SERVO_META[k].label.padEnd(7)} (${SERVO_META[k].range})`)
    .join('\n');

  // Define lines
  const defineLines = ['base','sho','elb','wri','grip']
    .map(k => `#define ${SERVO_META[k].varName.padEnd(13)} ${chanMap[k]}`)
    .join('\n');

  return `// ═══════════════════════════════════════════
//  RoboArm IPN — Firmware v4.0
//  Hardware: Arduino Uno/Mega + PCA9685 + 5× MG995
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
//  Protocolo RX: "B:90,H:90,C:20,W:90,G:0\\n"
//  Protocolo TX: "OK B:90 H:90 C:20 W:90 G:0\\n"
// ═══════════════════════════════════════════

#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

// Dirección I2C del PCA9685 (0x40 por defecto, sin jumpers soldados)
Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

// Parámetros PWM para MG995 @ 50 Hz
#define SERVO_FREQ  50      // Hz
#define PULSE_MIN   130     // ~635 µs → velocidad máxima un sentido
#define PULSE_MAX   490     // ~2393 µs → velocidad máxima otro sentido

// ── Asignación de canales PCA9685 ────────────────────────────
${defineLines}

// ── Un servo de velocidad/continuo: temporizador + dirección ──
struct Srv { float t = 0.0f; int d = 0; };
// t = segundos restantes, d = +1 adelante / -1 atrás / 0 parado
Srv sv[5];  // [0]=BASE [1]=HOMBRO [2]=CODO [3]=MUÑECA [4]=PINZA

// Índices de canal (mismo orden que sv[])
const uint8_t CH_IDX[5] = { CH_BASE, CH_SHOULDER, CH_ELBOW, CH_WRIST, CH_GRIPPER };

String buf = "";
unsigned long _lastTick = 0;

// ── Trim neutral por servo (PWM exacto para que el servo no derive)
// Editable en caliente con "NEU:b,h,c,w,g"
uint16_t neu[5] = { ${neutrals.base}, ${neutrals.sho}, ${neutrals.elb}, ${neutrals.wri}, ${neutrals.grip} };

// ── PWM según dirección: neutral exacto por servo = parado ────
uint16_t dirPWM(uint8_t i, int d) {
  return d > 0 ? PULSE_MAX : d < 0 ? PULSE_MIN : neu[i];
}

// ── Aplica estado actual a todos los canales ──────────────────
// Cuando d=0: envía el pulso neutro calibrado (≈1500 µs ajustable).
// Es crítico que cada servo tenga su neu[] bien ajustado — si no,
// el servo continuo derivará lentamente.
void applyServos() {
  for (uint8_t i = 0; i < 5; i++)
    pwm.setPWM(CH_IDX[i], 0, dirPWM(i, sv[i].d));
}

// ── Programa un servo: secs>0=adelante, secs<0=atrás, 0=parar ─
void setServo(uint8_t i, float secs) {
  if (fabsf(secs) < 0.01f) { sv[i].t = 0; sv[i].d = 0; }
  else { sv[i].t = fabsf(secs); sv[i].d = secs > 0 ? 1 : -1; }
}

// ── Parser de comandos seriales ───────────────────────────────
// Formato: "B:2.5,H:-1.0,C:0"  B/H/C/W/G: segundos (+ = adelante, - = atrás, 0 = parar)
// Especiales: PING, HOME (parar todo)
void parseCmd(String cmd) {
  cmd.trim();
  if (!cmd.length()) return;

  if (cmd == "PING") { Serial.println("PONG"); return; }

  if (cmd == "HOME") {
    for (uint8_t i = 0; i < 5; i++) { sv[i].t = 0; sv[i].d = 0; }
    applyServos();
    Serial.println("OK HOME");
    return;
  }

  // "NEU:b,h,c,w,g" → actualiza trims neutrales en caliente (sin re-flashear)
  if (cmd.startsWith("NEU:")) {
    String body = cmd.substring(4);
    int idx = 0, s2 = 0;
    while (s2 < (int)body.length() && idx < 5) {
      int cm = body.indexOf(',', s2); if (cm < 0) cm = body.length();
      long v = body.substring(s2, cm).toInt();
      if (v >= 260 && v <= 360) neu[idx] = (uint16_t)v;
      s2 = cm + 1; idx++;
    }
    applyServos();
    Serial.print("OK NEU");
    for (uint8_t i = 0; i < 5; i++) { Serial.print(' '); Serial.print(neu[i]); }
    Serial.println();
    return;
  }

  int s = 0;
  while (s < (int)cmd.length()) {
    int cm = cmd.indexOf(',', s); if (cm < 0) cm = cmd.length();
    String tok = cmd.substring(s, cm);
    int col = tok.indexOf(':');
    if (col > 0) {
      float v = constrain(tok.substring(col + 1).toFloat(), -10.0f, 10.0f);
      switch (tok.charAt(0)) {
        case 'B': setServo(0, v); break;
        case 'H': setServo(1, v); break;
        case 'C': setServo(2, v); break;
        case 'W': setServo(3, v); break;
        case 'G': setServo(4, v); break;
      }
    }
    s = cm + 1;
  }
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Wire.begin();
  pwm.begin();
  pwm.setOscillatorFrequency(27000000);
  pwm.setPWMFreq(SERVO_FREQ);
  delay(10);
  applyServos();  // todos en neutral al arrancar
  _lastTick = millis();
  Serial.println("READY IPN-RoboArm v4.0");
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\\n') { parseCmd(buf); buf = ""; }
    else if (buf.length() < 64) buf += c;
  }

  unsigned long now = millis();
  if (now - _lastTick >= 10) {
    float dt = constrain((now - _lastTick) / 1000.0f, 0.0f, 0.05f);
    _lastTick = now;

    bool any = false;
    for (uint8_t i = 0; i < 5; i++) {
      if (sv[i].t > 0) {
        sv[i].t -= dt;
        if (sv[i].t <= 0) { sv[i].t = 0; sv[i].d = 0; }
        else any = true;
      }
    }
    applyServos();
    if (!any) Serial.println("AT_POS");
  }
}`;
}

/* ══════════════════════════════════ GESTIÓN DEL MAPA DE CANALES ══════════════════════════════════ */

/** Valida que no haya canales duplicados. Devuelve null si OK,
    o un mensaje de error si hay conflicto. */
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

/** Lee los selects del DOM y actualiza chanMap */
function readChannelsFromUI() {
  ['base','sho','elb','wri','grip'].forEach(k => {
    const el = document.getElementById('chan-' + k);
    if (el) chanMap[k] = parseInt(el.value);
  });
}

/** Aplica chanMap a los selects del DOM */
function applyChannelsToUI() {
  ['base','sho','elb','wri','grip'].forEach(k => {
    const el = document.getElementById('chan-' + k);
    if (el) el.value = String(chanMap[k]);
  });
}

/** Actualiza el status de validación y el firmware */
function refreshChannelStatus() {
  const err    = validateChannels();
  const okEl   = document.getElementById('chan-ok');
  const fwEl   = document.getElementById('fw');

  if (okEl) {
    if (err) {
      okEl.textContent    = err;
      okEl.style.color    = 'var(--err)';
    } else {
      okEl.textContent    = '✓ Configuración válida — firmware actualizado';
      okEl.style.color    = 'var(--ok)';
    }
  }

  // Regenerar firmware con los canales actuales
  if (fwEl) fwEl.textContent = generateFirmware();

  // Actualizar números de canal en la tabla de telemetría
  updateTelemChannels();

  // Actualizar el log inicial
  refreshChanLog();
}

/** Actualiza las celdas de canal en la tabla de telemetría */
function updateTelemChannels() {
  ['base','sho','elb','wri','grip'].forEach(k => {
    const el = document.getElementById('stg-' + k + '-ch');
    if (el) el.textContent = chanMap[k];
  });
}

/** Refresca el mensaje de canales en la consola serial */
function refreshChanLog() {
  const parts = ['base','sho','elb','wri','grip']
    .map(k => `CH${chanMap[k]}=${SERVO_META[k].label}`)
    .join('  ');
  // Solo actualizar el último mensaje de canales (no duplicar)
  const slogEl = document.getElementById('slog');
  if (slogEl) {
    // Buscar si ya hay una línea de canales y actualizarla
    const existing = slogEl.querySelector('.chan-log-line');
    if (existing) {
      existing.textContent = '[canales] ' + parts;
    }
  }
}

/** Guarda chanMap en localStorage y refresca todo */
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

/** Restablece chanMap a los valores por defecto */
function resetChannels() {
  chanMap = { ...CHAN_DEFAULTS };
  applyChannelsToUI();
  refreshChannelStatus();
  log('Canales restablecidos a valores por defecto', 'info');
}

/* ══════════════════════════════════ COMUNICACIÓN SERIAL ══════════════════════════════════ */
let port=null, writer=null, reader=null;
let serialHz=20, serialT=null;
let pktCount=0, lastTxMs=0;
let _pendingPort=null;
let _readyTimer=null;        // fallback si Arduino no envía READY
let _pingTimer=null;         // timeout de espera de PONG
let _uploadAfterReady=false; // flag: subir firmware al recibir READY
let _serverAvail=false;      // servidor arduino-cli disponible

/* ── Banner de auto-conexión ────────────────────────────────────────────── */
function showAutoConnectBanner(serialPort) {
  _pendingPort = serialPort;
  const b = document.getElementById('auto-connect-banner');
  if (b) b.classList.add('visible');
}

function hideAutoConnectBanner() {
  const b = document.getElementById('auto-connect-banner');
  if (b) b.classList.remove('visible');
  _pendingPort = null;
}

/* ── Fallback: si no llega READY en 3 s, envía PING para verificar firmware ── */
function _readyFallback() {
  clearTimeout(_readyTimer);
  clearTimeout(_pingTimer);
  _readyTimer = setTimeout(() => {
    if (!port) return;
    log('Sin READY — verificando firmware con PING…', 'info');
    sendRaw('PING');
    // Si no llega PONG en 3 s más → el firmware no es el correcto
    _pingTimer = setTimeout(() => {
      if (port && !serialT) {
        if (_serverAvail) {
          log('⚠ Arduino sin firmware IPN — subiéndolo automáticamente…', 'info');
          slog('⚠ Sin respuesta al protocolo — lanzando upload automático', 's-sy');
          uploadFirmware();
        } else {
          log('⚠ Firmware no reconocido — abre start-server.bat para subirlo automáticamente', 'err');
          slog('⚠ Inicia start-server.bat (doble clic) para habilitar upload automático', 's-er');
        }
      }
    }, 3000);
  }, 3000);
}

/* Abre un puerto tolerando el caso "ya está abierto" (restos de sesión previa). */
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
      // Forzar cierre con timeout para no bloquearse
      try { await withTimeout(p.close(), 1500, 'timeout close'); } catch {}
      await new Promise(r => setTimeout(r, 300));
      await tryOpen();
    } else {
      throw e;
    }
  }
}

/* ── Conectar directamente a un puerto ya autorizado ─────────────────── */
// skipUpload=true solo cuando se llama desde uploadFirmware() tras flashear
async function autoConnectPort(serialPort, skipUpload = false) {
  if (port) return;
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
    setConnStatus(true);   // Botón cambia a "Desconectar" inmediatamente
    hideAutoConnectBanner();
    // Conectar sin forzar subida — si el firmware no responde al protocolo,
    // _readyFallback() dispara upload automático solo cuando es necesario.
    slog('Puerto abierto @ 115200 baud — esperando READY…');
    _readyFallback();
    startReader();
  } catch(e) {
    port = null;
    log('Error al conectar: ' + e.message, 'err');
    slog('Error: ' + e.message, 's-er');
  }
}

// PWM helpers
const PULSE_MIN=130, PULSE_MAX=490;
function angleToPWM(a){ return Math.round(PULSE_MIN + (clamp(a,0,180)/180)*(PULSE_MAX-PULSE_MIN)); }

/** Construye el string de comando TX desde el estado J actual.
    El protocolo siempre usa B:/H:/C:/W:/G: — los canales solo
    afectan al firmware (los #define CH_*). */
function buildCmd() {
  // Servos de velocidad: valor = segundos a correr (+ adelante, - atrás, 0 parar)
  return [
    `B:${clamp(J.base.v, -10, 10).toFixed(2)}`,
    `H:${clamp(J.sho.v,  -10, 10).toFixed(2)}`,
    `C:${clamp(J.elb.v,  -10, 10).toFixed(2)}`,
    `W:${clamp(J.wri.v,  -10, 10).toFixed(2)}`,
    `G:${clamp(J.grip.v, -10, 10).toFixed(2)}`,
  ].join(',');
}

/* ── Telemetría (servos de velocidad: valores en segundos) ─── */
let _prevJ = {};

// PWM que Arduino enviará según la dirección actual (-1/0/+1)
function velPWM(secs, key) {
  if (Math.abs(secs) < 0.01) return (key && neutrals[key]) ? neutrals[key] : NEUTRAL_DEFAULT;
  return secs > 0 ? PULSE_MAX : PULSE_MIN;
}

function updateTelemetry() {
  ['base','sho','elb','wri','grip'].forEach(k => {
    const v   = J[k].v;
    const lbl = v === 0 ? '■ parado'
                        : (v > 0 ? '▶ +' : '◀ -') + Math.abs(v).toFixed(1) + 's';
    const pw  = velPWM(v, k);
    const pct = (clamp(v, -10, 10) + 10) / 20 * 100;   // -10..+10 → 0..100%
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
  const changed = JDEFS.some(d => Math.abs(J[d.key].v - (_prevJ[d.key]||0)) > 0.1);
  if (changed) { updateTelemetry(); JDEFS.forEach(d => _prevJ[d.key]=J[d.key].v); }
  requestAnimationFrame(telemLoop);
})();
updateTelemetry();

/* ── Consola serial ─────────────────────────────────────────── */
function slog(msg, cls='s-sy') {
  const el = document.getElementById('slog'); if (!el) return;
  const t  = new Date().toLocaleTimeString('es-MX',{hour12:false});
  el.innerHTML += `<div class="${cls}">[${t}] ${msg}</div>`;
  while (el.children.length > 300) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

/* ── Envío ──────────────────────────────────────────────────── */
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
let _lastSentCmd = null;   // null = nunca enviado
let _lastSendMs  = 0;

/** Sincroniza _lastSentCmd con la posición actual sin enviar nada al Arduino.
 *  Llamar después de cambios de calibración para que no disparen envío automático. */
function syncLastCmd() { _lastSentCmd = buildCmd(); _lastSendMs = performance.now(); }

/* Servos de velocidad: cada comando es un temporizador en Arduino, por eso
   si hay cualquier joint activo (≠0) hay que REFRESCAR el comando aunque
   el valor no cambie. Si todo está en 0, basta con enviar una sola vez. */
const REFRESH_MS = 600;  // renovar orden cada 600 ms (< 10 s que permite firmware)

// Rate-limit mínimo entre envíos para no saturar el puerto ni el firmware.
// Con maxSecs = 28–125 ms, evita spamear si la visión cambia el valor a 60 Hz.
const MIN_TX_MS = 80;

function sendPos() {
  const now = performance.now();
  // Rate-limit duro: no enviar más rápido que MIN_TX_MS entre comandos
  if (now - _lastSendMs < MIN_TX_MS) return;

  const cmd   = buildCmd();
  const anyOn = JDEFS.some(d => Math.abs(J[d.key].v) > 0.01);
  const changed = cmd !== _lastSentCmd;
  if (!changed && (!anyOn || now - _lastSendMs < REFRESH_MS)) return;

  _lastSentCmd = cmd;
  _lastSendMs  = now;
  sendRaw(cmd);
}

/* ── Estado visual ──────────────────────────────────────────── */
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

/* ── Reader asíncrono ───────────────────────────────────────── */
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
        slog('← ' + line, 's-rx');
        if (line.startsWith('OK') && lastTxMs > 0) {
          const lat = Math.round(performance.now() - lastTxMs);
          const el = document.getElementById('ard-latency'); if (el) el.textContent = lat+' ms';
        }
        if (line === 'PONG') {
          // El Arduino responde a PING → firmware IPN-RoboArm confirmado
          clearTimeout(_pingTimer);
          if (!serialT) {
            clearInterval(serialT);
            JDEFS.forEach(d => setJoint(d.key, d.def));
            _lastSentCmd = buildCmd();  // bloquear envío hasta que el usuario mueva algo
            setTimeout(() => sendNeutrals(), 200);
            serialT = setInterval(sendPos, Math.round(1000 / serialHz));
            log('Firmware IPN-RoboArm verificado \u2713 — listo, mueve un servo para comenzar', 'ok');
          }
        }
        if (line.startsWith('READY')) {
          clearTimeout(_readyTimer);
          clearTimeout(_pingTimer);
          // Verificar que es nuestro firmware, no otro sketch
          if (!line.includes('IPN-RoboArm')) {
            log('\u26a0 Firmware distinto detectado — intentando subir el correcto\u2026', 'err');
            slog('\u26a0 Firmware no-IPN detectado (' + line + ')', 's-er');
            if (_serverAvail) { uploadFirmware(); }
            else { slog('\u26a0 Abre start-server.bat para subir el firmware automáticamente', 's-er'); }
            return;
          }
          log('Arduino listo: ' + line, 'ok');
          JDEFS.forEach(d => setJoint(d.key, d.def));
          _lastSentCmd = buildCmd();  // bloquear envío hasta que el usuario mueva algo
          clearInterval(serialT);
          // Enviar trims neutrales calibrados por el usuario
          setTimeout(() => sendNeutrals(), 200);
          setTimeout(() => {
            serialT = setInterval(sendPos, Math.round(1000 / serialHz));
            log('Listo \u2014 mueve un servo o activa la c\u00e1mara para comenzar', 'ok');
            if (_uploadAfterReady) { _uploadAfterReady = false; uploadFirmware(); }
          }, 800);
        }
      }
    }
  } catch(e) { if (e.name!=='AbortError') slog('RX error: '+e.message,'s-er'); }
}

/* ── Conectar (con diálogo de selección de puerto) ──────────────────── */
async function connectSerial() {
  if (!('serial' in navigator)) {
    modal('Web Serial no disponible',
      'Requiere Chrome o Edge ≥ 89.\nLa página debe servirse por HTTPS o localhost.\nNo compatible con Firefox ni Safari.');
    return;
  }
  try {
    // Si ya hay un puerto abierto, desconectar limpio antes de volver a pedir uno
    if (port) { try { await disconnectSerial(); } catch {} }
    port = await navigator.serial.requestPort();
    await _safeOpenPort(port);
    writer = port.writable.getWriter();
    const info = port.getInfo();
    const pn = document.getElementById('port-name');
    if (pn) pn.textContent = info.usbProductId
      ? `USB 0x${info.usbProductId.toString(16).toUpperCase()}` : 'USB Serial';
    const st = document.getElementById('serial-txt');
    if (st) st.textContent = 'Conectado @ 115200 baud';
    slog('Puerto abierto @ 115200 baud — esperando READY…');
    log('Serial conectado', 'ok');
    setConnStatus(true);   // Botón cambia a "Desconectar" inmediatamente
    // No subir firmware automáticamente al conectar: solo si _readyFallback
    // detecta que el firmware cargado no responde al protocolo.
    _readyFallback();
    startReader();
  } catch(e) {
    if (e.name !== 'NotFoundError') log('Error serial: ' + e.message, 'err');
    slog('Error: ' + e.message, 's-er');
  }
}

/* ── Desconectar ────────────────────────────────────────────── */
async function disconnectSerial() {
  clearInterval(serialT); serialT = null;
  clearTimeout(_readyTimer); _readyTimer = null;
  clearTimeout(_pingTimer);  _pingTimer  = null;
  // Cancelar lector primero para que el stream cierre
  if (reader) { try { await reader.cancel(); } catch(e){} try { reader.releaseLock(); } catch(e){} reader=null; }
  if (writer) { try { await writer.close(); } catch(e){} try { writer.releaseLock(); } catch(e){} writer=null; }
  if (port)   {
    try { await port.close(); } catch(e){}
    port = null;
    // Breve pausa para que el driver USB libere el handle
    await new Promise(r => setTimeout(r, 200));
  }
  setConnStatus(false);
  slog('Desconectado'); log('Serial desconectado', 'info');
}

/* ── Parada de emergencia ───────────────────────────────────── */
async function emergencyStop() {
  if (!writer) return;
  clearInterval(serialT); serialT=null;
  await sendRaw('HOME');
  JDEFS.forEach(d => setJoint(d.key, d.def));
  log('⚠ STOP — servos en HOME', 'err');
}

/* ── Presets ────────────────────────────────────────────────── */
const PRESET_KEY = 'roboarm-presets-v10';
let presets = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}');

function savePreset(slot) {
  const name = document.getElementById('preset-name-' + slot);
  if (!name || !name.value.trim()) { log('Escribe un nombre para el preset','err'); return; }
  presets[slot] = { name:name.value.trim(), base:J.base.v, sho:J.sho.v, elb:J.elb.v, wri:J.wri.v, grip:J.grip.v };
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

/* ── Sweep de servo (prueba de rango) ───────────────────────── */
function sweepServo(key) {
  if (!writer) { log('Conecta primero el serial','err'); return; }
  const mn=J[key].calMin, mx=J[key].calMax;
  let i=0, steps=10;
  const iv = setInterval(() => {
    const v = i<steps ? lerp(mn,mx,i/steps) : lerp(mx,mn,(i-steps)/steps);
    setJoint(key,v); sendRaw(buildCmd());
    if (++i > steps*2) { clearInterval(iv); setJoint(key,(mn+mx)/2); }
  }, 80);
}

/* ══════════════════════════════════ SUBIDA DE FIRMWARE ══════════════════════════════════ */

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
  if (bannerBtn) bannerBtn.style.display = '';  // siempre visible
  const tabBtn = document.getElementById('btn-upload-fw');
  if (tabBtn) {
    tabBtn.disabled  = false;
    tabBtn.style.opacity = '1';
    tabBtn.title = _serverAvail
      ? 'Subir firmware al Arduino via arduino-cli (servidor OK)'
      : 'Haz clic para ver cómo iniciar el servidor de compilación';
  }
  // El botón de descarga siempre está disponible
  const dlBtn = document.getElementById('btn-dl-fw');
  if (dlBtn) dlBtn.style.display = '';
}

/** Muestra al usuario cómo iniciar el servidor de compilación. */
function showServerHelp() {
  modal('Activa la subida automática desde el navegador',
    'Para subir el firmware al Arduino sin descargar nada, hace falta un\n' +
    'pequeño servidor local que compile el código con arduino-cli.\n\n' +
    '1) Haz doble clic en start-server.bat (está en la carpeta del proyecto).\n' +
    '2) Se abrirá una ventana negra — déjala abierta.\n' +
    '3) Vuelve aquí y pulsa "⬆ Subir al Arduino" de nuevo.\n\n' +
    'Requisitos una sola vez:\n' +
    '• Node.js:       https://nodejs.org\n' +
    '• arduino-cli:  winget install ArduinoSA.CLI\n' +
    '                arduino-cli core install arduino:avr');
}

document.getElementById('btn-dl-fw').addEventListener('click', () => {
  const code = document.getElementById('fw').textContent;
  if (!code.trim()) { log('Genera el firmware primero', 'err'); return; }
  const blob = new Blob([code], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roboarm_fw.ino';
  a.click();
  URL.revokeObjectURL(a.href);
  log('roboarm_fw.ino descargado — ábrelo en Arduino IDE y súbelo', 'ok');
});

async function uploadFirmware() {
  if (!_serverAvail) {
    // Re-verificar (por si el usuario acaba de abrir start-server.bat)
    await checkServer();
    if (!_serverAvail) {
      showServerHelp();
      log('Inicia start-server.bat y reintenta la subida', 'err');
      return;
    }
  }

  // Guardar referencia al puerto antes de desconectar
  let flashPort = port;
  if (!flashPort) {
    // Intentar con un puerto ya autorizado (si lo hay) para no forzar conexión previa
    const ports = await navigator.serial.getPorts();
    if (ports.length === 0) {
      log('No hay Arduino autorizado — pulsa ⚡ Conectar primero', 'err');
      return;
    }
    flashPort = ports[0];
  }

  // 1. Compilar firmware en el servidor
  log('Compilando firmware…', 'info');
  slog('⬆ Compilando con arduino-cli…', 's-sy');
  let hex;
  try {
    const r = await fetch('http://localhost:8080/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ino: generateFirmware() }),
      signal: AbortSignal.timeout(60000),   // compile puede tardar, pero no infinito
    });
    const d = await r.json();
    if (!d.ok) {
      log('Error compilando: ' + (d.error || 'ver consola del servidor'), 'err');
      slog('✗ Compilación fallida: ' + (d.error || d.output || '').slice(0, 200), 's-er');
      return;
    }
    hex = d.hex;
    log('Compilación OK — subiendo al Arduino…', 'ok');
    slog('✓ Compilado — subiendo por USB (STK500)…', 's-sy');
  } catch(e) {
    log('Sin respuesta del servidor: ' + e.message, 'err');
    slog('✗ Timeout/error en /compile — reintenta tras iniciar start-server.bat', 's-er');
    return;
  }

  // 2. Desconectar serial normal para liberar el puerto
  await disconnectSerial();
  await new Promise(r => setTimeout(r, 300));

  // 3. Subir hex desde el browser via STK500/Optiboot (flasher.js)
  try {
    await flashArduino(flashPort, hex, pct => {
      const pEl = document.getElementById('upload-progress');
      if (pEl) pEl.textContent = Math.round(pct * 100) + '%';
      if (pct < 1) slog('⬆ Subiendo… ' + Math.round(pct * 100) + '%', 's-sy');
    });
    log('Firmware subido ✓ — reconectando…', 'ok');
    slog('✓ Firmware cargado — Arduino reiniciando', 's-ok');
    // 4. Reconectar automáticamente tras el reinicio del Arduino
    // Reintentar hasta 5 veces con backoff por si el driver USB aún no lo libera
    const reconnect = async (attempt = 0) => {
      if (attempt >= 5 || port) return;
      try {
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0 && !port) {
          await autoConnectPort(ports[0], true); // true = no re-flashear
          if (port) return;                       // conectado con éxito
        }
      } catch (e) {
        slog('Reintento conexión ' + (attempt + 1) + ': ' + e.message, 's-er');
      }
      setTimeout(() => reconnect(attempt + 1), 800 + attempt * 400);
    };
    setTimeout(() => reconnect(0), 2500);
  } catch(e) {
    log('Error al subir firmware: ' + e.message, 'err');
    slog('✗ STK500 error: ' + e.message, 's-er');
  } finally {
    const pEl = document.getElementById('upload-progress');
    if (pEl) pEl.textContent = '';
  }
}

/* ══════════════════════════════════ LISTENERS ══════════════════════════════════ */

// Serial
document.getElementById('btn-conn').addEventListener('click',
  () => port ? disconnectSerial() : connectSerial());
document.getElementById('btn-home-ser').addEventListener('click',
  () => { JDEFS.forEach(d=>setJoint(d.key,d.def)); sendRaw(buildCmd()); log('HOME enviado','ok'); });
document.getElementById('btn-ping').addEventListener('click',
  () => sendRaw('PING'));
document.getElementById('btn-emergency').addEventListener('click', emergencyStop);
document.getElementById('btn-send-raw').addEventListener('click',
  () => { const v=document.getElementById('inp-cmd').value.trim(); if(v) sendRaw(v); });
document.getElementById('inp-cmd').addEventListener('keydown',
  e => { if(e.key==='Enter') { const v=e.target.value.trim(); if(v) sendRaw(v); } });
document.getElementById('btn-clr').addEventListener('click',
  () => document.getElementById('slog').innerHTML='');

// Firmware copy
document.getElementById('btn-copy-fw').addEventListener('click', () =>
  navigator.clipboard.writeText(document.getElementById('fw').textContent || generateFirmware())
    .then(() => log('Firmware copiado al portapapeles ✓','ok'))
    .catch(() => log('Error al copiar firmware','err'))
);

// Frecuencia de transmisión
document.getElementById('sl-hz').addEventListener('input', function() {
  serialHz = parseInt(this.value);
  document.getElementById('lv-hz').textContent = serialHz + ' Hz';
  if (serialT) { clearInterval(serialT); serialT=setInterval(sendPos, Math.round(1000/serialHz)); }
});

// Velocidad de servos
document.getElementById('sl-spd').addEventListener('input', function() {
  const spd = parseFloat(this.value);
  document.getElementById('lv-spd').textContent = spd + ' °/s';
  if (writer) sendRaw('SPD:' + spd);
});

// Auto-inicio
document.getElementById('chk-autostart').addEventListener('change', function() {
  log('Auto-inicio: '+(this.checked?'activado':'desactivado'),'info');
});

// Sliders de prueba individual de servo
['base','sho','elb','wri','grip'].forEach(k => {
  const sl = document.getElementById('ard-sl-'+k);
  if (sl) sl.addEventListener('input', function() {
    setJoint(k, parseFloat(this.value));
    if (writer) sendRaw(buildCmd());
  });
});

// Botones sweep
['base','sho','elb','wri','grip'].forEach(k => {
  const btn = document.getElementById('ard-sweep-'+k);
  if (btn) btn.addEventListener('click', () => sweepServo(k));
});

/* ── Listeners de asignación de canales ─────────────────────── */

// Cambio en cualquier select de canal → validar en tiempo real
document.querySelectorAll('.chan-sel').forEach(sel => {
  sel.addEventListener('change', () => {
    readChannelsFromUI();
    const err = validateChannels();
    // Marcar filas con conflicto en rojo
    ['base','sho','elb','wri','grip'].forEach(k => {
      const row = document.getElementById('chanrow-'+k);
      if (row) row.classList.remove('chan-conflict');
    });
    if (err) {
      // Encontrar los dos servos en conflicto y marcarlos
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

// Botón Guardar canales
document.getElementById('btn-chan-save').addEventListener('click', saveChannels);

// Botón Restablecer canales
document.getElementById('btn-chan-reset').addEventListener('click', resetChannels);

/* ══════════════════════════════════ INICIALIZACIÓN ══════════════════════════════════ */

// Aplicar chanMap guardado a los selects
applyChannelsToUI();
// Generar firmware inicial y actualizar telemetría
refreshChannelStatus();
updateTelemetry();
updateTelemChannels();

// Botones del banner de auto-conexión
document.getElementById('banner-btn-connect').addEventListener('click', () => {
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

// Botón de subida de firmware en tab Arduino
const _uploadBtn = document.getElementById('btn-upload-fw');
if (_uploadBtn) _uploadBtn.addEventListener('click', uploadFirmware);

// Auto-detección de Arduino (solo hot-plug — no probing síncrono en load)
if ('serial' in navigator) {
  // Al cargar: si hay un puerto autorizado, mostrar banner SIN abrir el puerto
  // (abrir/cerrar probe bloquea el hilo principal varios segundos en Windows)
  navigator.serial.getPorts().then(ports => {
    if (ports.length > 0 && !port) {
      // Pequeño delay para no competir con el render inicial
      setTimeout(() => { if (!port) showAutoConnectBanner(ports[0]); }, 400);
    }
  }).catch(() => {});

  // Enchufe en caliente → banner (no auto-conexión directa para evitar cascadas)
  navigator.serial.addEventListener('connect', e => {
    if (!port) showAutoConnectBanner(e.target);
  });

  navigator.serial.addEventListener('disconnect', e => {
    if (port && e.target === port) {
      disconnectSerial();
      log('Arduino desconectado', 'err');
    }
  });
}

// Seleccionar 115200 en el dropdown (matching al firmware)
const _baudSel = document.getElementById('sel-baud');
if (_baudSel) _baudSel.value = '115200';

// Verificar si el servidor arduino-cli está disponible
checkServer();
setInterval(checkServer, 10000); // Re-verificar cada 10 s

// Mensajes de bienvenida en consola serial
slog('RoboArm IPN v4.0 — Sistema listo');
const chanSummary = ['base','sho','elb','wri','grip']
  .map(k => `CH${chanMap[k]}=${SERVO_META[k].label}`).join('  ');
slog(chanSummary, 's-sy');
slog('Haz clic en ⚡ Conectar para seleccionar el puerto USB');
