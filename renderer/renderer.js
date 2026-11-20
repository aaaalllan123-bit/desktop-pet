const petEl = document.getElementById('pet');
const img = document.getElementById('img');
const bubble = document.getElementById('bubble');
const fx = document.getElementById('fx');

let chr = null;
let mode = 'idle';

// ---------- character + state ----------
function updateImage() {
  if (!chr) return;
  const src = chr.images[mode] || chr.images.idle;
  if (img.src !== src) img.src = src;
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
  if (!holding) setIgnore(e.target !== img);
});

// ---------- press / drag / click ----------
img.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  holding = true;
  img.setPointerCapture(e.pointerId);
  pet.send('press', { ox: e.clientX, oy: e.clientY });
});
img.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  holding = false;
  pet.send('release');
});
img.addEventListener('dblclick', () => pet.send('dblclick'));
img.addEventListener('contextmenu', (e) => { e.preventDefault(); pet.send('menu'); });

// ---------- petting: rub the mouse back and forth over the pet ----------
let rub = 0;
let lastRub = 0;
let cooldown = 0;
img.addEventListener('mousemove', (e) => {
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
