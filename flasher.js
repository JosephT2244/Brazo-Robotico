/* ════════════════════════════════════════════════════════════════
   flasher.js — Subida de firmware via STK500/Optiboot
   ────────────────────────────────────────────────────────────────
   Implementa el protocolo STK500v1 que usa el bootloader Optiboot
   (Arduino Uno, Mega, Nano, etc.) directamente sobre Web Serial.

   No requiere Arduino IDE. El flujo es:
     1. server.js compila el .ino → devuelve el .hex (Intel HEX)
     2. flashArduino() abre el puerto, resetea por DTR, sube el .hex
     3. Arduino arranca el nuevo firmware automáticamente

   Uso:
     const hex = await fetch('http://localhost:8080/compile', {...}).then(r=>r.json());
     await flashArduino(serialPort, hex.hex, pct => console.log(pct * 100 + '%'));

   Compatibilidad: Arduino Uno (ATmega328P), Mega (ATmega2560 con Stk500v2),
                   Nano, Pro Mini — cualquier placa con Optiboot 115200 baud.
   ════════════════════════════════════════════════════════════════ */

/* ── Constantes STK500v1 ─────────────────────────────────────── */
const _S = {
  OK:           0x10,
  INSYNC:       0x14,
  CRC_EOP:      0x20,
  GET_SYNC:     0x30,
  LEAVE_PROGMODE: 0x51,
  LOAD_ADDRESS: 0x55,
  PROG_PAGE:    0x64,
  READ_SIGN:    0x75,
};

/* ── Parser Intel HEX → Uint8Array ──────────────────────────── */
function _parseHex(hex) {
  const lines  = hex.split(/\r?\n/);
  const chunks = [];
  let maxAddr  = 0;

  for (const raw of lines) {
    const l = raw.trim();
    if (l[0] !== ':') continue;
    const n = parseInt(l.slice(1,3), 16);
    const a = parseInt(l.slice(3,7), 16);
    const t = parseInt(l.slice(7,9), 16);
    if (t !== 0x00) continue; // Solo registros de datos
    const d = [];
    for (let i = 0; i < n; i++) d.push(parseInt(l.slice(9+i*2, 11+i*2), 16));
    chunks.push({ a, d });
    maxAddr = Math.max(maxAddr, a + n);
  }

  const bin = new Uint8Array(maxAddr).fill(0xFF); // 0xFF = flash borrado
  for (const { a, d } of chunks) bin.set(d, a);
  return bin;
}

/* ── Flasher principal ──────────────────────────────────────── */

/**
 * Sube firmware al Arduino via protocolo STK500 / Optiboot.
 * @param {SerialPort} serialPort  Puerto Web Serial YA autorizado (cerrado)
 * @param {string}     hexString   Contenido del archivo Intel HEX (.hex)
 * @param {Function}   onProgress  Callback(0..1) con progreso de subida
 * @param {number}     pageSize    128 para Uno/Nano, 256 para Mega (default 128)
 */
async function flashArduino(serialPort, hexString, onProgress = null, pageSize = 128) {
  const bin   = _parseHex(hexString);
  const pages = Math.ceil(bin.length / pageSize);

  /* ── Abrir puerto a 115200 (Optiboot) ─────────────────────── */
  await serialPort.open({ baudRate: 115200 });

  /* ── Buffer de lectura asíncrono ───────────────────────────── */
  const rxQ    = [];   // bytes recibidos sin consumir
  const rxWait = [];   // promesas esperando un byte
  let loopActive = true;

  const rdReader = serialPort.readable.getReader();
  (async () => {
    try {
      while (loopActive) {
        const { value, done } = await rdReader.read();
        if (done) break;
        for (const b of value) {
          if (rxWait.length > 0) rxWait.shift()(b);
          else rxQ.push(b);
        }
      }
    } catch { /* puerto cerrado */ }
    rdReader.releaseLock();
  })();

  const writer = serialPort.writable.getWriter();
  const tx     = bytes => writer.write(new Uint8Array(bytes));

  /* Lee un byte con timeout en ms */
  const rxByte = (ms = 800) => new Promise((res, rej) => {
    if (rxQ.length) { res(rxQ.shift()); return; }
    const t = setTimeout(() => {
      const i = rxWait.indexOf(res);
      if (i >= 0) rxWait.splice(i, 1);
      rej(new Error('Timeout bootloader'));
    }, ms);
    rxWait.push(b => { clearTimeout(t); res(b); });
  });

  /* Espera STK_INSYNC + STK_OK del bootloader */
  const expect = async (ms = 800) => {
    const b0 = await rxByte(ms);
    const b1 = await rxByte(ms);
    if (b0 !== _S.INSYNC || b1 !== _S.OK)
      throw new Error(`STK error: 0x${b0.toString(16)} 0x${b1.toString(16)}`);
  };

  try {
    /* 1. Reset por DTR → Arduino entra en bootloader por ~500 ms */
    await serialPort.setSignals({ dataTerminalReady: false });
    await new Promise(r => setTimeout(r, 50));
    await serialPort.setSignals({ dataTerminalReady: true });
    await new Promise(r => setTimeout(r, 180)); // Optiboot arranca en ~150 ms

    /* 2. Sincronizar con el bootloader */
    let synced = false;
    for (let i = 0; i < 10 && !synced; i++) {
      rxQ.length = 0; // Limpiar buffer de basura (eco de READY, etc.)
      while (rxWait.length) rxWait.shift()(0xFF); // Cancelar esperas anteriores
      await tx([_S.GET_SYNC, _S.CRC_EOP]);
      try { await expect(200); synced = true; }
      catch { await new Promise(r => setTimeout(r, 40)); }
    }
    if (!synced)
      throw new Error(
        'No se pudo sincronizar con el bootloader.\n' +
        'Verifica que el Arduino esté conectado y sea compatible con Optiboot (Uno, Nano, Mega).'
      );

    /* 3. Escribir páginas de flash */
    for (let p = 0; p < pages; p++) {
      // Cargar dirección (en words, no bytes)
      const word = (p * pageSize) >> 1;
      await tx([_S.LOAD_ADDRESS, word & 0xFF, (word >> 8) & 0xFF, _S.CRC_EOP]);
      await expect(500);

      // Escribir página: [PROG_PAGE, lenHi, lenLo, 'F'=flash, ...datos, CRC_EOP]
      const chunk = new Uint8Array(pageSize).fill(0xFF);
      chunk.set(bin.slice(p * pageSize, (p + 1) * pageSize));
      await tx([_S.PROG_PAGE, 0x00, pageSize, 0x46, ...chunk, _S.CRC_EOP]);
      await expect(5000);

      if (onProgress) onProgress((p + 1) / pages);
    }

    /* 4. Salir del modo de programación → Arduino arranca el sketch */
    await tx([_S.LEAVE_PROGMODE, _S.CRC_EOP]);
    try { await expect(600); } catch { /* OK: Arduino ya reinicia */ }

  } finally {
    loopActive = false;
    try { writer.releaseLock(); }   catch { }
    try { await serialPort.close(); } catch { }
  }
}
