const $ = (id) => document.getElementById(id);
const st = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const send = (ws, d) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(d)); };
const say = (id, t) => { $(id).textContent = t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK = 65536;
const fmt = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');
const base = (p) => String(p).split(/[\\/]/).pop();

function addChat(log, who, text) {
  const d = document.createElement('div'), b = document.createElement('b');
  b.textContent = who + ': ';
  d.appendChild(b); d.appendChild(document.createTextNode(text));
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}

/* ---- file transfer helpers (used by both sides) ---- */
async function sendFile(dc, filePath, size, onProg) {
  const id = await dw.open(filePath, 'r');
  let sent = 0;
  try {
    for (;;) {
      const b = await dw.read(id, CHUNK);
      if (!b || !b.length) break;
      while (dc.bufferedAmount > 1048576) await sleep(15);
      if (dc.readyState !== 'open') throw new Error('Connection closed');
      dc.send(b);
      sent += b.length;
      onProg(sent, size);
    }
  } finally { await dw.close(id); }
}
async function rxStart(name, dir, size) {
  const p = await dw.uniq(dir, name);
  return { id: await dw.open(p, 'w'), path: p, size, got: 0 };
}
async function rxChunk(rx, buf) { const u = new Uint8Array(buf); await dw.write(rx.id, u); rx.got += u.length; }
async function rxEnd(rx) { await dw.close(rx.id); }

$('server').value = st.get('server');
$('hPass').value = st.get('hPass');
$('vId').value = st.get('vId');

document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
    $('host').hidden = b.dataset.t !== 'host';
    $('viewer').hidden = b.dataset.t !== 'viewer';
  };
});

/* ================= HOST (office PC) ================= */
let hws = null, hpc = null, hdc = null, hstream = null, hrx = null, hq = Promise.resolve();
const pressed = new Set();
const BTN = [2, 4, 8, 16, 32, 64];
const perms = { control: true, files: true, clip: true };
const hsend = (m) => { if (hdc && hdc.readyState === 'open') hdc.send(JSON.stringify(m)); };

['control', 'files', 'clip'].forEach((k) => {
  const v = st.get('perm_' + k);
  if (v) perms[k] = v === '1';
  $('p_' + k).checked = perms[k];
  $('p_' + k).onchange = () => {
    perms[k] = $('p_' + k).checked;
    st.set('perm_' + k, perms[k] ? '1' : '0');
    hsend(Object.assign({ t: 'perm' }, perms));
  };
});
$('hAsk').checked = st.get('hAsk') !== '0';
$('hAsk').onchange = () => st.set('hAsk', $('hAsk').checked ? '1' : '0');

function releaseAll() {
  pressed.forEach((vk) => dw.input('K ' + vk + ' 0'));
  pressed.clear();
}
function hClose() {
  if (hpc) { hpc.close(); hpc = null; }
  hdc = null;
  if (hrx) { dw.close(hrx.id); hrx = null; }
  releaseAll();
  $('hSess').hidden = true;
  $('prompt').hidden = true;
}
function hStop() {
  hClose();
  if (hws) { hws.onclose = null; hws.close(); hws = null; }
  if (hstream) { hstream.getTracks().forEach((t) => t.stop()); hstream = null; }
  dw.hostStop();
  $('hStart').textContent = 'Start sharing';
  $('hStart').classList.remove('stop');
  $('hId').textContent = '';
}

function hInput(m) {
  if (!perms.control) return;
  const n = (v) => Number(v);
  if (m.t === 'm' && isFinite(n(m.x)) && isFinite(n(m.y))) {
    const x = Math.min(1, Math.max(0, n(m.x))), y = Math.min(1, Math.max(0, n(m.y)));
    dw.input('M ' + x.toFixed(4) + ' ' + y.toFixed(4));
  } else if (m.t === 'b' && BTN.indexOf(n(m.f)) >= 0) {
    dw.input('B ' + n(m.f));
  } else if (m.t === 'w' && isFinite(n(m.d))) {
    dw.input('W ' + Math.round(Math.max(-1200, Math.min(1200, n(m.d)))));
  } else if (m.t === 'k' && n(m.vk) > 0 && n(m.vk) < 255) {
    const vk = Math.round(n(m.vk));
    if (m.d) pressed.add(vk); else pressed.delete(vk);
    dw.input('K ' + vk + ' ' + (m.d ? 1 : 0));
  }
}

async function startGet(m) {
  if (!perms.files) return hsend({ t: 'get-err', msg: 'File transfer is not allowed by the host' });
  const size = await dw.size(m.path);
  if (size < 0) return hsend({ t: 'get-err', msg: 'Cannot read this file' });
  const name = base(m.path);
  hsend({ t: 'get-start', name, size });
  try {
    await sendFile(hdc, m.path, size, (a, b) => say('hXfer', 'Sending ' + name + ': ' + fmt(a) + ' / ' + fmt(b)));
    hsend({ t: 'get-end' });
    say('hXfer', 'Sent ' + name);
  } catch (e) { say('hXfer', 'Transfer failed: ' + e.message); }
}

async function hHandle(data) {
  if (typeof data !== 'string') {
    if (hrx) { await rxChunk(hrx, data); say('hXfer', 'Receiving ' + base(hrx.path) + ': ' + fmt(hrx.got) + ' / ' + fmt(hrx.size)); }
    return;
  }
  const m = JSON.parse(data);
  if (m.t === 'm' || m.t === 'b' || m.t === 'w' || m.t === 'k') return hInput(m);
  if (m.t === 'chat') { addChat($('hLog'), 'Viewer', String(m.text)); dw.notify(); }
  else if (m.t === 'ls') {
    if (!perms.files) return hsend({ t: 'ls-res', path: m.path, items: [], error: 'File transfer is not allowed by the host' });
    hsend(Object.assign({ t: 'ls-res' }, await dw.list(String(m.path || ''))));
  } else if (m.t === 'get') startGet(m);
  else if (m.t === 'put') {
    if (!perms.files) return hsend({ t: 'put-err', msg: 'File transfer is not allowed by the host' });
    try { hrx = await rxStart(m.name, String(m.dir || ''), Number(m.size) || 0); }
    catch (e) { hrx = null; hsend({ t: 'put-err', msg: e.message }); }
  } else if (m.t === 'put-end') {
    if (hrx) { await rxEnd(hrx); say('hXfer', 'Received ' + hrx.path); hsend({ t: 'put-ok', path: hrx.path }); hrx = null; }
  } else if (m.t === 'clip-set' && perms.clip) await dw.clipWrite(String(m.text || ''));
  else if (m.t === 'clip-get' && perms.clip) hsend({ t: 'clip', text: await dw.clipRead() });
}

async function hOffer() {
  hClose();
  hpc = new RTCPeerConnection(ICE);
  hstream.getTracks().forEach((t) => hpc.addTrack(t, hstream));
  hdc = hpc.createDataChannel('input');
  hdc.binaryType = 'arraybuffer';
  hdc.onopen = () => {
    hsend(Object.assign({ t: 'perm' }, perms));
    $('hLog').textContent = '';
    say('hXfer', '');
    $('hSess').hidden = false;
  };
  hdc.onmessage = (e) => { hq = hq.then(() => hHandle(e.data)).catch(() => {}); };
  hdc.onclose = releaseAll;
  hpc.onicecandidate = (e) => { if (e.candidate) send(hws, { type: 'signal', data: { c: e.candidate } }); };
  hpc.onconnectionstatechange = () => {
    const s = hpc && hpc.connectionState;
    if (s === 'connected') say('hMsg', 'Viewer connected');
    if (s === 'failed') { say('hMsg', 'Connection failed'); hClose(); }
  };
  const offer = await hpc.createOffer();
  await hpc.setLocalDescription(offer);
  send(hws, { type: 'signal', data: { sdp: hpc.localDescription } });
  try {
    const s = hpc.getSenders()[0];
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 4000000;
    await s.setParameters(p);
  } catch (e) {}
}

async function hSignal(d) {
  if (!hpc) return;
  if (d.sdp) await hpc.setRemoteDescription(d.sdp);
  else if (d.c) await hpc.addIceCandidate(d.c);
}

$('hAccept').onclick = () => { $('prompt').hidden = true; hOffer(); };
$('hDeny').onclick = () => {
  $('prompt').hidden = true;
  send(hws, { type: 'signal', data: { denied: true } });
  say('hMsg', 'Connection denied');
};
$('hDisc').onclick = () => { send(hws, { type: 'signal', data: { bye: true } }); hClose(); say('hMsg', 'Viewer disconnected'); };
$('hChatIn').onkeydown = (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  hsend({ t: 'chat', text: e.target.value });
  addChat($('hLog'), 'You', e.target.value);
  e.target.value = '';
};

$('hStart').onclick = async () => {
  if (hws) return hStop();
  const pass = $('hPass').value, url = $('server').value.trim();
  if (pass.length < 6) return say('hMsg', 'Password must be at least 6 characters');
  if (!url) return say('hMsg', 'Enter the server address');
  st.set('server', url); st.set('hPass', pass);
  try {
    hstream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: await dw.screenId(), maxFrameRate: 30 } }
    });
  } catch (e) { return say('hMsg', 'Could not start screen capture'); }
  hstream.getVideoTracks()[0].contentHint = 'detail';
  dw.hostStart();
  say('hMsg', 'Connecting to server...');
  hws = new WebSocket(url);
  hws.onopen = () => send(hws, { type: 'register', id: st.get('hId'), pass });
  hws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'registered') {
      st.set('hId', m.id);
      $('hId').textContent = m.id.replace(/(\d{3})(?=\d)/g, '$1 ');
      $('hStart').textContent = 'Stop';
      $('hStart').classList.add('stop');
      say('hMsg', 'Ready. Enter this ID and password on your home PC.');
    } else if (m.type === 'error') say('hMsg', m.message);
    else if (m.type === 'viewer-joined') {
      if ($('hAsk').checked) { $('prompt').hidden = false; dw.notify(); say('hMsg', 'A viewer is waiting for your permission'); }
      else await hOffer();
    } else if (m.type === 'viewer-left') { hClose(); say('hMsg', 'Viewer disconnected'); }
    else if (m.type === 'signal') await hSignal(m.data);
  };
  hws.onclose = () => { hStop(); say('hMsg', 'Disconnected from server'); };
};

/* ================= VIEWER (home PC) ================= */
let vws = null, vpc = null, vdc = null, vrx = null, vq = Promise.resolve(), vpath = '';
let vperm = { control: true, files: true, clip: true };
const vid = $('vid'), stage = $('stage');

const VK = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163,
  AltLeft: 164, AltRight: 165, Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44, Insert: 45, Delete: 46, MetaLeft: 91,
  MetaRight: 92, ContextMenu: 93, NumLock: 144, ScrollLock: 145, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189,
  Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111
};
for (let i = 0; i < 26; i++) VK['Key' + String.fromCharCode(65 + i)] = 65 + i;
for (let i = 0; i < 10; i++) { VK['Digit' + i] = 48 + i; VK['Numpad' + i] = 96 + i; }
for (let i = 1; i <= 12; i++) VK['F' + i] = 111 + i;

const vSend = (m) => { if (vdc && vdc.readyState === 'open') vdc.send(JSON.stringify(m)); };

function vClose(msg) {
  if (vpc) { vpc.close(); vpc = null; }
  if (vws) { vws.onclose = null; vws.close(); vws = null; }
  if (vrx) { dw.close(vrx.id); vrx = null; }
  vdc = null; vpath = '';
  vid.srcObject = null;
  stage.hidden = true;
  $('side').hidden = true;
  $('vForm').hidden = false;
  if (document.fullscreenElement) document.exitFullscreen();
  if (msg) say('vMsg', msg);
}

function parentOf(p) {
  if (/^[A-Za-z]:\\?$/.test(p)) return '';
  const i = p.replace(/[\\/]+$/, '').lastIndexOf('\\');
  return i <= 2 ? p.slice(0, 3) : p.slice(0, i);
}
const joinPath = (p, n) => (p.endsWith('\\') ? p + n : p + '\\' + n);
const vList = (p) => vSend({ t: 'ls', path: p });

function showList(m) {
  vpath = m.path || '';
  $('fPath').textContent = vpath || 'This PC';
  if (m.error) say('fStatus', m.error);
  const box = $('fList');
  box.textContent = '';
  const row = (label, size, fn) => {
    const d = document.createElement('div');
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = label; b.textContent = size;
    d.appendChild(a); d.appendChild(b); d.onclick = fn; box.appendChild(d);
  };
  if (vpath) row('[..]', '', () => vList(parentOf(vpath)));
  (m.items || []).forEach((it) => {
    if (it.d) row('[' + it.n + ']', '', () => vList(joinPath(vpath, it.n)));
    else row(it.n, fmt(it.s), () => { say('fStatus', 'Requesting ' + it.n + '...'); vSend({ t: 'get', path: joinPath(vpath, it.n) }); });
  });
}

async function vHandle(data) {
  if (typeof data !== 'string') {
    if (vrx) { await rxChunk(vrx, data); say('fStatus', 'Downloading ' + base(vrx.path) + ': ' + fmt(vrx.got) + ' / ' + fmt(vrx.size)); }
    return;
  }
  const m = JSON.parse(data);
  if (m.t === 'perm') {
    vperm = { control: !!m.control, files: !!m.files, clip: !!m.clip };
    const o = (v) => (v ? 'on' : 'off');
    say('permInfo', 'Host allows: control ' + o(vperm.control) + ', files ' + o(vperm.files) + ', clipboard ' + o(vperm.clip));
  } else if (m.t === 'chat') addChat($('vLog'), 'Host', String(m.text));
  else if (m.t === 'ls-res') showList(m);
  else if (m.t === 'get-start') {
    try { vrx = await rxStart(m.name, '', Number(m.size) || 0); } catch (e) { vrx = null; say('fStatus', e.message); }
  } else if (m.t === 'get-end') {
    if (vrx) { await rxEnd(vrx); say('fStatus', 'Saved to ' + vrx.path); vrx = null; }
  } else if (m.t === 'get-err' || m.t === 'put-err') say('fStatus', m.msg || 'Transfer failed');
  else if (m.t === 'put-ok') { say('fStatus', 'Uploaded: ' + m.path); vList(vpath); }
  else if (m.t === 'clip') {
    try { await navigator.clipboard.writeText(String(m.text || '')); say('fStatus', 'Remote clipboard copied'); } catch (e) {}
  }
}

function makePC() {
  vpc = new RTCPeerConnection(ICE);
  vpc.ontrack = (e) => { vid.srcObject = e.streams[0]; $('vForm').hidden = true; stage.hidden = false; stage.focus(); };
  vpc.ondatachannel = (e) => {
    vdc = e.channel;
    vdc.binaryType = 'arraybuffer';
    vdc.onmessage = (ev) => { vq = vq.then(() => vHandle(ev.data)).catch(() => {}); };
  };
  vpc.onicecandidate = (e) => { if (e.candidate) send(vws, { type: 'signal', data: { c: e.candidate } }); };
  vpc.onconnectionstatechange = () => {
    if (vpc && (vpc.connectionState === 'failed' || vpc.connectionState === 'disconnected')) vClose('Connection lost');
  };
}

async function vSignal(d) {
  if (d.denied) return vClose('The host denied the connection');
  if (d.bye) return vClose('The host ended the session');
  if (d.sdp) {
    if (!vpc) makePC();
    await vpc.setRemoteDescription(d.sdp);
    if (d.sdp.type === 'offer') {
      const a = await vpc.createAnswer();
      await vpc.setLocalDescription(a);
      send(vws, { type: 'signal', data: { sdp: vpc.localDescription } });
    }
  } else if (d.c && vpc) await vpc.addIceCandidate(d.c);
}

$('vConnect').onclick = () => {
  const url = $('server').value.trim(), id = $('vId').value.replace(/\s/g, ''), pass = $('vPass').value;
  if (!url || !id || !pass) return say('vMsg', 'Enter server, ID and password');
  st.set('server', url); st.set('vId', id);
  say('vMsg', 'Connecting...');
  vws = new WebSocket(url);
  vws.onopen = () => send(vws, { type: 'join', id, pass });
  vws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'joined') say('vMsg', 'Waiting for the host to accept...');
    else if (m.type === 'error') vClose(m.message);
    else if (m.type === 'signal') await vSignal(m.data);
    else if (m.type === 'host-left') vClose('The office PC has stopped sharing');
  };
  vws.onerror = () => say('vMsg', 'Could not reach the server');
  vws.onclose = () => { if (vws) vClose('Disconnected from server'); };
};
$('vStop').onclick = () => vClose('');
$('vFull').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen(); };

/* side panel: chat, files, clipboard */
$('vSideBtn').onclick = () => { $('side').hidden = !$('side').hidden; };
$('tabC').onclick = () => { $('tChat').hidden = false; $('tFiles').hidden = true; $('tabC').classList.add('on'); $('tabF').classList.remove('on'); };
$('tabF').onclick = () => { $('tChat').hidden = true; $('tFiles').hidden = false; $('tabF').classList.add('on'); $('tabC').classList.remove('on'); vList(vpath); };
$('vChatIn').onkeydown = (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  vSend({ t: 'chat', text: e.target.value });
  addChat($('vLog'), 'You', e.target.value);
  e.target.value = '';
};
$('fUp').onclick = async () => {
  if (!vpath) return say('fStatus', 'Open a folder on the remote PC first');
  if (!vperm.files) return say('fStatus', 'File transfer is not allowed by the host');
  const lp = await dw.pick();
  if (!lp) return;
  const size = await dw.size(lp), name = base(lp);
  vSend({ t: 'put', dir: vpath, name, size });
  try {
    await sendFile(vdc, lp, size, (a, b) => say('fStatus', 'Uploading ' + name + ': ' + fmt(a) + ' / ' + fmt(b)));
    vSend({ t: 'put-end' });
  } catch (e) { say('fStatus', 'Upload failed: ' + e.message); }
};
$('cSend').onclick = async () => {
  if (!vperm.clip) return say('fStatus', 'Clipboard is not allowed by the host');
  try { vSend({ t: 'clip-set', text: await navigator.clipboard.readText() }); say('fStatus', 'Clipboard sent to remote PC'); }
  catch (e) { say('fStatus', 'Could not read your clipboard'); }
};
$('cGet').onclick = () => {
  if (!vperm.clip) return say('fStatus', 'Clipboard is not allowed by the host');
  vSend({ t: 'clip-get' });
};

/* mouse and keyboard */
function pos(e) {
  const r = vid.getBoundingClientRect(), vw = vid.videoWidth, vh = vid.videoHeight;
  if (!vw || !vh) return null;
  const s = Math.min(r.width / vw, r.height / vh), dw_ = vw * s, dh = vh * s;
  const x = (e.clientX - r.left - (r.width - dw_) / 2) / dw_, y = (e.clientY - r.top - (r.height - dh) / 2) / dh;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
let lastMove = 0;
vid.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastMove < 16) return;
  lastMove = now;
  const p = pos(e); if (p) vSend({ t: 'm', x: p.x, y: p.y });
});
const DOWN = { 0: 2, 1: 32, 2: 8 }, UP = { 0: 4, 1: 64, 2: 16 };
vid.addEventListener('mousedown', (e) => {
  stage.focus();
  const p = pos(e); if (p) vSend({ t: 'm', x: p.x, y: p.y });
  vSend({ t: 'b', f: DOWN[e.button] }); e.preventDefault();
});
vid.addEventListener('mouseup', (e) => { vSend({ t: 'b', f: UP[e.button] }); e.preventDefault(); });
vid.addEventListener('wheel', (e) => { vSend({ t: 'w', d: -e.deltaY }); e.preventDefault(); }, { passive: false });
vid.addEventListener('contextmenu', (e) => e.preventDefault());
const typing = (e) => e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
stage.addEventListener('keydown', (e) => { if (typing(e)) return; const vk = VK[e.code]; if (vk) { vSend({ t: 'k', vk, d: 1 }); e.preventDefault(); } });
stage.addEventListener('keyup', (e) => { if (typing(e)) return; const vk = VK[e.code]; if (vk) { vSend({ t: 'k', vk, d: 0 }); e.preventDefault(); } });
