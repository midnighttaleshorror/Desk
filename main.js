const { app, BrowserWindow, ipcMain, desktopCapturer, powerSaveBlocker, dialog, clipboard } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

let ps = null, blocker = null, win = null;
const handles = new Map();
let hid = 0;

// Small PowerShell script for mouse/keyboard control (works on Windows 7/10/11, nothing extra to install)
const PS = String.raw`Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DW {
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
"@
[void][DW]::SetProcessDPIAware()
$W=[DW]::GetSystemMetrics(0); $H=[DW]::GetSystemMetrics(1)
$ext=@(33,34,35,36,37,38,39,40,45,46,91,92,93,111,163,165)
while(($line=[Console]::In.ReadLine()) -ne $null){
 try{
  $p=$line.Split(' ')
  if($p[0] -eq 'M'){ [void][DW]::SetCursorPos([int]([double]$p[1]*$W),[int]([double]$p[2]*$H)) }
  elseif($p[0] -eq 'B'){ [DW]::mouse_event([uint32]$p[1],0,0,0,[UIntPtr]::Zero) }
  elseif($p[0] -eq 'W'){ [DW]::mouse_event(2048,0,0,[int]$p[1],[UIntPtr]::Zero) }
  elseif($p[0] -eq 'K'){ $vk=[int]$p[1]; $f=0; if($p[2] -eq '0'){$f=2}; if($ext -contains $vk){$f=$f -bor 1}; [DW]::keybd_event([byte]$vk,0,$f,[UIntPtr]::Zero) }
 }catch{}
}
`;

function startPS() {
  if (ps) return;
  const f = path.join(os.tmpdir(), 'deskwork-input.ps1');
  fs.writeFileSync(f, PS);
  ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { windowsHide: true });
  ps.on('exit', () => { ps = null; });
  ps.stdin.on('error', () => {});
}
function stopPS() { if (ps) { ps.kill(); ps = null; } }

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 980, height: 680, autoHideMenuBar: true, title: 'Deskwork',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.loadFile('index.html');
});

ipcMain.handle('screen-id', async () => {
  const s = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  return s[0].id;
});
ipcMain.on('host-start', () => {
  startPS();
  if (blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension'); // keep the office PC from sleeping
});
ipcMain.on('host-stop', () => {
  stopPS();
  if (blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
});
ipcMain.on('input', (e, line) => {
  if (typeof line === 'string' && /^[MBWK][ 0-9.\-]{1,40}$/.test(line) && ps && ps.stdin.writable) ps.stdin.write(line + '\n');
});

// ---- File transfer, clipboard, notifications ----
function uniq(dir, name) {
  if (!dir) dir = path.join(app.getPath('downloads'), 'Deskwork');
  fs.mkdirSync(dir, { recursive: true });
  const b = path.basename(String(name)), ext = path.extname(b), stem = path.basename(b, ext);
  let p = path.join(dir, b), n = 1;
  while (fs.existsSync(p)) p = path.join(dir, stem + ' (' + (n++) + ')' + ext);
  return p;
}
ipcMain.handle('fs-uniq', (e, dir, name) => uniq(dir, name));
ipcMain.handle('fs-size', async (e, p) => { try { return (await fs.promises.stat(String(p))).size; } catch (err) { return -1; } });
ipcMain.handle('fs-list', async (e, p) => {
  try {
    if (!p) {
      const items = [];
      'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').forEach((l) => { if (fs.existsSync(l + ':\\')) items.push({ n: l + ':\\', d: true, s: 0 }); });
      return { path: '', items };
    }
    const ents = await fs.promises.readdir(p, { withFileTypes: true });
    const items = [];
    for (const d of ents.slice(0, 3000)) {
      let s = 0;
      if (!d.isDirectory()) { try { s = (await fs.promises.stat(path.join(p, d.name))).size; } catch (err) {} }
      items.push({ n: d.name, d: d.isDirectory(), s });
    }
    items.sort((a, b) => (b.d - a.d) || a.n.toLowerCase().localeCompare(b.n.toLowerCase()));
    return { path: p, items };
  } catch (err) { return { path: p, items: [], error: err.message }; }
});
ipcMain.handle('fh-open', async (e, p, mode) => { const h = await fs.promises.open(String(p), mode === 'w' ? 'w' : 'r'); handles.set(++hid, h); return hid; });
ipcMain.handle('fh-read', async (e, id, n) => {
  const h = handles.get(id), b = Buffer.alloc(n), r = await h.read(b, 0, n, null);
  return b.subarray(0, r.bytesRead);
});
ipcMain.handle('fh-write', async (e, id, b) => { await handles.get(id).write(b); return true; });
ipcMain.handle('fh-close', async (e, id) => { const h = handles.get(id); if (h) { handles.delete(id); await h.close(); } return true; });
ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  return r.canceled ? '' : r.filePaths[0];
});
ipcMain.handle('clip-read', () => clipboard.readText());
ipcMain.handle('clip-write', (e, t) => { clipboard.writeText(String(t).slice(0, 1000000)); return true; });
ipcMain.on('notify', () => { if (win) { win.show(); win.focus(); win.flashFrame(true); } });

app.on('window-all-closed', () => { stopPS(); app.quit(); });
