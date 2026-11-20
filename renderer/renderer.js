const petEl = document.getElementById('pet');
const img = document.getElementById('img');
const vid = document.getElementById('vid');
const cvs = document.getElementById('cvs');
const sprites = [img, vid, cvs];
const isVideo = (url) => /\.(webm|mp4|mov|m4v)$/i.test(url);
const bubble = document.getElementById('bubble');
const fx = document.getElementById('fx');

let chr = null;
let mode = 'idle';

// ---------- character + state ----------
function updateImage() {
  if (!chr) return;
  const src = chr.images[mode] || chr.images.idle;
  if (isVideo(src)) {
    img.hidden = true;
    if (vid.dataset.src !== src) {
      vid.dataset.src = src;
      vid.src = src;
      vid.play().catch(() => {});
    }
    const keyed = !!chr.chromaKey;
    vid.hidden = keyed;   // with a green screen we draw the cleaned-up frames on the canvas instead
    cvs.hidden = !keyed;
    if (keyed) startKeying();
  } else {
    vid.hidden = true; cvs.hidden = true; img.hidden = false;
    if (vid.dataset.src) { vid.pause(); vid.removeAttribute('src'); delete vid.dataset.src; vid.load(); }
    if (img.src !== src) img.src = src;
  }
}

// ---------- green-screen removal ----------
const ctx = cvs.getContext('2d', { willReadFrequently: true });
let keying = false;
function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function startKeying() {
  if (keying) return;
  keying = true;
  requestAnimationFrame(drawKeyed);
}
function drawKeyed() {
  if (cvs.hidden || !chr?.chromaKey) { keying = false; return; }
  const vw = vid.videoWidth, vh = vid.videoHeight;
  if (vw && vh && vid.readyState >= 2) {
    const c = chr.crop || {};
    const sx = c.x || 0, sy = c.y || 0;
    const w = Math.min(c.width || vw, vw - sx), h = Math.min(c.height || vh, vh - sy);
    if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
    ctx.drawImage(vid, sx, sy, w, h, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    keyOut(frame.data, hexToRgb(chr.chromaKey), chr.chromaTolerance);
    ctx.putImageData(frame, 0, 0);
  }
  requestAnimationFrame(drawKeyed);
}

// Green/blue-screen keying: a pixel is background when the key's main channel clearly
// beats the other two (so black and white parts of the character stay solid).
function keyOut(d, key, tolerance) {
  const main = key[1] >= key[2] ? 1 : 2;           // 1 = green screen, 2 = blue screen
  const o1 = main === 1 ? 0 : 0, o2 = main === 1 ? 2 : 1;
  const keyScore = Math.max(1, key[main] - Math.max(key[o1], key[o2]));
  const lo = keyScore * tolerance;                 // below this: fully visible
  const hi = keyScore * (tolerance + 0.25);        // above this: fully transparent
  for (let i = 0; i < d.length; i += 4) {
    const other = Math.max(d[i + o1], d[i + o2]);
    const score = d[i + main] - other;
    if (score >= hi) { d[i + 3] = 0; continue; }
    if (score > lo) d[i + 3] = Math.round(255 * (hi - score) / (hi - lo));
    if (score > 0) d[i + main] = other;            // remove green/blue fringe on edges
  }
}

pet.on('character', (c) => {
  const wasPlaying = !audio.paused;
  chr = c;
  petEl.style.setProperty('--size', `${c.size}px`);
  audio.volume = c.volume;
  setTracks(c.music, wasPlaying);
  updateImage();
});

pet.on('state', (s) => {
  mode = s.mode;
  petEl.dataset.mode = s.mode;
  petEl.classList.toggle('flip', s.dir < 0);
  updateImage();
});

// ---------- speech bubble ----------
let bubbleTimer;
pet.on('say', (text) => {
  bubble.textContent = text;
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 2600);
});

// ---------- particles ----------
function particle(char) {
  const p = document.createElement('span');
  p.className = 'particle';
  p.textContent = char;
  p.style.left = `${90 + Math.random() * 50}px`;
  p.style.setProperty('--dx', `${(Math.random() - 0.5) * 60}px`);
  fx.appendChild(p);
  setTimeout(() => p.remove(), 1900);
}
pet.on('fx', (kind) => {
  if (kind === 'hearts') for (let i = 0; i < 5; i++) setTimeout(() => particle('💗'), i * 120);
});
setInterval(() => {
  if (!audio.paused) particle(Math.random() < 0.5 ? '♪' : '♫');
  else if (mode === 'sleep') particle('💤');
}, 800);

// ---------- music ----------
const audio = new Audio();
let tracks = [];
let trackIdx = 0;

function setTracks(list, keepPlaying) {
  audio.pause();
  tracks = list || [];
  trackIdx = 0;
  if (tracks.length) audio.src = tracks[0].url; else audio.removeAttribute('src');
  if (keepPlaying && tracks.length) audio.play().catch(() => {});
  else report();
}
function loadTrack(i) {
  trackIdx = (i + tracks.length) % tracks.length;
  audio.src = tracks[trackIdx].url;
}
function report() {
  pet.send('music-state', { playing: !audio.paused, track: tracks[trackIdx]?.name });
}
audio.addEventListener('play', report);
audio.addEventListener('pause', report);
audio.addEventListener('ended', () => { loadTrack(trackIdx + 1); audio.play().catch(() => {}); });

pet.on('music', ({ cmd, value }) => {
  if (!tracks.length && cmd !== 'volume') return;
  if (cmd === 'toggle') audio.paused ? audio.play().catch(() => {}) : audio.pause();
  if (cmd === 'next') { loadTrack(trackIdx + 1); audio.play().catch(() => {}); }
  if (cmd === 'volume') audio.volume = value;
});

// ---------- mouse: click-through except on the pet itself ----------
let ignoring = true;
let holding = false;
function setIgnore(v) {
  if (v !== ignoring) { ignoring = v; pet.send('ignore-mouse', v); }
}
window.addEventListener('mousemove', (e) => {
  if (!holding) setIgnore(!sprites.includes(e.target));
});

// ---------- press / drag / click / petting (on whichever sprite is showing) ----------
let rub = 0;
let lastRub = 0;
let cooldown = 0;
for (const el of sprites) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    holding = true;
    el.setPointerCapture(e.pointerId);
    pet.send('press', { ox: e.clientX, oy: e.clientY });
  });
  el.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    holding = false;
    pet.send('release');
  });
  el.addEventListener('dblclick', () => pet.send('dblclick'));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); pet.send('menu'); });
  // petting: rub the mouse back and forth over the pet
  el.addEventListener('mousemove', (e) => {
    if (holding || e.buttons) return;
    const now = Date.now();
    if (now - lastRub > 400) rub = 0;
    lastRub = now;
    rub += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (rub > 700 && now > cooldown) {
      rub = 0;
      cooldown = now + 2500;
      pet.send('petted');
    }
  });
}
