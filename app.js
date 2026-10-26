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
// sessions: {id, name, liveStartMs, stoppedMs, observations[], audio}
// audio:    {key: [sessionId, index], data: ArrayBuffer of Int16 samples}

let db;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('field-logger', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('sessions', { keyPath: 'id' });
      d.createObjectStore('audio');
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
}

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
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    elapsed_start: elapsedStart,
    elapsed_end: elapsedEnd,
    note: (note || '').trim() || PLACEHOLDER_NOTE,
    category,
    excluded: !!excluded,
    created_ms: Date.now(),
  });
  saveSession(session);
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
}

function renderObservations() {
  const list = $('obs-list');
  list.innerHTML = '';
  const obs = [...session.observations].sort((a, b) => b.elapsed_start - a.elapsed_start);
  $('no-obs').classList.toggle('hidden', obs.length > 0);
  for (const o of obs) {
    const li = document.createElement('li');
    const when = o.elapsed_end !== null
      ? `${fmtElapsed(o.elapsed_start)}–${fmtElapsed(o.elapsed_end)}` : fmtElapsed(o.elapsed_start);
    li.innerHTML = `<div class="when"></div><div class="what"><div class="txt"></div>
      <div class="cat"></div></div>`;
    li.querySelector('.when').textContent = when;
    li.querySelector('.txt').textContent = o.note;
    li.querySelector('.cat').textContent = o.category;
    if (o.excluded) {
      const ex = document.createElement('span');
      ex.className = 'excl';
      ex.textContent = '  EXCLUDED';
      li.querySelector('.cat').appendChild(ex);
    }
    li.onclick = () => openEditor(o);
    list.appendChild(li);
  }
}

function showView(live) {
  $('view-start').classList.toggle('hidden', live);
  $('view-live').classList.toggle('hidden', !live);
}

async function startSession() {
  const name = $('session-name').value.trim();
  session = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: name || null,
    liveStartMs: Date.now(),
    stoppedMs: null,
    observations: [],
    audio: null,
    appVersion: APP_VERSION,
  };
  rangeStart = pauseStart = null;
  await saveSession(session);
  clearEntry();
  $('btn-range').textContent = 'START RANGE';
  $('btn-pause').textContent = 'Pause logging';
  renderObservations();
  showView(true);
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
  await stopAudio();
  session.stoppedMs = Date.now();
  await saveSession(session);
  clearInterval(timerHandle);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  session = null;
  $('session-name').value = '';
  showView(false);
  await renderSessions();
  banner('Session saved. Use Export to get the file for the laptop.', 'warn');
}

// ── Editing an observation ──────────────────────────────────────────────────

let editing = null;

function openEditor(o) {
  editing = o;
  const when = o.elapsed_end !== null
    ? `${fmtElapsed(o.elapsed_start)} to ${fmtElapsed(o.elapsed_end)}` : `at ${fmtElapsed(o.elapsed_start)}`;
  $('edit-title').textContent = `Observation ${when}`;
  $('edit-note').value = o.note === PLACEHOLDER_NOTE ? '' : o.note;
  setChips($('edit-chips'), o.category);
  $('edit-exclude').checked = o.excluded;
  $('edit-dialog').showModal();
}

function saveEdit() {
  editing.note = $('edit-note').value.trim() || PLACEHOLDER_NOTE;
  editing.category = selectedCategories($('edit-chips'));
  editing.excluded = $('edit-exclude').checked;
  saveSession(session);
  renderObservations();
  $('edit-dialog').close();
}

function deleteEdit() {
  if (!confirm('Delete this observation?')) return;
  session.observations = session.observations.filter((o) => o !== editing);
  saveSession(session);
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
    tr.querySelector('.actions').append(exp, ' ', del);
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
  const safe = (s.name || 'session').replace(/[^A-Za-z0-9 _-]/g, '_').trim() || 'session';
  const d = new Date(s.liveStartMs);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return { blob: buildZip(files, s.liveStartMs), filename: `${safe}_${stamp}_field_log.zip` };
}

async function exportSession(s) {
  try {
    const { blob, filename } = await buildExport(s);
    const file = new File([blob], filename, { type: 'application/zip' });
    // Offer the device's share sheet where available (email, Drive, Nearby
    // Share); otherwise save it to Downloads.
    if (navigator.canShare && navigator.canShare({ files: [file] }) &&
        confirm('Share the file (email, cloud drive, Nearby Share)?\n\nCancel saves it to Downloads instead.')) {
      await navigator.share({ files: [file], title: filename });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }
    banner(`Exported ${filename}. Import it in the Acoustic Monitoring Software on the laptop.`, 'warn');
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // share sheet cancelled
    banner(`Export failed: ${e.message || e}`, 'err');
  }
}

// ── Start-up ────────────────────────────────────────────────────────────────

async function resumeUnfinished() {
  // A session still open after a reload or crash carries on logging; its
  // elapsed time comes from the wall clock, so nothing is lost but the audio
  // from the moment the page closed until now.
  const open = (await loadSessions()).find((s) => !s.stoppedMs);
  if (!open) return;
  session = open;
  rangeStart = pauseStart = null;
  renderObservations();
  showView(true);
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

function updateOfflineState() {
  $('offline-state').textContent = navigator.onLine ? '' : 'Offline';
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
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  await renderSessions();
  await resumeUnfinished();
}

// Exposed for automated checks; not used by the page itself.
window.fieldLogger = { backupPayload, buildExport, localIso };

main();
