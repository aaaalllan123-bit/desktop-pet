const { app, BrowserWindow, screen, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ---------- constants ----------
const WIN_W = 240;
const WIN_H = 300;
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

// Read one character folder. Pictures/videos/music may be partial: a folder in the personal
// characters folder with the same name as a built-in one only adds to it (e.g. extra songs).
function readFolder(dir) {
  let cfg = {};
  const cfgPath = path.join(dir, 'character.json');
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (err) { console.warn(`Bad character.json in ${dir}: ${err.message}`); }
  }
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  const url = (f) => pathToFileURL(path.join(dir, f)).href;

  // Images: explicit map in character.json, or files named after a mode (idle.png, walk.gif, sleep.png ...)
  const images = {};
  if (cfg.images) for (const [mode, file] of Object.entries(cfg.images)) images[mode] = url(file);
  if (cfg.image) images.idle ??= url(cfg.image);
  for (const f of files) {
    if (IMG_EXT.test(f)) images[path.parse(f).name.toLowerCase()] ??= url(f);
  }
  const first = files.find((f) => IMG_EXT.test(f));

  const musicFiles = cfg.music ?? files.filter((f) => AUDIO_EXT.test(f)).sort();
  const music = musicFiles.map((f) => ({ name: path.parse(f).name, url: url(f) }));
  return { cfg, images, music, firstImage: first ? url(first) : null };
}

// parts: [built-in folder, personal folder] (either may be missing); personal wins.
function buildCharacter(folderName, parts) {
  const cfg = Object.assign({}, ...parts.map((p) => p.cfg));
  const images = Object.assign({}, ...parts.map((p) => p.images));
  images.idle ??= parts.map((p) => p.firstImage).find(Boolean);
  if (!images.idle) return null; // no picture = not a character
  const music = [...parts].reverse().flatMap((p) => p.music); // personal songs play first
  return {
    name: cfg.name || folderName,
    folder: folderName,
    greeting: cfg.greeting || null,
    onlySayLines: !!cfg.onlySayLines,          // bubble shows only greeting/lines, no status messages
    images,
    music,
    lines: Array.isArray(cfg.lines) && cfg.lines.length ? cfg.lines : DEFAULT_LINES,
    size: cfg.size || 140,
    speed: cfg.speed || 2,
    chromaKey: cfg.chromaKey || null,          // e.g. "#00ff00" to remove a green-screen background
    chromaTolerance: cfg.chromaTolerance ?? 0.3,
    crop: cfg.crop || null,                    // { "x", "y", "width", "height" } in video pixels
  };
}

function loadCharacters() {
  fs.mkdirSync(userCharDir(), { recursive: true });
  const folders = new Map(); // folder name -> [parts]
  for (const root of [bundledCharDir(), userCharDir()]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const key = e.name.toLowerCase();
      if (!folders.has(key)) folders.set(key, { name: e.name, parts: [] });
      folders.get(key).parts.push(readFolder(path.join(root, e.name)));
    }
  }
  return [...folders.values()].map((f) => buildCharacter(f.name, f.parts)).filter(Boolean);
}

const greeting = (c) => c.greeting || `I'm ${c.name}!`;

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
  say(greeting(char()));
}

// "Add a song…": copy the chosen files into this character's personal folder
// (they stay on this computer only), reload, and start playing the first one.
function addSongs(files) {
  const c = char();
  if (!c || !files.length) return;
  const dir = path.join(userCharDir(), c.folder);
  fs.mkdirSync(dir, { recursive: true });
  let first = null;
  for (const src of files) {
    let name = path.basename(src);
    // Some downloads are really M4A audio with an .aac name; give them the right extension.
    try {
      const head = Buffer.alloc(12);
      const fd = fs.openSync(src, 'r'); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd);
      if (/\.aac$/i.test(name) && head.toString('latin1', 4, 8) === 'ftyp') name = name.replace(/\.aac$/i, '.m4a');
    } catch {}
    fs.copyFileSync(src, path.join(dir, name));
    first ??= path.parse(name).name;
  }
  reloadCharacters();
  send('music', { cmd: 'play', name: first });
}

async function chooseSongs() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a song for ' + (char()?.name ?? 'the pet'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Music', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'] }],
  });
  if (!r.canceled) addSongs(r.filePaths);
}

function reloadCharacters() {
  const name = char()?.name;
  characters = loadCharacters();
  current = Math.max(0, characters.findIndex((c) => c.name === name));
  sendCharacter();
  sayExtra(`${characters.length} friends loaded!`);
}

// ---------- behaviour ----------
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
const say = (text) => send('say', text);
// status messages (song names, yawns...) are skipped for characters with onlySayLines
const sayExtra = (text) => { if (!char()?.onlySayLines) say(text); };

function setMode(m) { pet.mode = m; }

function poke() {
  pet.lastInteraction = Date.now();
  if (pet.mode === 'sleep') { setMode('idle'); pet.timer = 40; sayExtra('*yawn*'); }
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
  // The pet is drawn centred in a wider transparent window: let only the empty side margin
  // go past the screen edge, so the character itself always stays fully visible.
  const margin = Math.max(0, Math.floor((WIN_W - (char()?.size ?? 140)) / 2) - 4);
  const minX = wa.x - margin;
  const maxX = wa.x + wa.width - WIN_W + margin;
  const minY = wa.y - Math.floor(WIN_H / 2); // a throw may go a little above the top

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

  // Never leave the screen (also fixes a pet stranded by a resolution/monitor change).
  if (!pet.dragging) {
    if (pet.x < minX) pet.x = minX;
    if (pet.x > maxX) pet.x = maxX;
    if (pet.y > ground) pet.y = ground;
    if (pet.y < minY) { pet.y = minY; pet.vy = Math.max(pet.vy, 0); }
  }

  const key = `${pet.mode}|${pet.dir}`;
  if (key !== pet.lastSent) { pet.lastSent = key; send('state', { mode: pet.mode, dir: pet.dir }); }

  const pos = `${Math.round(pet.x)},${Math.round(pet.y)}`;
  if (pos !== pet.lastPos) {
    pet.lastPos = pos;
    // setBounds with the size every time: on Windows with display scaling (125%, 150%...)
    // setPosition alone makes the window slowly grow and drift.
    win.setBounds({ x: Math.round(pet.x), y: Math.round(pet.y), width: WIN_W, height: WIN_H });
  }
}

function inside(b) {
  const cx = pet.x + WIN_W / 2, cy = pet.y + WIN_H / 2;
  return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
}

function bringBack() {
  const wa = screen.getPrimaryDisplay().workArea;
  pet.dragging = false; pet.press = null; pet.airborne = false;
  pet.vx = 0; pet.vy = 0;
  pet.x = wa.x + Math.round((wa.width - WIN_W) * 0.7);
  pet.y = wa.y + wa.height - WIN_H;
  pet.lastPos = '';
}

// ---------- menu ----------
function showMenu() {
  const c = char();
  const tpl = [
    { label: c ? c.name : 'No character', enabled: false },
    { type: 'separator' },
    { label: musicPlaying ? 'Pause music' : 'Play music', enabled: !!c?.music.length,
      click: () => send('music', { cmd: 'toggle' }) },
    { label: 'Add a song…', enabled: !!c, click: chooseSongs },
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
    { label: 'Bring back to screen', click: bringBack },
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
    // a plain click: mute / unmute the music, and react
    send('music', { cmd: 'mute' });
    if (pet.mode !== 'sleep') {
      setMode('happy'); pet.timer = 45; hop();
      send('fx', 'shake');
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
  sayExtra('♥ purr ♥');
});

ipcMain.on('menu', () => { poke(); showMenu(); });

ipcMain.on('ignore-mouse', (_e, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('music-state', (_e, { playing, track }) => {
  const started = playing && !musicPlaying;
  musicPlaying = playing;
  if (started) { poke(); pet.timer = 0; if (track) sayExtra(`♪ ${track}`); }
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
    say(char() ? greeting(char()) : 'No characters found!');
  });

  setInterval(tick, TICK_MS);
  // Screens added/removed/rescaled: re-apply the position (tick() clamps it back on screen).
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, () => { pet.lastPos = ''; if (!screen.getAllDisplays().some((d) => inside(d.bounds))) bringBack(); });
  }
  if (process.env.PET_SELFTEST) selfTest(process.env.PET_SELFTEST);
}

// Dev-only smoke test. Run:  PET_SELFTEST=/some/dir [PET_SELFTEST_CHAR=Name] npm start
// It clicks the pet, plays/mutes music and switches character, then writes
// report.json plus snapshots to that folder and quits.
async function selfTest(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const snap = async (name) =>
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const click = () => { ipcMain.emit('press', {}, { ox: 120, oy: 250 }); ipcMain.emit('release'); };
  const audioState = () => js('({ paused: audio.paused, muted: audio.muted, track: tracks[trackIdx]?.name })');

  const bubbles = [];
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, data) => { if (ch === 'say') bubbles.push(data); return realSend(ch, data); };

  const report = {
    characters: characters.map((c) => ({ name: c.name, images: Object.keys(c.images), music: c.music.map((m) => m.name) })),
  };
  const target = characters.findIndex((c) => c.name === process.env.PET_SELFTEST_CHAR);
  if (target >= 0) switchCharacter(target);
  await wait(2500);
  report.start = await js('({ mode: petEl.dataset.mode, anim: getComputedStyle(bodyEl).animationName, showing: sprites.filter((s) => !s.hidden).map((s) => s.id) })');
  await snap('1-start');

  if (!musicPlaying) { send('music', { cmd: 'toggle' }); await wait(1500); }
  report.musicOn = { ...(await audioState()), musicPlaying };
  click(); await wait(300);
  report.click1 = { ...(await audioState()), musicPlaying, mode: pet.mode, anim: await js('getComputedStyle(bodyEl).animationName') };
  await snap('2-click');
  click(); await wait(1500);
  report.click2 = { ...(await audioState()), musicPlaying, anim: await js('getComputedStyle(bodyEl).animationName') };
  report.keyedAlpha = await js(`cvs.hidden ? null : {
    corner: ctx.getImageData(2, 2, 1, 1).data[3],
    center: ctx.getImageData(cvs.width / 2, cvs.height / 2, 1, 1).data[3] }`);
  report.bubbles = bubbles;
  if (process.env.PET_SELFTEST_ADDSONG) {
    addSongs([process.env.PET_SELFTEST_ADDSONG]); await wait(2000);
    report.afterAddSong = { playlist: char().music.map((m) => m.name), ...(await audioState()), t: await js('audio.currentTime') };
  }
  // off-screen recovery: fling the pet far away and check it ends up fully on screen
  const wa = screen.getPrimaryDisplay().workArea;
  report.offscreen = [];
  for (const [x, y] of [[-5000, -5000], [wa.x + wa.width + 3000, wa.y + 200], [wa.x + 100, wa.y + wa.height + 2000]]) {
    pet.x = x; pet.y = y; pet.vx = 0; pet.vy = 0; pet.airborne = true;
    await wait(2500);
    const b = win.getBounds();
    report.offscreen.push({ from: [x, y], bounds: b, workArea: wa });
  }
  await snap('3-end');
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
