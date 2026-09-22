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
  testNotificationBtn: document.getElementById('testNotificationBtn'),
  permissionNote: document.getElementById('permissionNote'),
  iosBanner: document.getElementById('iosBanner'),
  iosBannerClose: document.getElementById('iosBannerClose'),
  cameraInput: document.getElementById('cameraInput'),
  soundInput: document.getElementById('soundInput'),
  testSoundBtn: document.getElementById('testSoundBtn'),
  clearSoundBtn: document.getElementById('clearSoundBtn'),
  soundNote: document.getElementById('soundNote'),
  photoCheckNote: document.getElementById('photoCheckNote')
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
    ? (state.nextReminderAt
        ? `Next reminder at ${new Date(state.nextReminderAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : `Reminders every ${state.intervalMin} min`)
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

    // Built via DOM APIs rather than innerHTML — entry.photo comes back out
    // of localStorage, and a value that's ever anything other than what we
    // wrote (a hand-edited value, a future bug) should never be re-parsed
    // as markup, only ever treated as attribute data.
    const info = document.createElement('span');
    info.className = 'entry-info';
    if (typeof entry.photo === 'string' && entry.photo.startsWith('data:image/')) {
      const img = document.createElement('img');
      img.className = 'entry-thumb';
      img.src = entry.photo;
      img.alt = 'Proof photo';
      info.appendChild(img);
    }
    const timeSpan = document.createElement('span');
    timeSpan.className = 'entry-time';
    timeSpan.textContent = new Date(entry.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const amountSpan = document.createElement('span');
    amountSpan.textContent = `${displayAmount(entry.amountMl)} ${state.unit}`;
    info.append(timeSpan, amountSpan);
    li.appendChild(info);

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
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => { img.src = reader.result; };
    img.onerror = reject;
    img.onload = () => resolve(img);
    reader.readAsDataURL(file);
  });
}

// Downscale the captured photo to a small square thumbnail before it ever
// touches localStorage — a few KB per entry, not the multi-MB original.
function makeThumbnail(img) {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const s = Math.min(img.width, img.height);
  ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.6);
}

// ImageNet class names (from MobileNet) that count as "water-related" —
// checked as a loose substring match against the model's top-5 guesses.
const WATER_KEYWORDS = [
  'bottle', 'cup', 'mug', 'glass', 'goblet', 'pitcher', 'jug', 'beaker',
  'canteen', 'flask', 'water', 'bucket', 'pail', 'teapot', 'coffeepot'
];

let mobilenetModelPromise = null;
// Subresource Integrity: pins these third-party scripts to an exact byte
// hash, so a compromised or MITM'd CDN response gets refused by the browser
// instead of silently executing. Hashes computed from the pinned versions below.
const CDN_SCRIPTS = [
  {
    src: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js',
    integrity: 'sha384-xc4sZTUOM2obsQR75Be0zGbt7Gb6mOVFJN4yBm30Xn0YQLDWIY+yrtFmLmIank6w'
  },
  {
    src: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js',
    integrity: 'sha384-oBAqwJ0tv9zzKlbIZyBhhXlEvU/PMrSMqDyOHlEZVC8xWHx4yPySuS7vRikRcYFq'
  }
];

function loadScriptOnce(src, integrity) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.integrity = integrity;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

// Runs entirely client-side — the photo never leaves the device. alpha 0.5
// trades a slightly bigger one-time download (~5MB, cached after) for
// meaningfully better accuracy than the smallest 0.25 variant, since casual
// hand-held phone photos are already a hard case for this model.
function getMobilenetModel() {
  if (!mobilenetModelPromise) {
    mobilenetModelPromise = loadScriptOnce(CDN_SCRIPTS[0].src, CDN_SCRIPTS[0].integrity)
      .then(() => loadScriptOnce(CDN_SCRIPTS[1].src, CDN_SCRIPTS[1].integrity))
      .then(() => window.mobilenet.load({ version: 1, alpha: 0.5 }));
  }
  return mobilenetModelPromise;
}
getMobilenetModel().catch(() => {}); // warm it up in the background; failures are handled per-check

// { ok: true|false|null, label }. null means verification itself failed
// (offline, CDN blocked, model error) — callers fail OPEN in that case
// rather than blocking logging entirely over a network hiccup.
//
// This is a 1000-class general object classifier, not a purpose-built
// "is this water" detector — on a quick, off-center, cluttered phone photo
// it's often just uncertain rather than wrong. So the bar to REJECT is
// "confidently thinks it's something else", not "didn't confidently say
// water" — an uncertain top guess is treated as inconclusive and let through,
// which cuts false rejections a lot at the cost of letting a few unrelated
// low-confidence photos through too.
const REJECT_CONFIDENCE_THRESHOLD = 0.4;
// A rank-10 guess can carry well under 1% probability — pure noise, not a
// real "the model spotted this too". Require some real weight behind a
// keyword match before it counts as one (a genuine secondary object in
// frame typically clears this easily; pure tail noise doesn't).
const MATCH_CONFIDENCE_THRESHOLD = 0.05;

async function verifyWaterPhoto(img) {
  try {
    const model = await getMobilenetModel();
    const predictions = await model.classify(img, 10);
    const match = predictions.find(p =>
      p.probability >= MATCH_CONFIDENCE_THRESHOLD &&
      WATER_KEYWORDS.some(k => p.className.toLowerCase().includes(k))
    );
    if (match) return { ok: true, label: match.className };

    const top = predictions[0];
    if (!top || top.probability < REJECT_CONFIDENCE_THRESHOLD) {
      return { ok: true, label: null }; // model isn't sure enough to confidently say "no" — let it through
    }
    return { ok: false, label: top.className };
  } catch (e) {
    return { ok: null, label: null };
  }
}

let pendingAmountMl = null;
let isVerifyingPhoto = false;

// Logging a drink requires a photo — take (or cancel) it before it's recorded.
function requestWaterPhoto(ml) {
  if (isVerifyingPhoto) return;
  pendingAmountMl = ml;
  els.cameraInput.value = '';
  els.cameraInput.click();
}

const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // guards against decoding a huge file into memory

els.cameraInput.addEventListener('change', async () => {
  const file = els.cameraInput.files[0];
  const ml = pendingAmountMl;
  pendingAmountMl = null;
  els.customAmount.value = '';
  if (!file || ml == null) return;

  // Whitelist by actual MIME type — the file picker's `accept` filter is
  // only a UI hint and doesn't stop a user (or script) from choosing
  // anything else, so re-check what was actually handed to us.
  if (!file.type.startsWith('image/')) {
    els.photoCheckNote.hidden = false;
    els.photoCheckNote.classList.add('warn');
    els.photoCheckNote.textContent = 'That file is not an image — pick a photo.';
    return;
  }
  if (file.size > MAX_PHOTO_BYTES) {
    els.photoCheckNote.hidden = false;
    els.photoCheckNote.classList.add('warn');
    els.photoCheckNote.textContent = 'That photo is too large — try a smaller one.';
    return;
  }

  isVerifyingPhoto = true;
  els.photoCheckNote.hidden = false;
  els.photoCheckNote.classList.remove('warn');
  els.photoCheckNote.textContent = 'Checking photo for a cup or bottle…';

  let img;
  try {
    img = await loadImageFromFile(file);
  } catch (e) {
    isVerifyingPhoto = false;
    els.photoCheckNote.classList.add('warn');
    els.photoCheckNote.textContent = "Couldn't read that photo — try again.";
    return;
  }

  const verdict = await verifyWaterPhoto(img);
  isVerifyingPhoto = false;

  if (verdict.ok === false) {
    els.photoCheckNote.classList.add('warn');
    els.photoCheckNote.textContent = `That looked more like "${verdict.label}" — retake with the cup or bottle clearly in frame.`;
    return;
  }

  els.photoCheckNote.hidden = true;
  els.photoCheckNote.classList.remove('warn');
  addWater(ml, makeThumbnail(img));
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

// Shared by the real timer and the "Send test notification" button, so a
// test is a genuine end-to-end check of the exact same code path — not a
// simulation of it. Returns whether a system notification was actually
// requested (false only means the permission/SW preconditions weren't met;
// it does NOT mean the notification visibly appeared — see the note below).
async function showReminderNotification(body) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) {
    return false;
  }
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('Hydrate', {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'hydrate-reminder',
    renotify: true,
    vibrate: REMINDER_VIBRATE_PATTERN,
    requireInteraction: false
  });
  return true;
}

let reminderCount = 0;

async function fireReminder() {
  const body = REMINDER_MESSAGES[reminderCount % REMINDER_MESSAGES.length];
  reminderCount++;

  // Reschedule up front, from "now" — so if the tab was asleep for way
  // longer than one interval, this fires once (not a pile of backlogged
  // notifications) and resumes a normal cadence from here.
  scheduleNextReminder();

  await showReminderNotification(body);
  // Vibration API has no effect on iOS (no browser there implements it) —
  // the notification's own `vibrate` pattern above is what carries the
  // signature rhythm on platforms that do support it (mainly Android).
  if (navigator.vibrate) navigator.vibrate(REMINDER_VIBRATE_PATTERN);
  if (document.visibilityState === 'visible') playSound();
}

// Reminders are scheduled by absolute clock time (state.nextReminderAt),
// not by trusting a single long-lived setInterval to survive untouched —
// it doesn't: a tab reload, a background-tab freeze, or Chrome discarding
// an idle tab (memory saver) all silently kill an in-flight setInterval
// with nothing left to restart it. A short, frequent ticker just checks
// "is it time yet?" against the persisted timestamp, so a reminder that
// was due while the tab was asleep fires the moment it wakes up instead
// of never firing at all.
function scheduleNextReminder() {
  state.nextReminderAt = Date.now() + state.intervalMin * 60 * 1000;
  saveState(state);
  render();
}

function checkReminderDue() {
  if (!state.remindersOn) return;
  if (state.nextReminderAt && Date.now() >= state.nextReminderAt) fireReminder();
}

function startReminderTicker() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(checkReminderDue, 30 * 1000);
}

// User explicitly enabled reminders or changed the interval — restart the
// countdown fresh from this moment.
function restartReminderTimer() {
  scheduleNextReminder();
  startReminderTicker();
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
    els.testNotificationBtn.disabled = true;
    return;
  }
  els.testNotificationBtn.disabled = false;
  if (Notification.permission === 'granted' && state.remindersOn) {
    els.permissionNote.textContent = 'Reminders are on. Nothing showing up? Try "Send test notification" below — if even that stays silent, check your OS notification settings for this browser/app (that toggle is separate from the permission you just granted, and Do Not Disturb/Focus modes block it too).';
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

els.testNotificationBtn.addEventListener('click', async () => {
  ensureAudioContext();
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    els.permissionNote.textContent = 'Click "Enable reminders" first — a test notification needs the same browser permission a real one does.';
    return;
  }
  const shown = await showReminderNotification('Test notification — if you can see or hear this, it works.');
  if (navigator.vibrate) navigator.vibrate(REMINDER_VIBRATE_PATTERN);
  playSound();
  els.permissionNote.textContent = shown
    ? 'Test sent just now. If you saw/heard nothing at all, the site permission is fine — check your OS/browser-level notification settings for this app instead (and Do Not Disturb/Focus mode).'
    : "Couldn't reach the service worker to show it — try reloading the page once and test again.";
});

els.soundInput.addEventListener('change', () => {
  const file = els.soundInput.files[0];
  if (!file) return;
  if (!file.type.startsWith('audio/')) {
    els.soundNote.textContent = 'That file is not audio — pick a sound clip.';
    els.soundInput.value = '';
    return;
  }
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
  // Don't blindly reset the countdown on every page load/reload — that's
  // exactly what let the old code silently never fire if the tab reloaded
  // more often than the interval. Pick up the persisted schedule instead,
  // firing immediately if it's already overdue (the tab was asleep past it).
  if (!state.nextReminderAt) scheduleNextReminder();
  else checkReminderDue();
  startReminderTicker();
} else if (state.remindersOn) {
  // Permission was revoked (OS settings, browser reset) since we last saved
  // remindersOn=true — reflect that back to storage instead of silently
  // drifting from what's on disk.
  state.remindersOn = false;
  saveState(state);
}

// The 30s ticker above only runs while this tab is actually scheduled by
// the browser, which mobile browsers stop doing once backgrounded — so
// also check right when the tab becomes visible again, instead of waiting
// on the next tick that may not come for a while.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkReminderDue();
});

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

  // The exact "is it due yet" condition checkReminderDue relies on —
  // this is the logic that regressed once already (reset-every-page-load).
  const isDue = nextAt => !!(nextAt && Date.now() >= nextAt);
  console.assert(isDue(Date.now() - 1000) === true, 'an overdue reminder should be due');
  console.assert(isDue(Date.now() + 60000) === false, 'a future reminder should not be due yet');
  console.assert(isDue(null) === false, 'no schedule should never be due');

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
