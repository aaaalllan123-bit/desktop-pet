const { app, BrowserWindow, screen, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ---------- constants ----------
const WIN_W = 240;
const WIN_H = 260;
const TICK_MS = 33;
const GRAVITY = 1.2;
const SLEEP_AFTER_MS = 90_000;
const IMG_EXT = /\.(png|gif|jpe?g|webp|svg|apng|webm|mp4|mov|m4v)$/i; // pictures and videos
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac|aac)$/i;
const DEFAULT_LINES = ['Hi there!', 'Hehe~', 'Play with me!', "What're you working on?", 'Snack time?', '♪ la la la ♪'];

// ---------- state ----------
let win;
let characters = [];
let current = 0;
let musicPlaying = false;
const settings = { character: null, volume: 0.6, walking: true, chase: false };

const pet = {
  x: 0, y: 0, vx: 0, vy: 0, dir: 1,
  mode: 'idle', timer: 60, airborne: false,
  press: null, dragging: false,
  lastInteraction: Date.now(), lastSent: '', lastPos: '',
};

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch {}
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

// ---------- characters ----------
const bundledCharDir = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'characters') : path.join(__dirname, 'characters');
const userCharDir = () => path.join(app.getPath('userData'), 'characters');

function readCharacter(dir, folderName) {
  let cfg = {};
  const cfgPath = path.join(dir, 'character.json');
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (err) { console.warn(`Bad character.json in ${dir}: ${err.message}`); return null; }
  }
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  const url = (f) => pathToFileURL(path.join(dir, f)).href;

  // Images: explicit map in character.json, or files named after a mode (idle.png, walk.gif, sleep.png ...)
  const images = {};
  if (cfg.images) for (const [mode, file] of Object.entries(cfg.images)) images[mode] = url(file);
  if (cfg.image) images.idle ??= url(cfg.image);
  for (const f of files) {
    if (IMG_EXT.test(f)) {
      const mode = path.parse(f).name.toLowerCase();
      images[mode] ??= url(f);
    }
  }
  if (!images.idle) {
    const first = files.find((f) => IMG_EXT.test(f));
    if (!first) return null; // no picture = not a character
    images.idle = url(first);
  }

  const musicFiles = cfg.music ?? files.filter((f) => AUDIO_EXT.test(f)).sort();
  const music = musicFiles.map((f) => ({ name: path.parse(f).name, url: url(f) }));

  return {
    name: cfg.name || folderName,
    images,
    music,
    lines: Array.isArray(cfg.lines) && cfg.lines.length ? cfg.lines : DEFAULT_LINES,
    size: cfg.size || 140,
    speed: cfg.speed || 2,
    chromaKey: cfg.chromaKey || null,          // e.g. "#00ff00" to remove a green-screen background
    chromaTolerance: cfg.chromaTolerance ?? 0.3,
  };
}

function loadCharacters() {
  fs.mkdirSync(userCharDir(), { recursive: true });
  const list = [];
  for (const root of [bundledCharDir(), userCharDir()]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const c = readCharacter(path.join(root, e.name), e.name);
      if (c) list.push(c);
    }
  }
  return list;
}

const char = () => characters[current];

function sendCharacter() {
  if (!win || !char()) return;
  win.webContents.send('character', { ...char(), volume: settings.volume });
  pet.lastSent = '';
}

function switchCharacter(i) {
  current = i;
  settings.character = char().name;
  saveSettings();
  sendCharacter();
  say(`I'm ${char().name}!`);
}

function reloadCharacters() {
  const name = char()?.name;
  characters = loadCharacters();
  current = Math.max(0, characters.findIndex((c) => c.name === name));
  sendCharacter();
  say(`${characters.length} friends loaded!`);
}

// ---------- behaviour ----------
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
const say = (text) => send('say', text);

function setMode(m) { pet.mode = m; }

function poke() {
  pet.lastInteraction = Date.now();
  if (pet.mode === 'sleep') { setMode('idle'); pet.timer = 40; say('*yawn*'); }
}

function hop(strength = 9) { pet.vy = -strength; pet.airborne = true; }

function behave(cur, minX, maxX) {
  const c = char();
  if (pet.mode === 'walk') {
    pet.x += pet.dir * c.speed;
    if (pet.x <= minX) { pet.x = minX; pet.dir = 1; }
    if (pet.x >= maxX) { pet.x = maxX; pet.dir = -1; }
  }
  if (--pet.timer > 0) return;

  if (settings.chase && pet.mode !== 'sleep') {
    const dx = cur.x - WIN_W / 2 - pet.x;
    if (Math.abs(dx) > 30) { pet.dir = Math.sign(dx); setMode('walk'); pet.timer = 1; }
    else { setMode('idle'); pet.timer = 10; }
    return;
  }

  if (Date.now() - pet.lastInteraction > SLEEP_AFTER_MS && !musicPlaying) {
    setMode('sleep'); pet.timer = 300; return;
  }
  if (musicPlaying) {
    if (Math.random() < 0.75) setMode('dance');
    else { setMode('walk'); pet.dir = Math.random() < 0.5 ? -1 : 1; }
    pet.timer = rand(60, 150);
    return;
  }
  const r = Math.random();
  if (settings.walking && r < 0.45) {
    pet.dir = Math.random() < 0.5 ? -1 : 1; setMode('walk'); pet.timer = rand(60, 200);
  } else if (r < 0.8) {
    setMode('idle'); pet.timer = rand(60, 150);
  } else {
    setMode('sit'); pet.timer = rand(90, 240);
  }
}

function tick() {
  if (!win || win.isDestroyed()) return;
  const cur = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint({
    x: Math.round(pet.x + WIN_W / 2), y: Math.round(pet.y + WIN_H / 2),
  }).workArea;
  const ground = wa.y + wa.height - WIN_H;
  const minX = wa.x - 40;
  const maxX = wa.x + wa.width - WIN_W + 40;

  if (pet.press && !pet.dragging &&
      Math.hypot(cur.x - pet.press.sx, cur.y - pet.press.sy) > 5) {
    pet.dragging = true; setMode('drag');
  }

  if (pet.dragging) {
    const nx = cur.x - pet.press.ox;
    const ny = cur.y - pet.press.oy;
    pet.vx = (nx - pet.x) * 0.6;
    pet.vy = (ny - pet.y) * 0.6;
    pet.x = nx; pet.y = ny;
  } else if (pet.airborne || pet.y < ground - 1) {
    pet.airborne = true;
    pet.vy += GRAVITY;
    pet.x += pet.vx; pet.y += pet.vy;
    pet.vx *= 0.99;
    if (pet.x < minX) { pet.x = minX; pet.vx = -pet.vx * 0.6; }
    if (pet.x > maxX) { pet.x = maxX; pet.vx = -pet.vx * 0.6; }
    if (pet.y >= ground) {
      pet.y = ground;
      if (pet.vy > 14) { pet.vy = -pet.vy * 0.35; pet.vx *= 0.7; } // bounce
      else {
        pet.vy = 0; pet.vx = 0; pet.airborne = false;
        if (pet.mode === 'fall') { setMode('idle'); pet.timer = 30; }
      }
    }
  } else {
    pet.y = ground;
    behave(cur, minX, maxX);
  }

  const key = `${pet.mode}|${pet.dir}`;
  if (key !== pet.lastSent) { pet.lastSent = key; send('state', { mode: pet.mode, dir: pet.dir }); }

  const pos = `${Math.round(pet.x)},${Math.round(pet.y)}`;
  if (pos !== pet.lastPos) { pet.lastPos = pos; win.setPosition(Math.round(pet.x), Math.round(pet.y)); }
}

// ---------- menu ----------
function showMenu() {
  const c = char();
  const tpl = [
    { label: c ? c.name : 'No character', enabled: false },
    { type: 'separator' },
    { label: musicPlaying ? 'Pause music' : 'Play music', enabled: !!c?.music.length,
      click: () => send('music', { cmd: 'toggle' }) },
    { label: 'Next song', enabled: (c?.music.length ?? 0) > 1, click: () => send('music', { cmd: 'next' }) },
    { label: 'Volume', submenu: [0.2, 0.4, 0.6, 0.8, 1].map((v) => ({
      label: `${Math.round(v * 100)}%`, type: 'radio', checked: settings.volume === v,
      click: () => { settings.volume = v; saveSettings(); send('music', { cmd: 'volume', value: v }); },
    })) },
    { type: 'separator' },
    { label: 'Character', submenu: characters.map((ch, i) => ({
      label: ch.name, type: 'radio', checked: i === current, click: () => switchCharacter(i),
    })) },
    { label: 'Walk around', type: 'checkbox', checked: settings.walking,
      click: (m) => { settings.walking = m.checked; saveSettings(); } },
    { label: 'Follow my mouse', type: 'checkbox', checked: settings.chase,
      click: (m) => { settings.chase = m.checked; saveSettings(); pet.timer = 0; } },
    { label: 'Go to sleep', click: () => { setMode('sleep'); pet.timer = 300; pet.lastInteraction = 0; } },
    { type: 'separator' },
    { label: 'Add my own character…', click: () => shell.openPath(userCharDir()) },
    { label: 'Reload characters', click: reloadCharacters },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

// ---------- IPC from the pet window ----------
ipcMain.on('press', (_e, { ox, oy }) => {
  const cur = screen.getCursorScreenPoint();
  pet.press = { ox, oy, sx: cur.x, sy: cur.y };
  poke();
});

ipcMain.on('release', () => {
  if (pet.dragging) {
    pet.dragging = false;
    pet.airborne = true;
    pet.vx = Math.max(-40, Math.min(40, pet.vx));
    pet.vy = Math.max(-40, Math.min(40, pet.vy));
    setMode('fall');
  } else if (pet.press) {
    // a plain click
    if (pet.mode !== 'sleep') {
      setMode('happy'); pet.timer = 45; hop();
      const lines = char()?.lines ?? DEFAULT_LINES;
      say(lines[Math.floor(Math.random() * lines.length)]);
    }
  }
  pet.press = null;
});

ipcMain.on('dblclick', () => { poke(); send('music', { cmd: 'toggle' }); });

ipcMain.on('petted', () => {
  poke();
  setMode('happy'); pet.timer = 60;
  send('fx', 'hearts');
  say('♥ purr ♥');
});

ipcMain.on('menu', () => { poke(); showMenu(); });

ipcMain.on('ignore-mouse', (_e, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('music-state', (_e, { playing, track }) => {
  const started = playing && !musicPlaying;
  musicPlaying = playing;
  if (started) { poke(); pet.timer = 0; if (track) say(`♪ ${track}`); }
  if (!playing && pet.mode === 'dance') { setMode('idle'); pet.timer = 30; }
});

// ---------- app lifecycle ----------
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  pet.x = wa.x + Math.round(wa.width * 0.7);
  pet.y = wa.y + wa.height - WIN_H;

  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, x: pet.x, y: pet.y,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    sendCharacter();
    say(char() ? `Hi! I'm ${char().name}` : 'No characters found!');
  });

  setInterval(tick, TICK_MS);
  if (process.env.PET_SELFTEST) selfTest(process.env.PET_SELFTEST);
}

// Dev-only: `PET_SELFTEST=/some/dir npm start` saves snapshots and a report, then quits.
async function selfTest(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const snap = async (name) =>
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const report = { characters: characters.map((c) => ({ name: c.name, images: Object.keys(c.images), music: c.music.length })) };
  await wait(2500);
  report.image = await js('({ src: img.src.split("/").pop(), w: img.naturalWidth, mode: petEl.dataset.mode })');
  await snap('1-start');
  ipcMain.emit('press', {}, { ox: 120, oy: 200 }); ipcMain.emit('release');
  await wait(300); report.afterClick = pet.mode; await snap('2-click');
  send('music', { cmd: 'toggle' }); await wait(1500);
  report.music = await js('({ playing: !audio.paused, t: audio.currentTime, track: tracks[trackIdx]?.name })');
  report.musicPlaying = musicPlaying;
  switchCharacter(characters.length - 1); await wait(1500);
  report.afterSwitch = await js(`({
    name: chr.name, playing: !audio.paused, track: tracks[trackIdx]?.name,
    showing: sprites.filter((s) => !s.hidden).map((s) => s.id),
    video: vid.dataset.src ? { w: vid.videoWidth, h: vid.videoHeight, t: vid.currentTime } : null,
    cornerAlpha: cvs.hidden ? null : (() => { try { return ctx.getImageData(2, 2, 1, 1).data[3]; } catch (e) { return String(e); } })(),
    centerAlpha: cvs.hidden ? null : (() => { try { return ctx.getImageData(cvs.width / 2, cvs.height / 2, 1, 1).data[3]; } catch (e) { return String(e); } })(),
  })`);
  await snap('3-switch');
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    loadSettings();
    characters = loadCharacters();
    current = Math.max(0, characters.findIndex((c) => c.name === settings.character));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
