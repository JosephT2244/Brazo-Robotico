/* ════════════════════════════════════════════════
   vision.js — Control por posición de mano v11
   ────────────────────────────────────────────────────────────────
   ARQUITECTURA CORREGIDA:
   1. getUserMedia → stream
   2. Video visible + rAF draw loop INMEDIATAMENTE (nunca bloqueado)
   3. MediaPipe Hands inicializa en background (no bloquea UI)
   4. Una vez listo, los frames se envían a MediaPipe cada N frames
   5. Resultados se aplican al brazo de forma asíncrona

   MAPEO mano → servo (servos de velocidad, salida en SEGUNDOS):
     palmX  → Base   (CH4): izquierda=+s (adelante), derecha=-s (atrás)
     palmY  → Hombro (CH3): arriba=+s, abajo=-s
     palmZ  → Codo   (CH2): cerca=+s (flexión), lejos=-s (extensión)
     orient → Muñeca (CH1): rotación → ±s
     pinch  → Pinza  (CH0): juntos=+s (cerrar), separados=-s (abrir)

   Cada articulación tiene zona muerta en el centro (todo parado).

   Dependencias: shared.js (J, JDEFS, clamp, lerp, batchJoints, log, modal)
   ═══════════════════════════════════════════════ */

/* ─── DOM refs ──────────────────────────────────────────────── */
const camVideo  = document.getElementById('cam-video');
const camCanvas = document.getElementById('cam-canvas');
const camCtx    = camCanvas.getContext('2d');
const poseMapEl = document.getElementById('pose-map');
const pmCtx     = poseMapEl.getContext('2d');

/* ─── Estado ────────────────────────────────────────────────── */
let handInst       = null;
let camActive      = false;
let mpReady        = false;   // MediaPipe inicializado y listo
let mirrorOn       = false;
let selectedDevId  = null;
let _selBound      = false;
let _rafId         = null;    // rAF del draw loop
let _frameCount    = 0;       // Para throttle de MediaPipe (1 de N frames)
const MP_SKIP      = 2;       // Procesar 1 de cada 3 frames con MediaPipe

/* ─── Parámetros ajustables ─────────────────────────────────── */
let SENS_X = 120;
let SENS_Y = 130;
let SENS_Z = 100;
let ALPHA1 = 0.92;   // EMA-1: anti-ruido (MÁS alto = más suave)
let ALPHA2 = 0.95;   // EMA-2: suavidad de movimiento (MÁS alto = más lento)

/* ─── Zona muerta y mapeo a segundos ───────────────────────────
   Cada eje mide distancia desde el centro (0.5 para X/Y).
   Zona muerta amplia → ignora micro-movimientos de la mano.
   El factor por joint se calcula desde maxSecs para respetar el angLim
   (regla de 3: secs = grados_deseados / dps). */
const DEADZONE = 0.20;   // 20 % del ancho → ignora temblores y micro-movimientos
const SPEED_K  = 0.85;   // 85 % de maxSecs en la visión (maxSecs ya es pequeño)
/** delta = desviación del centro (-0.5..+0.5); jointKey da el tope por servo. */
function posToSecs(delta, jointKey) {
  const d = Math.abs(delta);
  if (d < DEADZONE) return 0;
  const t = (d - DEADZONE) / (0.5 - DEADZONE);          // 0..1
  const cap = (J[jointKey]?.maxSecs ?? 1) * SPEED_K;     // máx. segundos seguros
  return Math.sign(delta) * Math.min(1, t) * cap;
}

/* ─── Filtros por articulación ──────────────────────────────── */
const F = {};
JDEFS.forEach(d => { F[d.key] = { e1: d.def, e2: d.def }; });

/* ─── Último resultado de MediaPipe ─────────────────────────── */
let latestHand = null;

/* ─── Rate-limit de envío al brazo (evita congelamiento) ────── */
const ARM_MIN_MS = 100;   // máx 10 Hz al brazo (suficiente para movimiento suave)
let _lastArmUpdate = 0;

/* ─── Toggles overlay ────────────────────────────────────────── */
const CT = { skeleton:true, pinch:true, labels:false, trail:false };
document.querySelectorAll('.ctool').forEach(btn => {
  const MAP = { 'ct-skeleton':'skeleton','ct-pinch':'pinch','ct-labels':'labels','ct-trail':'trail','ct-depth':'depthZ' };
  const k = MAP[btn.id]; if (!k) return;
  CT[k] = btn.classList.contains('active');
  btn.addEventListener('click', () => { CT[k]=!CT[k]; btn.classList.toggle('active',CT[k]); });
});

const TRAIL=[]; const TRAIL_MAX=40;

/* ─── FPS counter ────────────────────────────────────────────── */
let _fpsFrames=0, _fpsLast=performance.now();

/* ─── Utils UI ───────────────────────────────────────────────── */
function _ui(id,v){ const e=document.getElementById(id); if(e&&e.textContent!==String(v)) e.textContent=v; }
function _bar(id,p){ const e=document.getElementById(id); if(e) e.style.width=clamp(p,0,100)+'%'; }

/* ─── Filtro de señal doble EMA ─────────────────────────────── */
function applyFilter(key, raw) {
  // Tope duro por joint (nunca excede maxSecs del servo)
  const cap = J[key]?.maxSecs ?? 10;
  raw = clamp(raw, -cap, cap);
  F[key].e1 = lerp(raw, F[key].e1, ALPHA1);
  F[key].e2 = lerp(F[key].e1, F[key].e2, ALPHA2);
  // Snap-to-zero escalado al joint: ignora <20 % de su maxSecs (micro-movimientos)
  const v = F[key].e2;
  if (Math.abs(v) < cap * 0.20) { F[key].e2 = 0; return 0; }
  return clamp(v, -cap, cap);
}

/* ─── Pinza: distancia pulgar(4)-índice(8) normalizada ─────── */
function pinchOpen(lm) {
  if (!lm||lm.length<21) return null;
  const hl = Math.max(0.001, Math.hypot(lm[0].x-lm[9].x, lm[0].y-lm[9].y));
  return clamp(Math.hypot(lm[4].x-lm[8].x, lm[4].y-lm[8].y)/(hl*2.1), 0, 1);
}

/* ─── Distancia 2D ───────────────────────────────────────────── */
function dist2(a,b){ return Math.hypot(a.x-b.x,a.y-b.y); }

/* ══════════════════════════════════ SELECTOR DE CÁMARA ══════════════════════════════════ */
async function populateCameraList() {
  const sel = document.getElementById('sel-camera'); if(!sel) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const cams = devs.filter(d=>d.kind==='videoinput');
    sel.innerHTML = cams.length
      ? cams.map((c,i)=>`<option value="${c.deviceId}">${c.label||'Cámara '+(i+1)}</option>`).join('')
      : '<option value="">Sin cámaras</option>';
    if (!selectedDevId && cams.length) selectedDevId = cams[0].deviceId;
    if (sel.querySelector(`[value="${selectedDevId}"]`)) sel.value = selectedDevId;
    if (!_selBound && cams.length) {
      sel.addEventListener('change', ()=>{ selectedDevId=sel.value; });
      _selBound=true;
    }
  } catch(e) { console.warn('enumerateDevices:', e); }
}
populateCameraList();
if (navigator.mediaDevices.addEventListener)
  navigator.mediaDevices.addEventListener('devicechange', populateCameraList);

/* ══════════════════════════════════ CALLBACK DE MEDIAPIPE — recibe resultado de cada frame
   ══════════════════════════════════ */
function onHandResults(res) {
  if (!res.multiHandLandmarks?.length) { latestHand=null; return; }
  let best = res.multiHandLandmarks[0];
  res.multiHandedness?.forEach((h,i)=>{ if(h.label==='Right') best=res.multiHandLandmarks[i]; });
  latestHand = best;
}

/* ════════════════════════════════ PROCESAMIENTO DE FRAME — calcula targets y aplica al brazo ════════════════════════════════ */
function processFrame() {
  const lm = latestHand;
  if (!lm) {
    /* Sin mano: mantener posición con inercia (el brazo se queda donde está) */
    _ui('pm-status', 'SIN MANO');
    document.getElementById('pm-status').style.color='var(--err)';
    _ui('p-conf', '0%'); _bar('conf-bar', 0);
    return;
  }

  /* Centro de palma (promedio de nudillos + muñeca) */
  const palmX = (lm[0].x+lm[5].x+lm[9].x+lm[13].x+lm[17].x)/5;
  const palmY = (lm[0].y+lm[5].y+lm[9].y+lm[13].y+lm[17].y)/5;
  const palmZ = (lm[0].z+lm[5].z+lm[9].z)/3;

  /* Confianza estimada por tamaño de mano */
  const sz   = dist2(lm[0], lm[9]);
  const conf = clamp(sz*4.5, 0, 1);

  /* Mapeo posición → SEGUNDOS de velocidad (zona muerta por joint)   */
  const rawBase = posToSecs(0.5 - palmX, 'base');
  const rawSho  = posToSecs(0.5 - palmY, 'sho');
  const zDelta  = -clamp(palmZ, -0.25, 0.25);
  const rawElb  = posToSecs(zDelta * 2, 'elb');
  const handAng = Math.atan2(lm[9].y-lm[0].y, lm[9].x-lm[0].x)*180/Math.PI;
  const rawWri  = posToSecs(clamp(handAng / 180, -0.5, 0.5), 'wri');
  const open    = pinchOpen(lm) ?? 0.5;
  const rawGrip = posToSecs(0.5 - open, 'grip');

  /* Rastro */
  if (CT.trail) { TRAIL.push({x:palmX,y:palmY}); if(TRAIL.length>TRAIL_MAX)TRAIL.shift(); }
  else TRAIL.length=0;

  /* Filtrar siempre (mantiene inercia), pero solo actualizar el brazo a 10 Hz
     máximo — evita saturar serial y congelar la UI con maxSecs pequeños. */
  const fBase = applyFilter('base', rawBase);
  const fSho  = applyFilter('sho',  rawSho);
  const fElb  = applyFilter('elb',  rawElb);
  const fWri  = applyFilter('wri',  rawWri);
  const fGrip = applyFilter('grip', rawGrip);

  const nowMs = performance.now();
  if (nowMs - _lastArmUpdate >= ARM_MIN_MS) {
    _lastArmUpdate = nowMs;
    batchJoints({ base: fBase, sho: fSho, elb: fElb, wri: fWri, grip: fGrip });
  }

  /* UI de telemetría */
  const pct = Math.round(conf*100);
  _ui('p-conf', pct+'%');  _bar('conf-bar', pct);
  _bar('sg-pose', pct);    _ui('sv-pose', pct+'%');
  _ui('p-shy', palmX.toFixed(2));
  _ui('p-shx', palmY.toFixed(2));
  _ui('p-elb', palmZ.toFixed(3));
  _ui('p-wri', handAng.toFixed(0)+'°');
  _ui('p-grip', (open*100).toFixed(0)+'%');
  const sfmt = v => v === 0 ? '■' : (v > 0 ? '+' : '') + v.toFixed(1) + 's';
  _ui('cd-base', sfmt(F.base.e2));
  _ui('cd-sho',  sfmt(F.sho.e2));
  _ui('cd-elb',  sfmt(F.elb.e2));
  _ui('cd-wri',  sfmt(F.wri.e2));
  _ui('cd-grip', sfmt(F.grip.e2));
  const closed=open<0.28;
  _ui('pinch-val', closed?'CERRADO':(open*100).toFixed(0)+'%');
  const pd=document.getElementById('pinch-dot'); if(pd) pd.className=closed?'open':'';
  _bar('sg-grip', open*100);
  _ui('sv-grip2', (open*100).toFixed(0)+'%');
  const pm=document.getElementById('pm-status');
  if(pm){ pm.textContent=conf>0.6?'ÓPTIMO':conf>0.35?'PARCIAL':'DÉBIL'; pm.style.color=conf>0.6?'var(--ok)':conf>0.35?'var(--warn)':'var(--err)'; }
}

/* ═══════════════════════════════════════════════
   DRAW LOOP — siempre activo cuando la cámara está encendida
   Dibuja el video en el canvas y los landmarks encima.
   Se ejecuta con rAF independientemente de MediaPipe.
   ═══════════════════════════════════════════════ */
function drawLoop() {
  if (!camActive) return;
  _rafId = requestAnimationFrame(drawLoop);

  const W = camCanvas.offsetWidth  || 292;
  const H = camCanvas.offsetHeight || 165;
  if (camCanvas.width!==W||camCanvas.height!==H){ camCanvas.width=W; camCanvas.height=H; }

  /* Dibujar video */
  if (camVideo.readyState >= 2) {
    if (mirrorOn) { camCtx.save(); camCtx.scale(-1,1); camCtx.drawImage(camVideo,-W,0,W,H); camCtx.restore(); }
    else           { camCtx.drawImage(camVideo, 0, 0, W, H); }
  }

  /* Overlay landmarks */
  const lm = latestHand;
  if (lm) {
    if (CT.trail && TRAIL.length>1) _drawTrail(W, H);
    if (CT.skeleton)  _drawHand(lm, W, H);
    if (CT.pinch)     _drawPinch(lm, W, H);
    _drawCrossHair(lm, W, H);
  } else {
    /* Sin mano: mensaje */
    camCtx.fillStyle='rgba(253,250,246,0.45)';
    camCtx.font='600 10px IBM Plex Mono,monospace';
    camCtx.textAlign='center';
    camCtx.fillText(mpReady?'Muestre la mano':'Cargando IA…', W/2, H/2);
    camCtx.textAlign='left';
  }

  /* Enviar a MediaPipe (throttled) */
  if (mpReady && handInst && camVideo.readyState>=2) {
    if (_frameCount % (MP_SKIP+1) === 0) {
      handInst.send({ image: camVideo }).catch(()=>{});
      processFrame();
    }
    _frameCount++;
  }

  /* FPS */
  _fpsFrames++;
  const now = performance.now();
  if (now-_fpsLast>900){
    _ui('cam-fps', Math.round(_fpsFrames*1000/(now-_fpsLast))+' fps');
    _fpsFrames=0; _fpsLast=now;
  }

  /* Mapa miniatura */
  _drawHandMap(lm);
}

/* ─── Dibujar rastro ─────────────────────────────────────────── */
function _drawTrail(W,H){
  TRAIL.forEach((p,i)=>{
    if(!i)return;
    camCtx.globalAlpha=(i/TRAIL.length)*0.55;
    camCtx.strokeStyle='#8C1428'; camCtx.lineWidth=1.5+(i/TRAIL.length)*2.5; camCtx.lineCap='round';
    camCtx.beginPath(); camCtx.moveTo(TRAIL[i-1].x*W,TRAIL[i-1].y*H); camCtx.lineTo(p.x*W,p.y*H); camCtx.stroke();
  });
  camCtx.globalAlpha=1;
}

/* ─── Conexiones de la mano ──────────────────────────────────── */
const HAND_CONN=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]];
const FG_COL=['#D4A040','#D4A040','#D4A040','#D4A040','#D4A040','#8C1428','#8C1428','#8C1428','#8C1428','#A07878','#A07878','#A07878','#A07878','#907070','#907070','#907070','#907070','#806068','#806068','#806068','#806068'];

function _drawHand(lm,W,H){
  const x=i=>lm[i].x*W, y=i=>lm[i].y*H;
  HAND_CONN.forEach(([a,b])=>{
    camCtx.globalAlpha=0.70; camCtx.strokeStyle='#907070'; camCtx.lineWidth=1.6; camCtx.lineCap='round';
    camCtx.beginPath(); camCtx.moveTo(x(a),y(a)); camCtx.lineTo(x(b),y(b)); camCtx.stroke();
  });
  camCtx.globalAlpha=1;
  lm.forEach((p,i)=>{
    const px=p.x*W, py=p.y*H;
    const r=(i===4||i===8)?5.5:(i===0)?4.5:2.8;
    const col=FG_COL[i]||'#907878';
    if(i===4||i===8){ camCtx.globalAlpha=0.22; camCtx.beginPath(); camCtx.arc(px,py,9,0,Math.PI*2); camCtx.fillStyle=col; camCtx.fill(); camCtx.globalAlpha=1; }
    camCtx.beginPath(); camCtx.arc(px,py,r,0,Math.PI*2); camCtx.fillStyle=col; camCtx.fill();
    if(i===4||i===8){ camCtx.strokeStyle='rgba(255,255,250,0.88)'; camCtx.lineWidth=1.3; camCtx.beginPath(); camCtx.arc(px,py,r+2.5,0,Math.PI*2); camCtx.stroke(); }
    if(CT.labels&&(i===4||i===8||i===0)) _lbl(px+7,py-5,i===4?'PULGAR':i===8?'ÍNDICE':'',col,W);
  });
}

function _drawPinch(lm,W,H){
  const tx=lm[4].x*W, ty=lm[4].y*H, ix=lm[8].x*W, iy=lm[8].y*H;
  const open=pinchOpen(lm)??0;
  const lc=open<0.25?'#6FBA8A':open<0.55?'#D4A830':'#8C1428';
  camCtx.globalAlpha=clamp(1-open*0.6,0.3,1); camCtx.strokeStyle=lc; camCtx.lineWidth=2.0;
  camCtx.setLineDash([4,3]); camCtx.beginPath(); camCtx.moveTo(tx,ty); camCtx.lineTo(ix,iy); camCtx.stroke();
  camCtx.setLineDash([]); camCtx.globalAlpha=1;
  _lbl((tx+ix)/2+2,(ty+iy)/2-7, open<0.25?'✓ CERRADO':(open*100).toFixed(0)+'% ABIERTO', lc, W);
}

function _drawCrossHair(lm,W,H){
  const px=((lm[0].x+lm[5].x+lm[9].x+lm[13].x+lm[17].x)/5)*W;
  const py=((lm[0].y+lm[5].y+lm[9].y+lm[13].y+lm[17].y)/5)*H;
  const cs=8;
  camCtx.globalAlpha=0.62; camCtx.strokeStyle='#D4A830'; camCtx.lineWidth=1.3;
  camCtx.beginPath(); camCtx.moveTo(px-cs,py); camCtx.lineTo(px+cs,py); camCtx.stroke();
  camCtx.beginPath(); camCtx.moveTo(px,py-cs); camCtx.lineTo(px,py+cs); camCtx.stroke();
  camCtx.globalAlpha=1;
}

function _lbl(x,y,txt,col,W){
  const fs=Math.max(7,Math.round(W*0.032));
  camCtx.font=`600 ${fs}px IBM Plex Mono,monospace`;
  camCtx.strokeStyle='rgba(253,250,246,0.88)'; camCtx.lineWidth=2.2;
  camCtx.strokeText(txt,x,y); camCtx.fillStyle=col; camCtx.fillText(txt,x,y);
}

function _drawHandMap(lm){
  const W=poseMapEl.offsetWidth||260, H=74;
  poseMapEl.width=W; poseMapEl.height=H; pmCtx.clearRect(0,0,W,H);
  if(!lm)return;
  const mx=i=>lm[i].x*W*0.82+W*0.09, my=i=>lm[i].y*H*0.88+H*0.06;
  HAND_CONN.forEach(([a,b])=>{
    pmCtx.globalAlpha=0.60; pmCtx.strokeStyle='#907878'; pmCtx.lineWidth=0.9; pmCtx.lineCap='round';
    pmCtx.beginPath(); pmCtx.moveTo(mx(a),my(a)); pmCtx.lineTo(mx(b),my(b)); pmCtx.stroke();
  });
  lm.forEach((p,i)=>{
    const col=i===4?'#D4A830':i===8?'#8C1428':'#907878';
    pmCtx.globalAlpha=0.82;
    pmCtx.beginPath(); pmCtx.arc(mx(i),my(i),(i===4||i===8)?2.5:1.4,0,Math.PI*2);
    pmCtx.fillStyle=col; pmCtx.fill();
  });
  pmCtx.globalAlpha=1;
}

/* ═══════════════════════════════════════════════
   INICIO DE CÁMARA
   ─────────────────────────────────────────────────────────────
   Orden para evitar bugs:
   1. getUserMedia → stream (puede fallar aquí si no hay permisos)
   2. Asignar al video y esperar metadata
   3. MOSTRAR overlay e iniciar drawLoop rAF INMEDIATAMENTE
   4. Inicializar MediaPipe en background (no bloquea el draw loop)
   ═══════════════════════════════════════════════ */
async function startCam() {
  const btnStart = document.getElementById('btn-cam-start');
  btnStart.textContent = 'Conectando…';
  btnStart.disabled    = true;

  try {
    /* 1. Stream de video */
    const constraints = { video:{
      width:{ideal:640}, height:{ideal:480}, frameRate:{ideal:30},
      ...(selectedDevId ? {deviceId:{exact:selectedDevId}} : {facingMode:'user'}),
    }};
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    camVideo.srcObject  = stream;
    camVideo.muted      = true;
    camVideo.playsInline= true;

    /* Esperar metadata (no esperar canplay — más rápido) */
    await new Promise(resolve => {
      if (camVideo.readyState >= 1) { resolve(); return; }
      camVideo.onloadedmetadata = resolve;
    });
    camVideo.play().catch(()=>{});  /* play no-await para no bloquear */

    /* 2. Activar UI y drawLoop ANTES de inicializar MediaPipe */
    camActive = true;
    _ui('cam-mode-lbl', 'CARGANDO IA…');
    document.getElementById('cam-overlay').style.display    = 'flex';
    document.getElementById('signal-bar').style.display     = 'flex';
    document.getElementById('amp-hud').style.display        = 'flex';
    document.getElementById('st-cam').className             = 'chip on';
    document.getElementById('btn-mirror').disabled          = false;
    document.getElementById('btn-mirror').style.opacity     = '1';
    document.getElementById('ft-mode').textContent          = 'Modo: Control por Mano';
    btnStart.style.display                                   = 'none';
    document.getElementById('btn-cam-stop').style.display   = 'block';
    document.getElementById('btn-overlay-stop').style.display = 'inline-flex';
    log('Cámara conectada — iniciando IA…', 'ok');

    /* Resetear filtros */
    JDEFS.forEach(d=>{ F[d.key].e1=F[d.key].e2=J[d.key].v; });

    /* Iniciar draw loop rAF — el video es visible desde AQUÍ */
    _frameCount=0; _fpsFrames=0; _fpsLast=performance.now();
    drawLoop();

    /* Re-enumerar cámaras con permisos reales */
    populateCameraList();

    /* 3. Inicializar MediaPipe en background (no bloquea el drawLoop) */
    _initMediaPipe();

  } catch(err) {
    btnStart.textContent   = '▶ Iniciar cámara';
    btnStart.disabled      = false;
    btnStart.style.display = 'block';
    document.getElementById('btn-cam-stop').style.display     = 'none';
    document.getElementById('btn-overlay-stop').style.display = 'none';
    document.getElementById('cam-overlay').style.display      = 'none';
    camActive = false;
    log('Error: ' + err.message, 'err');
    modal('Error al acceder a la cámara',
      'No se pudo iniciar la webcam.\n\n' +
      '• Verifica los permisos en el navegador (🔒 en la barra de dirección)\n' +
      '• La cámara puede estar en uso por otra aplicación\n' +
      '• La página debe servirse por HTTPS o localhost\n\n' + err.message);
  }
}

/* Inicializa MediaPipe en background — no bloquea el draw loop */
async function _initMediaPipe() {
  if (typeof Hands === 'undefined') {
    log('MediaPipe Hands no disponible — modo básico activado', 'err');
    _ui('cam-mode-lbl', 'SIN IA');
    return;
  }
  try {
    handInst = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
    handInst.setOptions({
      maxNumHands:            1,
      modelComplexity:        0,   /* 0 = ligero y rápido, 1 = preciso */
      minDetectionConfidence: 0.60,
      minTrackingConfidence:  0.55,
    });
    handInst.onResults(onHandResults);

    /* initialize() descarga los pesos — puede tardar 3-8s */
    await handInst.initialize();

    if (!camActive) return; /* Si se detuvo mientras cargaba */
    mpReady = true;
    document.getElementById('st-hand').className = 'chip on';
    _ui('cam-mode-lbl', 'POSICIÓN MANO');
    log('MediaPipe Hands listo ✓', 'ok');
  } catch(e) {
    log('Error al inicializar IA: ' + e.message, 'err');
    _ui('cam-mode-lbl', 'ERROR IA');
  }
}

/* ─── Parar cámara ───────────────────────────────────────────── */
function stopCam() {
  camActive = false;
  mpReady   = false;
  latestHand= null;

  if (_rafId) { cancelAnimationFrame(_rafId); _rafId=null; }
  if (handInst) { try{handInst.close();}catch(e){} handInst=null; }
  if (camVideo.srcObject) { camVideo.srcObject.getTracks().forEach(t=>t.stop()); camVideo.srcObject=null; }

  TRAIL.length=0;
  camCtx.clearRect(0,0,camCanvas.width,camCanvas.height);
  pmCtx.clearRect(0,0,poseMapEl.width,poseMapEl.height);

  document.getElementById('cam-overlay').style.display    = 'none';
  document.getElementById('signal-bar').style.display     = 'none';
  document.getElementById('amp-hud').style.display        = 'none';
  ['st-cam','st-hand'].forEach(id=>document.getElementById(id).className='chip');

  const bs=document.getElementById('btn-cam-start');
  bs.textContent='▶ Iniciar cámara'; bs.disabled=false; bs.style.display='block';
  document.getElementById('btn-cam-stop').style.display    = 'none';
  document.getElementById('btn-overlay-stop').style.display = 'none';
  document.getElementById('btn-mirror').disabled = true;
  document.getElementById('btn-mirror').style.opacity = '.4';
  document.getElementById('ft-mode').textContent = 'Modo: Manual';
  log('Cámara detenida', 'info');
}

/* ─── Listeners de controles ─────────────────────────────────── */
document.getElementById('btn-cam-start').addEventListener('click', startCam);
document.getElementById('btn-cam-stop').addEventListener('click', stopCam);
document.getElementById('btn-overlay-stop').addEventListener('click', stopCam);

document.getElementById('btn-mirror').addEventListener('click', function(){
  mirrorOn=!mirrorOn; this.textContent=mirrorOn?'⇔ Espejo: ON':'⇔ Espejo';
});

document.getElementById('sl-sens-x').addEventListener('input',function(){ SENS_X=parseFloat(this.value); _ui('lv-sens-x',SENS_X+'°'); });
document.getElementById('sl-sens-y').addEventListener('input',function(){ SENS_Y=parseFloat(this.value); _ui('lv-sens-y',SENS_Y+'°'); });
document.getElementById('sl-sens-z').addEventListener('input',function(){ SENS_Z=parseFloat(this.value); _ui('lv-sens-z',SENS_Z+'°'); });
document.getElementById('sl-smooth').addEventListener('input',function(){ ALPHA2=parseFloat(this.value); _ui('lv-smooth',ALPHA2.toFixed(2)); });
document.getElementById('sl-smooth2').addEventListener('input',function(){ ALPHA1=parseFloat(this.value); _ui('lv-smooth2',ALPHA1.toFixed(2)); });

/* ══════════════════════════════════ OVERLAY ARRASTRABLE ══════════════════════════════════ */
(function(){
  const ov=document.getElementById('cam-overlay');
  const hdr=document.getElementById('cam-hdr');
  const btnMin=document.getElementById('btn-cam-minimize');
  const btnSnap=document.getElementById('btn-cam-snap');
  const btnStop=document.getElementById('btn-overlay-stop');
  let drag=false,ox=0,oy=0,snapped=true,si=0;
  const SNAPS=['bl','br','tl','tr'];

  function snapTo(s){
    const ow=ov.offsetWidth,oh=ov.offsetHeight,pad=14,vw=window.innerWidth,vh=window.innerHeight;
    const map={bl:[pad,vh-oh-pad-34],br:[vw-ow-pad,vh-oh-pad-34],tl:[pad,56+pad],tr:[vw-ow-pad,56+pad]};
    const [l,t]=map[s]||[pad,vh-oh-pad-34];
    Object.assign(ov.style,{left:l+'px',top:t+'px',bottom:'auto',right:'auto'});
  }
  const isCtrl=e=>e===btnMin||e===btnSnap||e===btnStop;
  function startD(cx,cy){drag=true;snapped=false;const r=ov.getBoundingClientRect();ox=cx-r.left;oy=cy-r.top;ov.classList.add('dragging');hdr.style.cursor='grabbing';}
  function moveD(cx,cy){if(!drag)return;ov.style.left=clamp(cx-ox,0,innerWidth-ov.offsetWidth)+'px';ov.style.top=clamp(cy-oy,0,innerHeight-ov.offsetHeight)+'px';ov.style.bottom='auto';ov.style.right='auto';}
  function endD(){drag=false;ov.classList.remove('dragging');hdr.style.cursor='grab';}

  hdr.addEventListener('mousedown',e=>{if(!isCtrl(e.target)){startD(e.clientX,e.clientY);e.preventDefault();}});
  document.addEventListener('mousemove',e=>moveD(e.clientX,e.clientY));
  document.addEventListener('mouseup',endD);
  hdr.addEventListener('touchstart',e=>{if(!isCtrl(e.target))startD(e.touches[0].clientX,e.touches[0].clientY);},{passive:true});
  document.addEventListener('touchmove',e=>{if(drag)moveD(e.touches[0].clientX,e.touches[0].clientY);},{passive:true});
  document.addEventListener('touchend',endD);

  btnMin.addEventListener('click',()=>{const m=ov.classList.toggle('minimized');btnMin.textContent=m?'+':'—';btnMin.title=m?'Restaurar':'Minimizar';});
  btnSnap.addEventListener('click',()=>{si=(si+1)%SNAPS.length;snapped=true;snapTo(SNAPS[si]);});
  window.addEventListener('resize',()=>{if(snapped)snapTo(SNAPS[si]);});
})();
