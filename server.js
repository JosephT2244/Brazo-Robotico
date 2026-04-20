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
const { exec } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const PORT       = parseInt(process.argv[2]) || 8080;
const SKETCH_DIR = path.join(os.tmpdir(), 'roboarm_fw');
const INO_PATH   = path.join(SKETCH_DIR, 'roboarm_fw.ino');
const BUILD_DIR  = path.join(os.tmpdir(), 'roboarm_build');

/* ── CORS ─────────────────────────────────────────────────────────── */
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
}

/* ── Detectar Arduino conectado vía arduino-cli board list ─────── */
function detectBoard() {
  return new Promise(resolve => {
    exec('arduino-cli board list --json', { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve({ port: null, board: null }); return; }
      try {
        const data  = JSON.parse(stdout);
        // arduino-cli ≥ 0.34 usa detected_ports; versiones anteriores usan boards
        const ports = data.detected_ports || data || [];
        const found = ports.find(p =>
          p.matching_boards && p.matching_boards.length > 0);
        if (found) {
          resolve({
            port:  found.port.address,
            board: found.matching_boards[0].fqbn,
            name:  found.matching_boards[0].name,
          });
        } else {
          resolve({ port: null, board: null });
        }
      } catch { resolve({ port: null, board: null }); }
    });
  });
}

/* ── Solo compilar → devuelve contenido del .hex ─────────────── */
function compileOnly(inoSource, fqbn) {
  return new Promise(resolve => {
    const board = fqbn || 'arduino:avr:uno';
    fs.mkdirSync(SKETCH_DIR, { recursive: true });
    fs.mkdirSync(BUILD_DIR,  { recursive: true });
    fs.writeFileSync(INO_PATH, inoSource, 'utf8');

    const cmd = `arduino-cli compile --fqbn ${board} --build-path "${BUILD_DIR}" "${SKETCH_DIR}"`;
    console.log('[compile] Ejecutando:', cmd);

    exec(cmd, { timeout: 90000 }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (err) {
        console.error('[compile] Error:', output.slice(0, 300));
        resolve({ ok: false, output, error: err.message });
        return;
      }
      // Buscar el .hex generado en BUILD_DIR
      let hexFiles;
      try { hexFiles = fs.readdirSync(BUILD_DIR).filter(f => f.endsWith('.hex')); }
      catch { hexFiles = []; }
      if (hexFiles.length === 0) {
        resolve({ ok: false, error: '.hex no generado — verifica el FQBN de la placa' });
        return;
      }
      const hex = fs.readFileSync(path.join(BUILD_DIR, hexFiles[0]), 'utf8');
      console.log(`[compile] OK — ${hexFiles[0]} (${hex.length} bytes)`);
      resolve({ ok: true, hex, file: hexFiles[0] });
    });
  });
}

/* ── Compilar + subir ─────────────────────────────────────────── */
function compileAndUpload(inoSource, fqbn, serialPort) {
  return new Promise(resolve => {
    fs.mkdirSync(SKETCH_DIR, { recursive: true });
    fs.writeFileSync(INO_PATH, inoSource, 'utf8');

    const portArg = serialPort ? `--port "${serialPort}"` : '';
    const board   = fqbn || 'arduino:avr:uno';
    const cmd     = [
      `arduino-cli compile --fqbn ${board} "${SKETCH_DIR}"`,
      `arduino-cli upload ${portArg} --fqbn ${board} "${SKETCH_DIR}"`,
    ].join(' && ');

    console.log('[upload] Ejecutando:', cmd);

    exec(cmd, { timeout: 90000 }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (err) {
        console.error('[upload] Error:', output);
        resolve({ ok: false, output, error: err.message });
      } else {
        console.log('[upload] Éxito:', output.slice(0, 120));
        resolve({ ok: true, output });
      }
    });
  });
}

/* ── Leer body JSON ─────────────────────────────────────────────── */
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
const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* GET /status */
  if (req.method === 'GET' && req.url === '/status') {
    exec('arduino-cli version', { timeout: 3000 }, (err, stdout) => {
      res.writeHead(err ? 503 : 200);
      res.end(JSON.stringify({
        ok:      !err,
        version: stdout.trim() || 'arduino-cli no encontrado',
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

    const { ino, fqbn } = body;
    if (!ino) { res.writeHead(400); res.end(JSON.stringify({ ok:false, error:'Falta campo ino' })); return; }

    // Auto-detectar puerto si no se especificó
    const detected = await detectBoard();
    const serialPort = detected.port;
    const board      = fqbn || detected.board || 'arduino:avr:uno';

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

  exec('arduino-cli version', (err, stdout) => {
    if (err) {
      console.log('\n⚠  arduino-cli NO encontrado en el PATH.');
      console.log('   Instala con:  winget install ArduinoSA.CLI');
      console.log('   Luego:        arduino-cli core install arduino:avr\n');
    } else {
      console.log('\n✓  ' + stdout.trim());
      console.log('   Listo para compilar y subir firmware.\n');
    }
  });
});
