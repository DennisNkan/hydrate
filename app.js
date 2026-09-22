const STORAGE_KEY = 'hydrate-state-v1';
const RING_CIRCUMFERENCE = 2 * Math.PI * 96;
const ML_PER_OZ = 29.5735;

// Signature reminder rhythm: two short taps, a beat, one long pulse.
// Unique enough to recognize by feel alone, distinct from a generic single buzz.
const REMINDER_VIBRATE_PATTERN = [70, 60, 70, 160, 220];
const REMINDER_MESSAGES = [
  'Time for a glass of water.',
  'Quick water break.',
  'Stay ahead of your goal — drink up.'
];

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE = window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mlToOz(ml) { return ml / ML_PER_OZ; }
function ozToMl(oz) { return oz * ML_PER_OZ; }

function defaultState() {
  return {
    date: todayKey(),
    goalMl: 2000,
    cupMl: 250,
    unit: 'ml',
    intervalMin: 60,
    remindersOn: false,
    entries: [],
    history: []
  };
}

function loadState() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { raw = null; }
  const state = Object.assign(defaultState(), raw || {});

  if (state.date !== todayKey()) {
    const total = state.entries.reduce((sum, e) => sum + e.amountMl, 0);
    state.history.push({ date: state.date, totalMl: total, goalMl: state.goalMl });
    state.history = state.history.slice(-7);
    state.entries = [];
    state.date = todayKey();
  }
  return state;
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();
saveState(state);
let reminderTimer = null;

const els = {
  ringProgress: document.getElementById('ringProgress'),
  totalAmount: document.getElementById('totalAmount'),
  unitLabel: document.getElementById('unitLabel'),
  goalLabel: document.getElementById('goalLabel'),
  statusLine: document.getElementById('statusLine'),
  quickAdd: document.getElementById('quickAdd'),
  customAmount: document.getElementById('customAmount'),
  customAddBtn: document.getElementById('customAddBtn'),
  entryList: document.getElementById('entryList'),
  historyBars: document.getElementById('historyBars'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDialog: document.getElementById('settingsDialog'),
  goalInput: document.getElementById('goalInput'),
  unitSelect: document.getElementById('unitSelect'),
  cupInput: document.getElementById('cupInput'),
  intervalSelect: document.getElementById('intervalSelect'),
  enableReminders: document.getElementById('enableReminders'),
  permissionNote: document.getElementById('permissionNote'),
  iosBanner: document.getElementById('iosBanner'),
  iosBannerClose: document.getElementById('iosBannerClose'),
  cameraInput: document.getElementById('cameraInput'),
  soundInput: document.getElementById('soundInput'),
  testSoundBtn: document.getElementById('testSoundBtn'),
  clearSoundBtn: document.getElementById('clearSoundBtn'),
  soundNote: document.getElementById('soundNote')
};

function displayAmount(ml) {
  return state.unit === 'oz' ? Math.round(mlToOz(ml)) : Math.round(ml);
}

// Spring-like ease (slight overshoot) for count-up ticks, in the spirit of
// physics-based motion (react-spring) rather than a linear/robotic tween.
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

let displayedTotalMl = null;
let countUpFrame = null;

function animateTotal(fromMl, toMl) {
  cancelAnimationFrame(countUpFrame);
  const start = performance.now();
  const duration = 450;
  const step = now => {
    const t = Math.min(1, (now - start) / duration);
    const eased = easeOutBack(t);
    const current = fromMl + (toMl - fromMl) * eased;
    els.totalAmount.textContent = displayAmount(Math.max(0, current));
    if (t < 1) countUpFrame = requestAnimationFrame(step);
    else els.totalAmount.textContent = displayAmount(toMl);
  };
  countUpFrame = requestAnimationFrame(step);
}

function render() {
  const total = state.entries.reduce((sum, e) => sum + e.amountMl, 0);
  const pct = Math.min(1, total / state.goalMl);

  els.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct));
  els.ringProgress.style.stroke = pct >= 1 ? 'var(--c-green)' : pct >= 0.5 ? 'var(--c-teal)' : 'var(--c-blue)';

  if (displayedTotalMl === null || displayedTotalMl === total) {
    els.totalAmount.textContent = displayAmount(total);
  } else {
    animateTotal(displayedTotalMl, total);
  }
  displayedTotalMl = total;

  els.unitLabel.textContent = state.unit;
  els.goalLabel.textContent = displayAmount(state.goalMl);

  els.statusLine.textContent = state.remindersOn
    ? `Reminders every ${state.intervalMin} min`
    : 'Reminders are off';

  renderQuickAdd();
  renderEntries();
  renderHistory();
}

// Smallest to largest, tinted cool-to-warm so size reads as color as well as number.
const QUICK_ADD_TINTS = ['tint-teal', 'tint-blue', 'tint-amber', 'tint-coral'];

function renderQuickAdd() {
  const cup = state.cupMl;
  const options = [Math.round(cup / 2), cup, cup * 2, cup * 3];
  els.quickAdd.innerHTML = '';
  options.forEach((ml, i) => {
    if (ml < 10) return;
    const btn = document.createElement('button');
    btn.className = `quick-add-btn ${QUICK_ADD_TINTS[i % QUICK_ADD_TINTS.length]}`;
    btn.textContent = `+${displayAmount(ml)} ${state.unit}`;
    btn.addEventListener('click', () => requestWaterPhoto(ml));
    els.quickAdd.appendChild(btn);
  });
}

const seenEntryIds = new Set();

function renderEntries() {
  els.entryList.innerHTML = '';
  if (state.entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'entry-empty';
    li.textContent = 'Nothing logged yet';
    els.entryList.appendChild(li);
    seenEntryIds.clear();
    return;
  }
  [...state.entries].reverse().forEach(entry => {
    const li = document.createElement('li');
    const isNew = !seenEntryIds.has(entry.id);
    if (isNew) li.className = 'entry-enter';
    const time = new Date(entry.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const thumb = entry.photo ? `<img class="entry-thumb" src="${entry.photo}" alt="Proof photo">` : '';
    li.innerHTML = `<span class="entry-info">${thumb}<span class="entry-time">${time}</span><span>${displayAmount(entry.amountMl)} ${state.unit}</span></span>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'entry-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeEntry(entry.id));
    li.appendChild(removeBtn);
    els.entryList.appendChild(li);
    seenEntryIds.add(entry.id);
    if (isNew) requestAnimationFrame(() => li.classList.add('entry-enter-active'));
  });
}

function renderHistory() {
  els.historyBars.innerHTML = '';
  const days = [...state.history];
  const todayTotal = state.entries.reduce((sum, e) => sum + e.amountMl, 0);
  days.push({ date: state.date, totalMl: todayTotal, goalMl: state.goalMl });

  const maxVal = Math.max(state.goalMl, ...days.map(d => d.totalMl), 1);

  while (days.length < 7) days.unshift({ date: '', totalMl: 0, goalMl: state.goalMl, blank: true });

  days.slice(-7).forEach(day => {
    const col = document.createElement('div');
    col.className = 'history-bar-col';
    const bar = document.createElement('div');
    const heightPct = day.blank ? 0 : Math.max(2, (day.totalMl / maxVal) * 100);
    const ratio = day.blank ? 0 : day.totalMl / day.goalMl;
    const ratioClass = day.blank ? '' : ratio >= 1 ? ' good' : ratio >= 0.5 ? ' mid' : ' low';
    bar.className = 'history-bar' + ratioClass;
    bar.style.height = `${heightPct}%`;
    const label = document.createElement('div');
    label.className = 'history-bar-label';
    label.textContent = day.blank ? '' : day.date.slice(5).replace('-', '/');
    col.appendChild(bar);
    col.appendChild(label);
    els.historyBars.appendChild(col);
  });
}

function addWater(ml, photo) {
  state.entries.push({ id: crypto.randomUUID(), time: Date.now(), amountMl: ml, photo: photo || null });
  saveState(state);
  render();
  if (state.remindersOn) restartReminderTimer();
}

// Downscale the captured photo to a small square thumbnail before it ever
// touches localStorage — a few KB per entry, not the multi-MB original.
function fileToThumbnail(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => { img.src = reader.result; };
    img.onerror = reject;
    img.onload = () => {
      const size = 48;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    reader.readAsDataURL(file);
  });
}

let pendingAmountMl = null;

// Logging a drink requires a photo — take (or cancel) it before it's recorded.
function requestWaterPhoto(ml) {
  pendingAmountMl = ml;
  els.cameraInput.value = '';
  els.cameraInput.click();
}

els.cameraInput.addEventListener('change', async () => {
  const file = els.cameraInput.files[0];
  const ml = pendingAmountMl;
  pendingAmountMl = null;
  els.customAmount.value = '';
  if (!file || ml == null) return;
  let photo = null;
  try { photo = await fileToThumbnail(file); } catch (e) { photo = null; }
  addWater(ml, photo);
});

function removeEntry(id) {
  state.entries = state.entries.filter(e => e.id !== id);
  saveState(state);
  render();
}

// The Web Notification API has no cross-browser way to set a custom sound —
// Notification.prototype exposes title/body/icon/badge/tag/vibrate/silent/
// requireInteraction/etc but no `sound` field on Chrome, Firefox, or Safari;
// a backgrounded system notification always plays the OS's own default
// chime, full stop. The one place a genuinely unique sound IS possible is
// while Hydrate itself is open — so this synthesizes a short signature
// chime (matching the vibration rhythm: two short notes, a beat, one long
// note) via Web Audio, playing only when the tab is foregrounded.
let audioCtx = null;
function ensureAudioContext() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

const CUSTOM_SOUND_KEY = 'hydrate-custom-sound';
const MAX_SOUND_BYTES = 2 * 1024 * 1024; // 2MB — plenty for a short clip, safe for localStorage

function loadCustomSound() {
  try { return localStorage.getItem(CUSTOM_SOUND_KEY); } catch (e) { return null; }
}
function saveCustomSound(dataUrl) {
  try {
    if (dataUrl) localStorage.setItem(CUSTOM_SOUND_KEY, dataUrl);
    else localStorage.removeItem(CUSTOM_SOUND_KEY);
  } catch (e) { /* quota exceeded — silently keep the previous sound */ }
}
let customSoundUrl = loadCustomSound();

function playSynthChime() {
  if (!audioCtx) return;
  const notes = [660, 660, 880];
  let t = audioCtx.currentTime;
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.18);
    t += i === 1 ? 0.28 : 0.16; // beat before the final long note
  });
}

// Plays the user's uploaded clip if they set one, else the synthesized
// signature chime. No visibility check here — the Test button calls this
// directly and should always play; fireReminder gates it separately.
function playSound() {
  if (customSoundUrl) {
    try {
      new Audio(customSoundUrl).play().catch(() => playSynthChime());
      return;
    } catch (e) { /* fall through to synth chime */ }
  }
  playSynthChime();
}

let reminderCount = 0;

async function fireReminder() {
  const body = REMINDER_MESSAGES[reminderCount % REMINDER_MESSAGES.length];
  reminderCount++;

  if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification('Hydrate', {
      body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: 'hydrate-reminder',
      renotify: true,
      vibrate: REMINDER_VIBRATE_PATTERN,
      requireInteraction: false
    });
  }
  // Vibration API has no effect on iOS (no browser there implements it) —
  // the notification's own `vibrate` pattern above is what carries the
  // signature rhythm on platforms that do support it (mainly Android).
  if (navigator.vibrate) navigator.vibrate(REMINDER_VIBRATE_PATTERN);
  if (document.visibilityState === 'visible') playSound();
}

function restartReminderTimer() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(fireReminder, state.intervalMin * 60 * 1000);
}

function stopReminderTimer() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
}

function updateSoundNote() {
  els.soundNote.textContent = customSoundUrl
    ? 'Using your custom sound.'
    : 'Using the default chime.';
  els.clearSoundBtn.hidden = !customSoundUrl;
}

function openSettings() {
  els.goalInput.value = displayAmount(state.goalMl);
  els.unitSelect.value = state.unit;
  els.cupInput.value = displayAmount(state.cupMl);
  els.intervalSelect.value = String(state.intervalMin);
  updatePermissionNote();
  updateSoundNote();
  els.settingsDialog.showModal();
}

function updatePermissionNote() {
  if (!('Notification' in window)) {
    if (IS_IOS && !IS_STANDALONE) {
      els.permissionNote.textContent = 'Add Hydrate to your Home Screen first, then open it from there to enable reminders.';
    } else {
      els.permissionNote.textContent = 'Notifications are not supported in this browser.';
    }
    els.enableReminders.disabled = true;
    return;
  }
  if (Notification.permission === 'granted' && state.remindersOn) {
    els.permissionNote.textContent = 'Reminders are on.';
  } else if (Notification.permission === 'denied') {
    els.permissionNote.textContent = 'Notifications are blocked. Allow them in your browser settings to enable reminders.';
  } else {
    els.permissionNote.textContent = 'Reminders fire while Hydrate is open.';
  }
}

els.settingsBtn.addEventListener('click', openSettings);

els.goalInput.addEventListener('change', () => {
  const val = Number(els.goalInput.value) || state.goalMl;
  state.goalMl = state.unit === 'oz' ? ozToMl(val) : val;
  saveState(state);
  render();
});

els.unitSelect.addEventListener('change', () => {
  state.unit = els.unitSelect.value;
  saveState(state);
  els.goalInput.value = displayAmount(state.goalMl);
  els.cupInput.value = displayAmount(state.cupMl);
  render();
});

els.cupInput.addEventListener('change', () => {
  const val = Number(els.cupInput.value) || state.cupMl;
  state.cupMl = state.unit === 'oz' ? ozToMl(val) : val;
  saveState(state);
  render();
});

els.intervalSelect.addEventListener('change', () => {
  state.intervalMin = Number(els.intervalSelect.value);
  saveState(state);
  render();
  if (state.remindersOn) restartReminderTimer();
});

els.enableReminders.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  ensureAudioContext(); // unlock Web Audio now, while this click is a real user gesture
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    state.remindersOn = true;
    saveState(state);
    restartReminderTimer();
    render();
  }
  updatePermissionNote();
});

els.soundInput.addEventListener('change', () => {
  const file = els.soundInput.files[0];
  if (!file) return;
  if (file.size > MAX_SOUND_BYTES) {
    els.soundNote.textContent = 'That file is too big — pick a clip under 2MB.';
    els.soundInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    customSoundUrl = reader.result;
    saveCustomSound(customSoundUrl);
    updateSoundNote();
  };
  reader.readAsDataURL(file);
});

els.clearSoundBtn.addEventListener('click', () => {
  customSoundUrl = null;
  saveCustomSound(null);
  els.soundInput.value = '';
  updateSoundNote();
});

els.testSoundBtn.addEventListener('click', () => {
  ensureAudioContext(); // this click is a real gesture — good moment to unlock audio too
  playSound();
});

els.customAddBtn.addEventListener('click', () => {
  const val = Number(els.customAmount.value);
  if (!val || val <= 0) return;
  requestWaterPhoto(state.unit === 'oz' ? ozToMl(val) : val);
});

els.customAmount.addEventListener('keydown', e => {
  if (e.key === 'Enter') els.customAddBtn.click();
});

render();

if (state.remindersOn && 'Notification' in window && Notification.permission === 'granted') {
  restartReminderTimer();
} else {
  state.remindersOn = false;
}

if (IS_IOS && !IS_STANDALONE && !localStorage.getItem('hydrate-ios-banner-dismissed')) {
  els.iosBanner.hidden = false;
}
els.iosBannerClose.addEventListener('click', () => {
  els.iosBanner.hidden = true;
  localStorage.setItem('hydrate-ios-banner-dismissed', '1');
});

// Subtle pointer-driven tilt on the ring — a small nod to real depth
// (mouse/trackpad only; touch devices have no hover so this is inert there).
if (window.matchMedia('(pointer: fine)').matches) {
  const ringWrap = document.querySelector('.ring-wrap');
  ringWrap.addEventListener('mousemove', e => {
    const rect = ringWrap.getBoundingClientRect();
    const dx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    const dy = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    ringWrap.style.transform = `perspective(600px) rotateY(${dx * 5}deg) rotateX(${-dy * 5}deg)`;
  });
  ringWrap.addEventListener('mouseleave', () => {
    ringWrap.style.transform = '';
  });
}

function runSelfTest() {
  console.assert(todayKey(new Date(2026, 0, 5)) === '2026-01-05', 'todayKey formats with zero padding');
  console.assert(Math.abs(mlToOz(ozToMl(10)) - 10) < 1e-6, 'oz/ml conversion round-trips');

  const s = defaultState();
  s.date = '2000-01-01';
  s.entries = [{ id: '1', time: 0, amountMl: 500 }];
  const rehydrated = Object.assign(defaultState(), s);
  if (rehydrated.date !== todayKey()) {
    const total = rehydrated.entries.reduce((sum, e) => sum + e.amountMl, 0);
    rehydrated.history.push({ date: rehydrated.date, totalMl: total, goalMl: rehydrated.goalMl });
    rehydrated.entries = [];
    rehydrated.date = todayKey();
  }
  console.assert(rehydrated.entries.length === 0, 'day rollover clears entries');
  console.assert(rehydrated.history[0].totalMl === 500, 'day rollover archives previous total');
  console.log('self-test complete');
}

if (new URLSearchParams(location.search).get('test') === '1') runSelfTest();
