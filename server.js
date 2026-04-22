/**
 * RoboArm IPN — Servidor companion arduino-cli
 *
 * Requisitos:
 *   - Node.js instalado  (https://nodejs.org)
 *   - arduino-cli en el PATH (https://arduino.github.io/arduino-cli/)
 *     Instalación rápida en Windows:
 *       winget install ArduinoSA.CLI
 *     Primera vez: arduino-cli core install arduino:avr
 *
 * Uso:
 *   node server.js          (puerto 8080 por defecto)
 *   node server.js 9090     (puerto personalizado)
 *
 * Endpoints:
 *   GET  /status   → {"ok":true, "version":"arduino-cli 0.x.x"}
 *   GET  /detect   → {"port":"COM3", "board":"Arduino Uno"}
 *   POST /upload   → {"ino":"…código…", "fqbn":"arduino:avr:uno"}
 *                  ← {"ok":true, "output":"…"}
 */

const http  = require('http');
const { exec, execFile } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

/* Rutas y parámetros base del companion server.
   El sketch y la compilación viven en carpetas temporales para no ensuciar
   el proyecto con artefactos generados por arduino-cli. */
const ROOT_DIR   = __dirname;
const PORT       = parseInt(process.argv[2]) || 8080;
const SKETCH_DIR = path.join(os.tmpdir(), 'roboarm_fw');
const INO_PATH   = path.join(SKETCH_DIR, 'roboarm_fw.ino');
const BUILD_DIR  = path.join(os.tmpdir(), 'roboarm_build');
const DEFAULT_FQBN = 'arduino:avr:uno';

// Resuelve primero rutas explícitas/locales y luego cae al PATH global.
function resolveArduinoCli() {
  const candidates = [
    process.env.ARDUINO_CLI,
    path.join(ROOT_DIR, 'arduino-cli.exe'),
    path.join(ROOT_DIR, 'arduino-cli'),
    'arduino-cli',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'arduino-cli') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'arduino-cli';
}

const ARDUINO_CLI = resolveArduinoCli();
let lastDetected = { port: null, board: null, name: null };

// Wrapper promisificado para binarios con argumentos separados.
function execFileText(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: ROOT_DIR, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// Variante para comandos completos cuando PowerShell/cmd lo requieren.
function execText(command, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: ROOT_DIR, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// Punto único para invocar arduino-cli con la ruta resuelta.
function runArduinoCli(args, opts = {}) {
  return execFileText(ARDUINO_CLI, args, opts);
}

// Une stdout/stderr en un solo bloque legible para logs y respuestas HTTP.
function mergeOutput(stdout, stderr) {
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

// Conserva la última detección útil para mejorar reintentos posteriores.
function rememberBoard(info = {}) {
  if (info.port)  lastDetected.port  = info.port;
  if (info.board) lastDetected.board = info.board;
  if (info.name)  lastDetected.name  = info.name;
  return {
    port:  info.port  || lastDetected.port  || null,
    board: info.board || lastDetected.board || null,
    name:  info.name  || lastDetected.name  || null,
  };
}

// Normaliza la salida JSON de distintas versiones de arduino-cli.
function parseBoardList(stdout) {
  try {
    const data = JSON.parse(stdout);
    const rawPorts = Array.isArray(data)
      ? data
      : Array.isArray(data.detected_ports)
        ? data.detected_ports
        : Array.isArray(data.ports)
          ? data.ports
          : [];

    return rawPorts.map(entry => {
      const portInfo = entry.port || entry;
      const boards = Array.isArray(entry.matching_boards)
        ? entry.matching_boards
        : Array.isArray(entry.boards)
          ? entry.boards
          : [];
      const bestBoard = boards[0] || null;
      return {
        port: portInfo?.address || entry.address || portInfo?.name || null,
        board: bestBoard?.fqbn || null,
        name: bestBoard?.name || null,
        protocol: portInfo?.protocol || entry.protocol || '',
        label: portInfo?.protocol_label || entry.protocol_label || entry.label || '',
      };
    }).filter(item => item.port);
  } catch {
    return [];
  }
}

// Fallback del sistema operativo cuando arduino-cli aún no identifica la placa.
function listSystemSerialPorts() {
  const ps = "[System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object | ConvertTo-Json -Compress";
  return execFileText('powershell', ['-NoProfile', '-Command', ps], { timeout: 5000 })
    .then(({ stdout }) => {
      const txt = stdout.trim();
      if (!txt) return [];
      const parsed = JSON.parse(txt);
      return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
    })
    .catch(() => []);
}

// Asigna preferencia al puerto esperado y a entradas que sí parecen serial USB.
function rankPortCandidate(item, preferredPort = null) {
  let score = 0;
  if (preferredPort && item.port === preferredPort) score += 1000;
  if (lastDetected.port && item.port === lastDetected.port) score += 400;
  if (item.board) score += 200;
  if (/^COM\d+$/i.test(item.port || '')) score += 100;
  if (/serial|usb|cdc/i.test(`${item.protocol || ''} ${item.label || ''}`)) score += 50;
  return score;
}

/* ── CORS ─────────────────────────────────────────────────────────── */
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
}

/* ── Detectar Arduino conectado vía arduino-cli board list ─────── */
/* Combina la detección de arduino-cli con los puertos del sistema para no
   perder el dispositivo aunque la CLI tarde en reconocer la placa exacta. */
async function detectBoard(preferredPort = null) {
  let cliPorts = [];
  try {
    const { stdout } = await runArduinoCli(['board', 'list', '--json'], { timeout: 8000 });
    cliPorts = parseBoardList(stdout);
  } catch {
    cliPorts = [];
  }

  const systemPorts = await listSystemSerialPorts();
  const extraPorts = systemPorts
    .filter(port => !cliPorts.some(item => item.port === port))
    .map(port => ({ port, board: null, name: null, protocol: 'serial', label: 'System Serial Port' }));

  const candidates = [...cliPorts, ...extraPorts];
  if (!candidates.length) return rememberBoard({});

  candidates.sort((a, b) => rankPortCandidate(b, preferredPort) - rankPortCandidate(a, preferredPort));
  const chosen = { ...candidates[0] };

  if (!chosen.board && chosen.port === lastDetected.port && lastDetected.board)
    chosen.board = lastDetected.board;
  if (!chosen.name && chosen.port === lastDetected.port && lastDetected.name)
    chosen.name = lastDetected.name;

  return rememberBoard(chosen);
}

/* ── Solo compilar → devuelve contenido del .hex ─────────────── */
/* Se usa cuando el navegador hará la subida por Web Serial/STK500 y solo
   necesita el .hex final, no una carga completa desde el servidor. */
async function compileOnly(inoSource, fqbn) {
  const board = fqbn || DEFAULT_FQBN;
  fs.mkdirSync(SKETCH_DIR, { recursive: true });
  fs.mkdirSync(BUILD_DIR,  { recursive: true });
  fs.writeFileSync(INO_PATH, inoSource, 'utf8');

  const args = ['compile', '--fqbn', board, '--build-path', BUILD_DIR, SKETCH_DIR];
  console.log('[compile] Ejecutando:', `"${ARDUINO_CLI}" ${args.join(' ')}`);

  try {
    const { stdout, stderr } = await runArduinoCli(args, { timeout: 90000 });
    const output = mergeOutput(stdout, stderr);
    let hexFiles;
    try { hexFiles = fs.readdirSync(BUILD_DIR).filter(f => f.endsWith('.hex')); }
    catch { hexFiles = []; }
    if (hexFiles.length === 0) {
      return { ok: false, output, error: '.hex no generado — verifica el FQBN de la placa' };
    }
    const hex = fs.readFileSync(path.join(BUILD_DIR, hexFiles[0]), 'utf8');
    console.log(`[compile] OK — ${hexFiles[0]} (${hex.length} bytes)`);
    return { ok: true, hex, file: hexFiles[0], output };
  } catch (err) {
    const output = mergeOutput(err.stdout, err.stderr);
    console.error('[compile] Error:', output.slice(0, 300));
    return { ok: false, output, error: err.message };
  }
}

/* ── Compilar + subir ─────────────────────────────────────────── */
/* Ruta clásica: el servidor compila y luego delega a arduino-cli la carga
   directa al puerto serie detectado o solicitado. */
async function compileAndUpload(inoSource, fqbn, serialPort) {
  fs.mkdirSync(SKETCH_DIR, { recursive: true });
  fs.mkdirSync(BUILD_DIR,  { recursive: true });
  fs.writeFileSync(INO_PATH, inoSource, 'utf8');

  const board = fqbn || lastDetected.board || DEFAULT_FQBN;
  let port = serialPort || lastDetected.port || null;

  if (!port) {
    const detected = await detectBoard();
    port = detected.port || null;
  }

  if (!port) {
    return {
      ok: false,
      error: 'No se pudo detectar el puerto COM del Arduino',
      output: 'Failed uploading: no upload port provided',
    };
  }

  rememberBoard({ port, board });

  const compileArgs = ['compile', '--fqbn', board, '--build-path', BUILD_DIR, SKETCH_DIR];
  const uploadArgs = ['upload', '--port', port, '--fqbn', board, SKETCH_DIR];
  console.log('[upload] Compilando:', `"${ARDUINO_CLI}" ${compileArgs.join(' ')}`);
  console.log('[upload] Subiendo:', `"${ARDUINO_CLI}" ${uploadArgs.join(' ')}`);

  try {
    const comp = await runArduinoCli(compileArgs, { timeout: 90000 });
    const up = await runArduinoCli(uploadArgs, { timeout: 90000 });
    const output = mergeOutput(comp.stdout, comp.stderr) + '\n' + mergeOutput(up.stdout, up.stderr);
    console.log('[upload] Éxito:', output.slice(0, 120));
    return { ok: true, output: output.trim() };
  } catch (err) {
    const output = mergeOutput(err.stdout, err.stderr);
    console.error('[upload] Error:', output);
    return { ok: false, output, error: err.message };
  }
}

/* ── Leer body JSON ─────────────────────────────────────────────── */
// Parser mínimo para requests pequeñas enviadas desde la UI web.
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ── Servidor HTTP ─────────────────────────────────────────────── */
/* Router deliberadamente simple: pocas rutas, sin framework externo y con
   respuestas JSON para que el front tenga una integración predecible. */
const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* GET /status */
  if (req.method === 'GET' && req.url === '/status') {
    runArduinoCli(['version'], { timeout: 3000 })
      .then(({ stdout }) => {
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          version: stdout.trim() || 'arduino-cli sin versión',
          cli: ARDUINO_CLI,
        }));
      })
      .catch(() => {
        res.writeHead(503);
        res.end(JSON.stringify({
          ok: false,
          version: 'arduino-cli no encontrado',
          cli: ARDUINO_CLI,
        }));
      });
    return;
  }

  /* GET /detect */
  if (req.method === 'GET' && req.url === '/detect') {
    const info = await detectBoard();
    res.writeHead(200);
    res.end(JSON.stringify(info));
    return;
  }

  /* POST /compile — solo compila, devuelve .hex para que el browser suba por STK500 */
  if (req.method === 'POST' && req.url === '/compile') {
    let body;
    try { body = await readJSON(req); }
    catch(e) { res.writeHead(400); res.end(JSON.stringify({ ok:false, error:'JSON inválido' })); return; }
    const { ino, fqbn } = body;
    if (!ino) { res.writeHead(400); res.end(JSON.stringify({ ok:false, error:'Falta campo ino' })); return; }
    const result = await compileOnly(ino, fqbn);
    res.writeHead(result.ok ? 200 : 500);
    res.end(JSON.stringify(result));
    return;
  }

  /* POST /upload */
  if (req.method === 'POST' && req.url === '/upload') {
    let body;
    try { body = await readJSON(req); }
    catch(e) { res.writeHead(400); res.end(JSON.stringify({ ok:false, error:'JSON inválido' })); return; }

    const { ino, fqbn, port } = body;
    if (!ino) { res.writeHead(400); res.end(JSON.stringify({ ok:false, error:'Falta campo ino' })); return; }

    // Auto-detectar puerto si no se especificó
    const detected = await detectBoard(port || null);
    const serialPort = port || detected.port || lastDetected.port || null;
    const board      = fqbn || detected.board || lastDetected.board || DEFAULT_FQBN;

    console.log(`[upload] Puerto: ${serialPort || 'auto'} | Board: ${board}`);

    const result = await compileAndUpload(ino, board, serialPort);
    res.writeHead(result.ok ? 200 : 500);
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, 'localhost', () => {
  console.log('════════════════════════════════════════════');
  console.log(`  RoboArm IPN — Servidor arduino-cli`);
  console.log(`  http://localhost:${PORT}`);
  console.log('════════════════════════════════════════════');

  runArduinoCli(['version'])
    .then(({ stdout }) => {
      console.log('\n✓  ' + stdout.trim());
      console.log(`   CLI: ${ARDUINO_CLI}`);
      console.log('   Listo para compilar y subir firmware.\n');
    })
    .catch(() => {
      console.log('\n⚠  arduino-cli no encontrado.');
      console.log(`   Buscado en: ${ARDUINO_CLI}`);
      console.log('   Instala con:  winget install ArduinoSA.CLI');
      console.log('   Luego:        arduino-cli core install arduino:avr\n');
    });
});
