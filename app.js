/*
 * Field Logger
 *
 * The on-site half of the Acoustic Monitoring Software, for tablets and
 * phones that can't run the Windows app. It logs observations against its own
 * clock while the sound level meter records, optionally records audio as a
 * timing reference, and exports a session file that the Windows app imports
 * and binds to the meter's file afterwards.
 *
 * Everything is kept in this browser's IndexedDB, written as it happens, so a
 * crash, reload or flat battery loses at most the last couple of seconds of
 * audio and never an observation. Nothing is sent anywhere.
 *
 * EXPORT FORMAT (one .zip, stored uncompressed):
 *   session.amb  gzip JSON in the Windows app's session-backup format
 *                (modules/database.py export_session_backup), as a 'live'
 *                session: observations carry elapsed seconds from Start and
 *                the matching wall-clock times, exactly as the Windows app
 *                stores a session logged on the laptop.
 *   audio.wav    16-bit mono PCM at 16 kHz, if audio was recorded. Its start
 *                time is session.audio_start in session.amb.
 *
 * Times are local wall-clock ISO strings without a time zone, as the Windows
 * app writes them (Python datetime.isoformat()).
 */
'use strict';

const APP_VERSION = '1.0';
const CATEGORIES = ['Traffic', 'Aircraft', 'Rail', 'Construction', 'Industrial',
                    'Animal', 'Weather/Wind', 'Voices/People', 'Other'];
const PLACEHOLDER_NOTE = '(no description — double-click to edit)';  // matches the Windows app
const AUDIO_RATE = 16000;
const AUDIO_FLUSH_SECONDS = 2;

// ── Small helpers ───────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Local wall-clock ISO string with microseconds and no zone, as Python writes it. */
function localIso(ms) {
  const d = new Date(ms);
  const micro = pad(d.getMilliseconds(), 3) + pad(Math.min(999, Math.floor((ms % 1) * 1000)), 3);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${micro}`;
}

function fmtElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function banner(text, kind = 'warn') {
  const b = $('banner');
  if (!text) { b.classList.add('hidden'); return; }
  b.textContent = text;
  b.className = `banner ${kind}`;
}

// ── Storage (IndexedDB) ─────────────────────────────────────────────────────
//
// sessions: {id, name, liveStartMs, stoppedMs, observations[], audio, details,
//            plannedSeconds, positionPhotos[]}
// audio:    {key: [sessionId, index], data: ArrayBuffer of Int16 samples}
// photos:   {key: [sessionId, photoId], data: JPEG Blob}

let db;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('field-logger', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const saveSession = (s) => tx('sessions', 'readwrite', (st) => st.put(s));
const loadSessions = () => tx('sessions', 'readonly', (st) => st.getAll());
const saveAudioChunk = (sid, i, buf) => tx('audio', 'readwrite', (st) => st.put(buf, [sid, i]));

function loadAudioChunks(sid, count) {
  return tx('audio', 'readonly', (st) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const r = st.get([sid, i]);
      r.onsuccess = () => { out[i] = r.result; };
    }
    return out;
  });
}

async function deleteSessionData(s) {
  await tx('sessions', 'readwrite', (st) => st.delete(s.id));
  await tx('audio', 'readwrite', (st) =>
    st.delete(IDBKeyRange.bound([s.id, 0], [s.id, Number.MAX_SAFE_INTEGER])));
  await tx('photos', 'readwrite', (st) =>
    st.delete(IDBKeyRange.bound([s.id, ''], [s.id, '￿'])));
}

const savePhoto = (sid, pid, blob) => tx('photos', 'readwrite', (st) => st.put(blob, [sid, pid]));
const loadPhoto = (sid, pid) => tx('photos', 'readonly', (st) => st.get([sid, pid]));
const removePhoto = (sid, pid) => tx('photos', 'readwrite', (st) => st.delete([sid, pid]));

// ── Session state ───────────────────────────────────────────────────────────

let session = null;          // the session being logged
let rangeStart = null;       // {elapsed} while a range is open
let pauseStart = null;       // {elapsed} while paused
let timerHandle = null;
let wakeLock = null;

function elapsedNow() {
  return (Date.now() - session.liveStartMs) / 1000;
}

function wallAt(elapsed) {
  return localIso(session.liveStartMs + elapsed * 1000);
}

function selectedCategories(container) {
  const picked = [...container.querySelectorAll('.chip[aria-pressed="true"]')].map((c) => c.dataset.cat);
  return picked.length ? picked.join(', ') : 'General';
}

function addObservation({ elapsedStart, elapsedEnd = null, note, category, excluded }) {
  session.observations.push({
    id: newId(),
    elapsed_start: elapsedStart,
    elapsed_end: elapsedEnd,
    note: (note || '').trim() || PLACEHOLDER_NOTE,
    category,
    excluded: !!excluded,
    created_ms: Date.now(),
    photos: [],
  });
  saveSession(session);
  renderObservations();
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── Site and job details ────────────────────────────────────────────────────
//
// The fields of the paper Environmental Noise Measurement sheet that only the
// operator on site can fill in. They travel with the session and fill the
// sheet the Windows app generates. Those that rarely change between
// positions on a job are remembered for the next session.

const DETAIL_KEYS = ['job_number', 'folder', 'client', 'operator', 'location', 'meter', 'meter_serial',
                     'calibrator', 'pre_cal', 'post_cal', 'temp', 'clouds', 'humidity', 'wind_avg',
                     'wind_max', 'wind_dir', 'noise_environment'];
const REMEMBERED_KEYS = ['job_number', 'folder', 'client', 'operator', 'meter', 'meter_serial', 'calibrator'];

let draftDetails = {};   // for the next session, before Start
let detailsTarget = null;  // the session whose details are open, or null for the draft

function loadRemembered() {
  try {
    const saved = JSON.parse(localStorage.getItem('field-logger-details') || '{}');
    for (const k of REMEMBERED_KEYS) if (saved[k]) draftDetails[k] = saved[k];
  } catch (e) { /* storage unavailable: start blank */ }
}

function remember(details) {
  try {
    const keep = {};
    for (const k of REMEMBERED_KEYS) if (details[k]) keep[k] = details[k];
    localStorage.setItem('field-logger-details', JSON.stringify(keep));
  } catch (e) { /* not remembered; harmless */ }
}

function detailsSummary(d) {
  const filled = DETAIL_KEYS.filter((k) => d && d[k]).length;
  if (!filled) return 'Not filled in yet';
  const bits = [d.job_number && `job ${d.job_number}`, d.location, d.operator, d.meter].filter(Boolean);
  return `${filled} of ${DETAIL_KEYS.length} filled${bits.length ? ': ' + bits.join(', ') : ''}`;
}

function openDetails(target) {
  detailsTarget = target;
  const d = target ? (target.details || {}) : draftDetails;
  document.querySelectorAll('#details-dialog [data-key]').forEach((el) => { el.value = d[el.dataset.key] || ''; });
  $('details-add-photo').classList.toggle('hidden', !target);
  $('position-photos-note').classList.toggle('hidden', !!target);
  renderPhotos($('position-photos'), target, target ? (target.positionPhotos || []) : []);
  $('details-dialog').showModal();
}

async function saveDetails() {
  const d = {};
  document.querySelectorAll('#details-dialog [data-key]').forEach((el) => {
    const v = el.value.trim();
    if (v) d[el.dataset.key] = v;
  });
  if (detailsTarget) {
    detailsTarget.details = d;
    await saveSession(detailsTarget);
  } else {
    draftDetails = d;
  }
  remember(d);
  $('details-dialog').close();
  refreshDetailsSummary();
}

function refreshDetailsSummary() {
  $('details-summary').textContent = detailsSummary(draftDetails);
}

// ── Photos ──────────────────────────────────────────────────────────────────
//
// Taken with the tablet's camera, shrunk to at most 1600 pixels on the long
// side as JPEG (a few hundred KB) so a session full of them stays easy to
// export and send.

const PHOTO_MAX = 1600;
let photoRequest = null;   // {session, list, after} for the next picture taken
let photoShown = null;     // {session, list, id} in the full-size view
const thumbUrls = [];

async function shrinkPhoto(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

function takePhoto(s, list, after) {
  photoRequest = { session: s, list, after };
  $('photo-input').value = '';
  $('photo-input').click();
}

async function onPhotoChosen() {
  const file = $('photo-input').files[0];
  const req = photoRequest;
  photoRequest = null;
  if (!file || !req) return;
  try {
    const blob = await shrinkPhoto(file);
    const id = newId();
    await savePhoto(req.session.id, id, blob);
    req.list.push(id);
    await saveSession(req.session);
    req.after();
  } catch (e) {
    banner(`The photo could not be saved (${e.message || e}). Try again.`, 'err');
  }
}

async function renderPhotos(container, s, ids) {
  container.innerHTML = '';
  if (!s) return;
  for (const id of ids) {
    const blob = await loadPhoto(s.id, id);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    thumbUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Photo';
    img.onclick = () => showPhoto(s, ids, id, url, () => renderPhotos(container, s, ids));
    container.appendChild(img);
  }
}

function showPhoto(s, list, id, url, after) {
  photoShown = { session: s, list, id, after };
  $('photo-full').src = url;
  $('photo-dialog').showModal();
}

async function deleteShownPhoto() {
  if (!photoShown || !confirm('Delete this photo?')) return;
  const { session: s, list, id, after } = photoShown;
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  await removePhoto(s.id, id);
  await saveSession(s);
  $('photo-dialog').close();
  after();
  renderObservations();
}

// ── Audio ───────────────────────────────────────────────────────────────────
//
// An AudioWorklet hands over blocks of samples; they are averaged down to
// 16 kHz, converted to 16-bit and written to IndexedDB every couple of
// seconds. The time the first block arrived, less its own length, is when
// the recording started, which the Windows app uses to line audio up with
// the observations.

let audioCtx = null, audioStream = null, audioNode = null;
let pending = [], pendingSamples = 0, carry = { sum: 0, n: 0, pos: 0 };

let resumeGap = false;   // true after a reload: fill the missed time with silence

async function startAudio(resume = false) {
  audioStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('recorder-worklet.js');
  const src = audioCtx.createMediaStreamSource(audioStream);
  audioNode = new AudioWorkletNode(audioCtx, 'recorder');
  const ratio = audioCtx.sampleRate / AUDIO_RATE;
  if (!resume) {
    session.audio = { sampleRate: AUDIO_RATE, chunks: 0, samples: 0, startMs: null,
                      deviceRate: audioCtx.sampleRate };
  }
  resumeGap = resume;
  audioNode.port.onmessage = (ev) => onAudioBlock(ev.data, ratio);
  src.connect(audioNode);
}

function onAudioBlock(block, ratio) {
  if (!session || !session.audio) return;
  const blockStartMs = Date.now() - (block.length / audioCtx.sampleRate) * 1000;
  if (session.audio.startMs === null) {
    session.audio.startMs = blockStartMs;
    saveSession(session);
  }
  if (resumeGap) {
    // Silence for the time the page was closed, so every later sample is
    // still at its true time from the start of the recording.
    resumeGap = false;
    const expected = Math.round((blockStartMs - session.audio.startMs) / 1000 * AUDIO_RATE);
    let missing = expected - session.audio.samples;
    while (missing > 0) {
      const n = Math.min(missing, AUDIO_RATE * 10);
      pending.push(new Int16Array(n));
      pendingSamples += n;
      flushAudio();
      missing -= n;
    }
  }
  // Level meter: RMS of this block in dBFS, shown from -60 to 0 dB.
  let sq = 0;
  for (let i = 0; i < block.length; i++) sq += block[i] * block[i];
  const level = 20 * Math.log10(Math.sqrt(sq / block.length) || 1e-6);
  $('audio-meter').style.width = `${Math.max(0, Math.min(100, (level + 60) / 60 * 100))}%`;

  // Average down to 16 kHz, carrying partial groups between blocks.
  const out = [];
  for (let i = 0; i < block.length; i++) {
    carry.sum += block[i];
    carry.n += 1;
    carry.pos += 1;
    if (carry.pos >= ratio) {
      out.push(carry.sum / carry.n);
      carry.pos -= ratio;
      carry.sum = 0;
      carry.n = 0;
    }
  }
  const pcm = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const v = Math.max(-1, Math.min(1, out[i]));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  pending.push(pcm);
  pendingSamples += pcm.length;
  if (pendingSamples >= AUDIO_RATE * AUDIO_FLUSH_SECONDS) flushAudio();
}

function flushAudio() {
  if (!session || !session.audio || !pendingSamples) return;
  const merged = new Int16Array(pendingSamples);
  let o = 0;
  for (const p of pending) { merged.set(p, o); o += p.length; }
  pending = []; pendingSamples = 0;
  const index = session.audio.chunks++;
  // Where each chunk starts, so playback can load just the few it needs.
  (session.audio.chunkStarts = session.audio.chunkStarts || []).push(session.audio.samples);
  session.audio.samples += merged.length;
  saveAudioChunk(session.id, index, merged.buffer);
  saveSession(session);
}

async function stopAudio() {
  $('btn-resume-audio').classList.add('hidden');
  flushAudio();
  if (audioNode) audioNode.disconnect();
  if (audioStream) audioStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) await audioCtx.close();
  audioCtx = audioStream = audioNode = null;
  carry = { sum: 0, n: 0, pos: 0 };
}

// ── Keep the screen on ──────────────────────────────────────────────────────

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && session && !session.stoppedMs) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* not supported or refused; logging still works */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
  else if (session && !session.stoppedMs && session.audio) {
    flushAudio();
  }
});

// ── Live view ───────────────────────────────────────────────────────────────

function buildChips(container) {
  container.innerHTML = '';
  for (const cat of CATEGORIES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = cat;
    b.dataset.cat = cat;
    b.setAttribute('aria-pressed', 'false');
    b.onclick = () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    container.appendChild(b);
  }
}

function setChips(container, categoryString) {
  const wanted = new Set(categoryString.split(',').map((c) => c.trim()));
  container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', wanted.has(c.dataset.cat)));
}

function clearEntry() {
  $('note').value = '';
  $('exclude').checked = false;
  setChips($('chips'), '');
}

function tick() {
  if (!session) return;
  $('timer').textContent = fmtElapsed(elapsedNow());
  const st = $('live-state');
  if (pauseStart) { st.textContent = `Paused at ${fmtElapsed(pauseStart.elapsed)}`; st.className = 'state paused'; }
  else if (rangeStart) { st.textContent = `Range open since ${fmtElapsed(rangeStart.elapsed)}`; st.className = 'state live'; }
  else { st.textContent = 'Logging'; st.className = 'state live'; }
  updateRemaining();
}

// ── Measurement timer ───────────────────────────────────────────────────────
//
// Counts down to the planned length and, when it is reached, vibrates and
// flashes the screen. Deliberately silent: a beep would be measured by the
// sound level meter. It never stops the session itself: the meter has to be
// stopped first, and that is the operator's call.

function updateRemaining() {
  const el = $('remaining');
  if (!session || !session.plannedSeconds) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const left = session.plannedSeconds - elapsedNow();
  if (left > 0) {
    el.textContent = `${fmtElapsed(left)} left of ${fmtElapsed(session.plannedSeconds)}`;
    el.classList.remove('over');
    return;
  }
  el.textContent = `Planned ${fmtElapsed(session.plannedSeconds)} reached ${fmtElapsed(-left)} ago: ` +
                   'stop the meter, then Stop session';
  el.classList.add('over');
  if (!session.plannedAlerted) {
    session.plannedAlerted = true;
    saveSession(session);
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 900]);
    document.body.classList.remove('flash');
    void document.body.offsetWidth;   // restart the animation
    document.body.classList.add('flash');
    setTimeout(() => document.body.classList.remove('flash'), 4000);
  }
}

function plannedFromInput() {
  const minutes = parseFloat(($('planned-min').value || '').replace(',', '.'));
  return minutes > 0 ? Math.round(minutes * 60) : null;
}

// The session whose observations are on screen: one under review after it
// was stopped, otherwise the one being logged.
let reviewing = null;
const shownSession = () => reviewing || session;

function hasAudio(s) {
  return !!(s && s.audio && s.audio.startMs !== null && (s.audio.samples || (s === session && audioCtx)));
}

function renderObservations() {
  const s = shownSession();
  if (!s) return;
  const list = reviewing ? $('review-list') : $('obs-list');
  const empty = reviewing ? $('review-none') : $('no-obs');
  list.innerHTML = '';
  // Newest first while logging; in time order when reviewing a whole session.
  const obs = [...s.observations].sort((a, b) =>
    reviewing ? a.elapsed_start - b.elapsed_start : b.elapsed_start - a.elapsed_start);
  empty.classList.toggle('hidden', obs.length > 0);
  for (const o of obs) {
    const li = document.createElement('li');
    const when = o.elapsed_end !== null
      ? `${fmtElapsed(o.elapsed_start)}–${fmtElapsed(o.elapsed_end)}` : fmtElapsed(o.elapsed_start);
    li.innerHTML = `<div class="when"></div><div class="what"><div class="txt"></div>
      <div class="cat"></div></div>`;
    li.querySelector('.when').textContent = when;
    // The stored placeholder matches the Windows app; on a tablet it's tapped.
    li.querySelector('.txt').textContent =
      o.note === PLACEHOLDER_NOTE ? '(no description — tap to add one)' : o.note;
    li.querySelector('.cat').textContent = o.category;
    if (o.photos && o.photos.length) {
      const cam = document.createElement('span');
      cam.className = 'cam';
      cam.textContent = `  \u{1F4F7} ${o.photos.length}`;
      li.querySelector('.cat').appendChild(cam);
    }
    if (o.excluded) {
      const ex = document.createElement('span');
      ex.className = 'excl';
      ex.textContent = '  EXCLUDED';
      li.querySelector('.cat').appendChild(ex);
    }
    if (hasAudio(s)) {
      const play = document.createElement('button');
      play.className = 'small play';
      play.textContent = '▶';
      play.setAttribute('aria-label', 'Listen to this moment');
      play.onclick = (ev) => { ev.stopPropagation(); playObservation(s, o, play); };
      li.appendChild(play);
    }
    li.onclick = () => openEditor(o);
    list.appendChild(li);
  }
}

function showView(name) {
  $('view-start').classList.toggle('hidden', name !== 'start');
  $('view-live').classList.toggle('hidden', name !== 'live');
  $('view-review').classList.toggle('hidden', name !== 'review');
}

// ── Playback ────────────────────────────────────────────────────────────────
//
// Plays the recording around an observation so the operator can check what
// it was while it is fresh. Mostly before the logged time for a moment,
// because a sound is logged after it is heard.

const PLAY_BEFORE = 4, PLAY_AFTER = 1.5, RANGE_MAX = 15;
let player = { ctx: null, src: null, btn: null };
let playbackConfirmed = new Set();   // live sessions where headphones were confirmed

function stopPlayback() {
  if (player.src) { try { player.src.stop(); } catch (e) { /* already ended */ } }
  if (player.btn) player.btn.textContent = '▶';
  player.src = player.btn = null;
}

async function chunkStarts(s) {
  // Sessions recorded before chunk positions were stored: work them out once.
  if (s.audio.chunkStarts && s.audio.chunkStarts.length === s.audio.chunks) return s.audio.chunkStarts;
  const chunks = await loadAudioChunks(s.id, s.audio.chunks);
  const starts = [];
  let n = 0;
  for (const c of chunks) { starts.push(n); n += c ? c.byteLength / 2 : 0; }
  s.audio.chunkStarts = starts;
  await saveSession(s);
  return starts;
}

/** Samples from fromSec to toSec of the recording, as floats. */
async function readAudio(s, fromSec, toSec) {
  const rate = s.audio.sampleRate;
  const a = Math.max(0, Math.floor(fromSec * rate));
  const b = Math.min(s.audio.samples, Math.ceil(toSec * rate));
  if (b <= a) return null;
  const starts = await chunkStarts(s);
  const wanted = [];
  for (let i = 0; i < starts.length; i++) {
    const next = i + 1 < starts.length ? starts[i + 1] : s.audio.samples;
    if (next > a && starts[i] < b) wanted.push(i);
  }
  const bufs = await tx('audio', 'readonly', (st) => {
    const out = {};
    for (const i of wanted) { const r = st.get([s.id, i]); r.onsuccess = () => { out[i] = r.result; }; }
    return out;
  });
  const result = new Float32Array(b - a);
  for (const i of wanted) {
    if (!bufs[i]) continue;
    const pcm = new Int16Array(bufs[i]);
    for (let k = 0; k < pcm.length; k++) {
      const pos = starts[i] + k - a;
      if (pos >= 0 && pos < result.length) result[pos] = pcm[k] / 32768;
    }
  }
  return result;
}

async function playObservation(s, o, btn) {
  if (player.btn === btn) { stopPlayback(); return; }   // second tap stops it
  stopPlayback();
  const live = s === session && !s.stoppedMs;
  if (live && !playbackConfirmed.has(s.id)) {
    if (!confirm('Use headphones to listen while logging.\n\nThrough the tablet speaker, the playback ' +
                 'would be picked up by the sound level meter and by this recording.\n\n' +
                 'OK: headphones are connected, play it.\nCancel: listen after stopping the session.')) return;
    playbackConfirmed.add(s.id);
  }
  if (live) flushAudio();   // include the last couple of seconds
  const at = (s.liveStartMs + o.elapsed_start * 1000 - s.audio.startMs) / 1000;
  const from = at - (o.elapsed_end !== null ? 1 : PLAY_BEFORE);
  const to = o.elapsed_end !== null
    ? Math.min(at + (o.elapsed_end - o.elapsed_start) + 1, at + RANGE_MAX)
    : at + PLAY_AFTER;
  const samples = await readAudio(s, from, to);
  if (!samples) {
    banner('There is no recording at this time (audio was off or had not started yet).', 'warn');
    return;
  }
  player.ctx = player.ctx || new AudioContext();
  await player.ctx.resume();
  const buffer = player.ctx.createBuffer(1, samples.length, s.audio.sampleRate);
  buffer.copyToChannel(samples, 0);
  const src = player.ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(player.ctx.destination);
  src.onended = () => { if (player.src === src) stopPlayback(); };
  player.src = src;
  player.btn = btn;
  btn.textContent = '■';
  src.start();
}

// ── Reviewing a finished session ────────────────────────────────────────────

async function openReview(s) {
  stopPlayback();
  reviewing = s;
  $('review-title').textContent = sessionLabel(s);
  const duration = s.stoppedMs ? fmtElapsed((s.stoppedMs - s.liveStartMs) / 1000) : '';
  $('review-summary').textContent =
    `${duration} · ${s.observations.length} observation(s) · ` +
    (hasAudio(s) ? 'tap ▶ to listen' : 'no audio recorded');
  renderObservations();
  showView('review');
  banner('');
  window.scrollTo(0, 0);
}

async function closeReview() {
  stopPlayback();
  reviewing = null;
  showView('start');
  await renderSessions();
}

async function startSession() {
  const name = $('session-name').value.trim();
  session = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: name || null,
    liveStartMs: Date.now(),
    stoppedMs: null,
    observations: [],
    details: { ...draftDetails },
    plannedSeconds: plannedFromInput(),
    plannedAlerted: false,
    positionPhotos: [],
    audio: null,
    appVersion: APP_VERSION,
  };
  rangeStart = pauseStart = null;
  await saveSession(session);
  clearEntry();
  $('btn-range').textContent = 'START RANGE';
  $('btn-pause').textContent = 'Pause logging';
  renderObservations();
  showView('live');
  timerHandle = setInterval(tick, 250);
  tick();
  keepAwake();
  banner('');

  if ($('audio-enabled').checked) {
    $('audio-text').textContent = 'Starting microphone…';
    try {
      await startAudio();
      $('audio-text').textContent = 'Recording audio';
    } catch (e) {
      session.audio = null;
      saveSession(session);
      $('audio-text').textContent = 'Audio unavailable';
      banner(`Logging has started, but the microphone could not be used (${e.message || e}). ` +
             'Observations are still being logged.', 'warn');
    }
  } else {
    $('audio-text').textContent = 'Audio off';
  }
}

function logMoment() {
  const elapsed = elapsedNow();       // capture the time first
  addObservation({ elapsedStart: elapsed, note: $('note').value,
                   category: selectedCategories($('chips')), excluded: $('exclude').checked });
  clearEntry();
}

function toggleRange() {
  const elapsed = elapsedNow();
  if (!rangeStart) {
    rangeStart = { elapsed };
    $('btn-range').textContent = `END RANGE (from ${fmtElapsed(elapsed)})`;
    tick();
    return;
  }
  addObservation({ elapsedStart: rangeStart.elapsed, elapsedEnd: elapsed, note: $('note').value,
                   category: selectedCategories($('chips')), excluded: $('exclude').checked });
  rangeStart = null;
  $('btn-range').textContent = 'START RANGE';
  clearEntry();
  tick();
}

function togglePause() {
  const elapsed = elapsedNow();
  if (!pauseStart) {
    pauseStart = { elapsed };
    $('btn-pause').textContent = 'Resume logging';
  } else {
    if (elapsed > pauseStart.elapsed) {
      addObservation({ elapsedStart: pauseStart.elapsed, elapsedEnd: elapsed,
                       note: 'Measurement paused', category: 'Other', excluded: true });
    }
    pauseStart = null;
    $('btn-pause').textContent = 'Pause logging';
  }
  tick();
}

async function stopSession() {
  if (!confirm('Stop this session? You cannot log into it again afterwards. Everything logged is kept.')) return;
  const elapsed = elapsedNow();
  if (rangeStart) {
    addObservation({ elapsedStart: rangeStart.elapsed, elapsedEnd: elapsed, note: $('note').value,
                     category: selectedCategories($('chips')), excluded: $('exclude').checked });
  }
  if (pauseStart && elapsed > pauseStart.elapsed) {
    addObservation({ elapsedStart: pauseStart.elapsed, elapsedEnd: elapsed,
                     note: 'Measurement paused', category: 'Other', excluded: true });
  }
  rangeStart = pauseStart = null;
  stopPlayback();
  await stopAudio();
  session.stoppedMs = Date.now();
  await saveSession(session);
  clearInterval(timerHandle);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  const finished = session;
  session = null;
  $('session-name').value = '';
  // The next position on the same job starts with the remembered details.
  draftDetails = {};
  loadRemembered();
  refreshDetailsSummary();
  // Straight to review: the natural time to listen back and fill in notes.
  await openReview(finished);
  banner('Session saved. Listen back and fill in any notes now, then Export it for the laptop.', 'warn');
}

// ── Editing an observation ──────────────────────────────────────────────────

let editing = null, editingSession = null;

function openEditor(o) {
  editing = o;
  editingSession = shownSession();
  $('edit-play').classList.toggle('hidden', !hasAudio(editingSession));
  $('edit-play').textContent = '▶ Listen';
  const when = o.elapsed_end !== null
    ? `${fmtElapsed(o.elapsed_start)} to ${fmtElapsed(o.elapsed_end)}` : `at ${fmtElapsed(o.elapsed_start)}`;
  $('edit-title').textContent = `Observation ${when}`;
  $('edit-note').value = o.note === PLACEHOLDER_NOTE ? '' : o.note;
  setChips($('edit-chips'), o.category);
  $('edit-exclude').checked = o.excluded;
  o.photos = o.photos || [];
  renderPhotos($('edit-photos'), editingSession, o.photos);
  $('edit-dialog').showModal();
}

function addEditPhoto() {
  const o = editing, s = editingSession;
  takePhoto(s, o.photos, () => { renderPhotos($('edit-photos'), s, o.photos); renderObservations(); });
}

function saveEdit() {
  editing.note = $('edit-note').value.trim() || PLACEHOLDER_NOTE;
  editing.category = selectedCategories($('edit-chips'));
  editing.excluded = $('edit-exclude').checked;
  saveSession(editingSession);
  stopPlayback();
  renderObservations();
  $('edit-dialog').close();
}

function deleteEdit() {
  if (!confirm('Delete this observation?')) return;
  editingSession.observations = editingSession.observations.filter((o) => o !== editing);
  saveSession(editingSession);
  stopPlayback();
  renderObservations();
  $('edit-dialog').close();
}

// ── Saved sessions and export ───────────────────────────────────────────────

function sessionLabel(s) {
  const d = new Date(s.liveStartMs);
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return s.name ? `${s.name} (${when})` : when;
}

async function renderSessions() {
  const rows = $('session-rows');
  rows.innerHTML = '';
  const all = (await loadSessions()).sort((a, b) => b.liveStartMs - a.liveStartMs);
  $('no-sessions').classList.toggle('hidden', all.length > 0);
  for (const s of all) {
    const tr = document.createElement('tr');
    const duration = s.stoppedMs ? fmtElapsed((s.stoppedMs - s.liveStartMs) / 1000) : 'not stopped';
    const audio = s.audio && s.audio.samples ? `audio ${fmtElapsed(s.audio.samples / s.audio.sampleRate)}` : 'no audio';
    tr.innerHTML = `<td><div class="lbl"></div><div class="note"></div></td><td class="actions"></td>`;
    tr.querySelector('.lbl').textContent = sessionLabel(s);
    tr.querySelector('.note').textContent =
      `${duration} · ${s.observations.length} observation(s) · ${audio}`;
    const rev = document.createElement('button');
    rev.className = 'small';
    rev.textContent = 'Review';
    rev.onclick = () => openReview(s);
    rev.disabled = !s.stoppedMs;
    tr.querySelector('.lbl').style.cursor = s.stoppedMs ? 'pointer' : '';
    tr.querySelector('.lbl').onclick = () => { if (s.stoppedMs) openReview(s); };
    const exp = document.createElement('button');
    exp.className = 'primary small';
    exp.textContent = 'Export';
    exp.onclick = () => exportSession(s);
    const del = document.createElement('button');
    del.className = 'small';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete "${sessionLabel(s)}" from this device? Export it first if you still need it.`)) return;
      await deleteSessionData(s);
      renderSessions();
    };
    tr.querySelector('.actions').append(rev, ' ', exp, ' ', del);
    rows.appendChild(tr);
  }
}

/** The session in the Windows app's backup format (see header comment). */
function backupPayload(s) {
  const at = (elapsed) => localIso(s.liveStartMs + elapsed * 1000);
  return {
    format: 'acoustic-monitoring-session-backup',
    version: 1,
    created_by: `Field Logger ${APP_VERSION}`,
    session: {
      source_filename: null, import_time: null, start_time: null, end_time: null,
      record_count: 0, kind: 'live', offset_seconds: 0,
      live_start: localIso(s.liveStartMs),
      display_name: s.name,
      audio_start: s.audio && s.audio.samples && s.audio.startMs !== null ? localIso(s.audio.startMs) : null,
      // Extra keys the Windows app's plain backup restore ignores; its Field
      // Logger import reads them.
      site_details: s.details || {},
      planned_duration_s: s.plannedSeconds || null,
      position_photos: (s.positionPhotos || []).map((id) => `photos/${id}.jpg`),
    },
    records: [],
    observations: [...s.observations]
      .sort((a, b) => a.elapsed_start - b.elapsed_start)
      .map((o) => ({
        start_time: at(o.elapsed_start),
        end_time: o.elapsed_end !== null ? at(o.elapsed_end) : null,
        elapsed_start: o.elapsed_start,
        elapsed_end: o.elapsed_end,
        time_source: null,
        category: o.category,
        note: o.note,
        excluded: o.excluded ? 1 : 0,
        created_at: localIso(o.created_ms),
        photos: (o.photos || []).map((id) => `photos/${id}.jpg`),
      })),
  };
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function wavHeader(samples, rate) {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); h.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true);
  h.setUint16(34, 16, true); str(36, 'data'); h.setUint32(40, samples * 2, true);
  return new Uint8Array(h.buffer);
}

// CRC-32 for the zip headers.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts) {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip with each file stored uncompressed: {name, parts: [Uint8Array]}. */
function buildZip(files, when) {
  const d = new Date(when);
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const out = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const size = f.parts.reduce((n, p) => n + p.length, 0);
    const crc = crc32(f.parts);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0, true);
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    out.push(new Uint8Array(local.buffer), name, ...f.parts);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint16(8, 0, true); cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true); cen.setUint32(16, crc, true); cen.setUint32(20, size, true);
    cen.setUint32(24, size, true); cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + size;
  }
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true); end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...out, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

async function buildExport(s) {
  const files = [{ name: 'session.amb', parts: [await gzip(JSON.stringify(backupPayload(s)))] }];
  if (s.audio && s.audio.samples) {
    const chunks = (await loadAudioChunks(s.id, s.audio.chunks)).filter(Boolean).map((b) => new Uint8Array(b));
    const samples = chunks.reduce((n, c) => n + c.length / 2, 0);
    files.push({ name: 'audio.wav', parts: [wavHeader(samples, s.audio.sampleRate), ...chunks] });
  }
  const photoIds = [...(s.positionPhotos || []), ...s.observations.flatMap((o) => o.photos || [])];
  for (const id of photoIds) {
    const blob = await loadPhoto(s.id, id);
    if (blob) files.push({ name: `photos/${id}.jpg`, parts: [new Uint8Array(await blob.arrayBuffer())] });
  }
  const safe = (s.name || 'session').replace(/[^A-Za-z0-9 _-]/g, '_').trim() || 'session';
  const d = new Date(s.liveStartMs);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return { blob: buildZip(files, s.liveStartMs), filename: `${safe}_${stamp}_field_log.zip` };
}

// The file is built first, then the operator picks Share or Save with a fresh
// tap. The browser only opens the share sheet straight after a tap, so asking
// first with a pop-up, or building a long recording in between, used to make
// the first attempt fail with "Permission denied".
let exportReady = null;

async function exportSession(s) {
  banner('Preparing the file…', 'warn');
  try {
    const { blob, filename } = await buildExport(s);
    exportReady = { file: new File([blob], filename, { type: 'application/zip' }), blob, filename };
  } catch (e) {
    banner(`Export failed while preparing the file: ${e.message || e}. Try Export again.`, 'err');
    return;
  }
  banner('');
  // Share only on touch devices: desktop browsers often offer it but then
  // refuse files ("Permission denied"), so there Save is the only button.
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const canShare = touch && !!(navigator.canShare && navigator.canShare({ files: [exportReady.file] }));
  $('export-name').textContent =
    `${exportReady.filename} (${(exportReady.blob.size / 1048576).toFixed(1)} MB)`;
  $('export-share').classList.toggle('hidden', !canShare);
  $('export-dialog').showModal();
}

async function shareExport() {
  $('export-dialog').close();
  try {
    await navigator.share({ files: [exportReady.file], title: exportReady.filename });
    banner(`Shared ${exportReady.filename}. Import it in the Acoustic Monitoring Software on the laptop.`, 'warn');
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // share sheet closed without choosing
    // Sharing refused: save the file instead, so the export still succeeds.
    saveExport();
    banner(`Sharing wasn't allowed (${e.message || e}), so the file was saved to Downloads instead: ` +
           `${exportReady.filename}. To share directly next time, allow this site to share in your ` +
           'browser’s site settings.', 'warn');
  }
}

function saveExport() {
  $('export-dialog').close();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(exportReady.blob);
  a.download = exportReady.filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  banner(`Saved ${exportReady.filename} to Downloads. Import it in the Acoustic Monitoring Software on the laptop.`,
         'warn');
}

// ── Start-up ────────────────────────────────────────────────────────────────

async function resumeUnfinished() {
  // A session still open after a reload or crash carries on logging; its
  // elapsed time comes from the wall clock, so nothing is lost but the audio
  // from the moment the page closed until now.
  const open = (await loadSessions()).find((s) => !s.stoppedMs);
  if (!open) return;
  // Ask rather than assume: a session left open yesterday shouldn't quietly
  // carry on today. Ending it closes it at the last thing it recorded.
  const lastMs = Math.max(open.liveStartMs,
    ...open.observations.map((o) => open.liveStartMs + (o.elapsed_end ?? o.elapsed_start) * 1000),
    open.audio && open.audio.startMs !== null
      ? open.audio.startMs + (open.audio.samples / open.audio.sampleRate) * 1000 : 0);
  const ago = fmtElapsed((Date.now() - lastMs) / 1000);
  if (!confirm(`A session started at ${sessionLabel(open)} was still running when the app closed ` +
               `(last activity ${ago} ago).\n\nOK: carry on logging it.\n` +
               `Cancel: end it at its last activity and keep it in Saved sessions.`)) {
    open.stoppedMs = lastMs;
    await saveSession(open);
    await renderSessions();
    return;
  }
  session = open;
  rangeStart = pauseStart = null;
  renderObservations();
  showView('live');
  timerHandle = setInterval(tick, 250);
  tick();
  keepAwake();
  if (session.audio && session.audio.startMs !== null) {
    // The browser only lets the microphone restart after a tap.
    $('audio-text').textContent = 'Audio paused when the app closed';
    $('btn-resume-audio').classList.remove('hidden');
    banner('The app was closed while logging. The session carried on and every observation is kept. ' +
           'Tap "Resume audio" to carry on recording; the gap is filled with silence so the timing stays right.',
           'warn');
  } else {
    $('audio-text').textContent = 'Audio off';
    banner('The app was closed while logging. The session carried on and every observation is kept.', 'warn');
  }
}

async function resumeAudio() {
  $('btn-resume-audio').classList.add('hidden');
  $('audio-text').textContent = 'Restarting microphone…';
  try {
    await startAudio(true);
    $('audio-text').textContent = 'Recording audio';
    banner('');
  } catch (e) {
    $('audio-text').textContent = 'Audio unavailable';
    banner(`The microphone could not be restarted (${e.message || e}). Observations are still being logged.`, 'warn');
  }
}

// Whether this device holds a complete copy of the app, so the operator knows
// before going on site that it will open with no connection.
let offlineReady = false;
const ESSENTIAL_FILES = ['./', 'index.html', 'app.js', 'recorder-worklet.js'];

async function checkOfflineReady() {
  try {
    if (!('caches' in window)) return;
    const cache = await caches.open('field-logger');
    const hits = await Promise.all(ESSENTIAL_FILES.map((f) => cache.match(new URL(f, location.href).href)));
    offlineReady = hits.every(Boolean);
  } catch (e) { offlineReady = false; }
  updateOfflineState();
}

function updateOfflineState() {
  const el = $('offline-state');
  if (offlineReady) {
    el.textContent = navigator.onLine ? 'Ready offline ✓' : 'Offline ✓';
    el.style.color = 'var(--ok)';
  } else {
    el.textContent = navigator.onLine ? 'Saving for offline use…'
                                      : 'Offline: not fully saved, reconnect once';
    el.style.color = navigator.onLine ? '' : 'var(--danger)';
  }
}

async function main() {
  buildChips($('chips'));
  buildChips($('edit-chips'));
  $('btn-start').onclick = startSession;
  $('btn-moment').onclick = logMoment;
  $('btn-range').onclick = toggleRange;
  $('btn-pause').onclick = togglePause;
  $('btn-stop').onclick = stopSession;
  $('edit-save').onclick = saveEdit;
  $('edit-cancel').onclick = () => $('edit-dialog').close();
  $('edit-delete').onclick = deleteEdit;
  $('btn-resume-audio').onclick = resumeAudio;
  $('btn-details-start').onclick = () => openDetails(null);
  $('btn-details-live').onclick = () => openDetails(session);
  $('btn-details-review').onclick = () => openDetails(reviewing);
  $('details-save').onclick = saveDetails;
  $('details-cancel').onclick = () => $('details-dialog').close();
  $('details-add-photo').onclick = () => {
    const s = detailsTarget;
    s.positionPhotos = s.positionPhotos || [];
    takePhoto(s, s.positionPhotos, () => renderPhotos($('position-photos'), s, s.positionPhotos));
  };
  $('edit-add-photo').onclick = addEditPhoto;
  $('photo-input').addEventListener('change', onPhotoChosen);
  $('photo-delete').onclick = deleteShownPhoto;
  $('photo-close').onclick = () => $('photo-dialog').close();
  loadRemembered();
  refreshDetailsSummary();
  $('edit-play').onclick = () => playObservation(editingSession, editing, $('edit-play'));
  $('review-back').onclick = closeReview;
  $('review-export').onclick = () => exportSession(reviewing);
  $('edit-dialog').addEventListener('close', stopPlayback);
  $('export-share').onclick = shareExport;
  $('export-save').onclick = saveExport;
  $('export-cancel').onclick = () => $('export-dialog').close();
  $('btn-help').onclick = () => $('help-dialog').showModal();
  $('help-close').onclick = () => $('help-dialog').close();
  window.addEventListener('online', updateOfflineState);
  window.addEventListener('offline', updateOfflineState);
  updateOfflineState();

  if (!window.isSecureContext) {
    banner('This page must be opened from an https:// address (or localhost) for the microphone ' +
           'and offline use to work.', 'err');
  }
  try {
    db = await openDb();
  } catch (e) {
    banner(`This browser blocked local storage, so sessions can't be saved: ${e.message || e}`, 'err');
    return;
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(() => { checkOfflineReady(); setTimeout(checkOfflineReady, 3000); })
      .catch(() => {});
    checkOfflineReady();
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  await renderSessions();
  await resumeUnfinished();
}

// Exposed for automated checks; not used by the page itself.
window.fieldLogger = { backupPayload, buildExport, localIso, resumeUnfinished, loadSessions, readAudio,
                        savePhoto, saveSession: (s) => saveSession(s) };

main();
