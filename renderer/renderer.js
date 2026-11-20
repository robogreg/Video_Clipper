const $ = (id) => document.getElementById(id);
const video = $('video');
const thumbVideo = $('thumbVideo');
const track = $('track');
const strip = $('strip');

const MIN_LEN = 0.1; // shortest allowed clip, seconds
const FRAME = 1 / 30;

let file = null;      // { path, url, name, info }
let dur = 0;
let start = 0;
let end = 0;
let drag = null;      // 'start' | 'end' | 'scrub'
let grabOffset = 0;
let pendingSeek = null;
let thumbJob = 0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fmt(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const headTime = () => (pendingSeek != null ? pendingSeek : video.currentTime);

// ---------- loading ----------

function openFile(data) {
  if (!data) return;
  file = data;
  dur = 0;
  thumbJob++;
  video.pause();
  $('empty').hidden = true;
  $('previewError').hidden = true;
  video.hidden = false;
  $('editor').classList.add('disabled');
  $('fileName').textContent = data.name;
  document.title = `${data.name} — Video Clipper`;
  const i = data.info;
  $('fileInfo').textContent = [i.width && `${i.width}×${i.height}`, i.codec && i.codec.toUpperCase()].filter(Boolean).join(' · ');
  strip.getContext('2d').clearRect(0, 0, strip.width, strip.height);
  video.src = data.url;
  thumbVideo.src = data.url;
}

video.addEventListener('loadedmetadata', () => {
  dur = Number.isFinite(video.duration) ? video.duration : file.info.duration;
  if (!dur || !video.videoWidth) return showPreviewError();
  start = 0;
  end = dur;
  $('editor').classList.remove('disabled');
  $('fileInfo').textContent += ` · ${fmt(dur)}`;
  layout();
  buildThumbs();
});

video.addEventListener('error', showPreviewError);

function showPreviewError() {
  dur = 0;
  video.hidden = true;
  $('previewError').hidden = false;
  $('editor').classList.add('disabled');
}

// ---------- timeline drawing ----------

function layout() {
  if (!dur) return;
  const W = track.clientWidth;
  const xs = (start / dur) * W;
  const xe = (end / dur) * W;
  $('sel').style.left = xs + 'px';
  $('sel').style.width = (xe - xs) + 'px';
  $('dimL').style.width = xs + 'px';
  $('dimR').style.left = xe + 'px';
  $('dimR').style.width = (W - xe) + 'px';
  $('playhead').style.left = (clamp(headTime() / dur, 0, 1) * W) + 'px';
  $('curTime').textContent = fmt(headTime());
  $('range').textContent = `${fmt(start)} → ${fmt(end)}  (${fmt(end - start)})`;
  $('playBtn').textContent = video.paused ? '▶' : '❚❚';
}

function seekOnce(v, t) {
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

async function buildThumbs() {
  const job = ++thumbJob;
  if (thumbVideo.readyState < 1) {
    await new Promise((r) => thumbVideo.addEventListener('loadedmetadata', r, { once: true }));
  }
  if (job !== thumbJob || !dur) return;
  const dpr = window.devicePixelRatio || 1;
  const W = track.clientWidth;
  const H = track.clientHeight;
  strip.width = Math.round(W * dpr);
  strip.height = Math.round(H * dpr);
  const ctx = strip.getContext('2d');
  const aspect = thumbVideo.videoWidth / thumbVideo.videoHeight || 16 / 9;
  const tw = H * aspect;
  const n = Math.ceil(W / tw);
  for (let i = 0; i < n; i++) {
    const t = clamp(((i + 0.5) * tw / W) * dur, 0, Math.max(0, dur - 0.05));
    await seekOnce(thumbVideo, t);
    if (job !== thumbJob) return;
    ctx.drawImage(thumbVideo, Math.round(i * tw * dpr), 0, Math.ceil(tw * dpr), strip.height);
  }
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  layout();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildThumbs, 250);
});

// ---------- seeking / playback ----------

function seekTo(t) {
  t = clamp(t, 0, dur);
  if (video.seeking) pendingSeek = t;
  else { pendingSeek = null; video.currentTime = t; }
  layout();
}

video.addEventListener('seeked', () => {
  if (pendingSeek != null) {
    const t = pendingSeek;
    pendingSeek = null;
    video.currentTime = t;
  }
  layout();
});

function togglePlay() {
  if (!dur) return;
  if (video.paused) {
    const t = video.currentTime;
    if (t < start - 0.01 || t >= end - 0.05) video.currentTime = start;
    video.play();
  } else {
    video.pause();
  }
}

function tick() {
  if (!video.paused) {
    if (video.currentTime >= end) {
      video.pause();
      video.currentTime = end;
    }
    layout();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

video.addEventListener('pause', layout);
video.addEventListener('play', layout);
video.addEventListener('click', togglePlay);

// ---------- trim handles & scrubbing ----------

function setStart(t) {
  start = clamp(t, 0, dur - MIN_LEN);
  if (end < start + MIN_LEN) end = dur;
  layout();
}

function setEnd(t) {
  end = clamp(t, MIN_LEN, dur);
  if (start > end - MIN_LEN) start = 0;
  layout();
}

function pointerTime(e) {
  const r = track.getBoundingClientRect();
  return ((e.clientX - r.left - grabOffset) / r.width) * dur;
}

track.addEventListener('pointerdown', (e) => {
  if (!dur || e.button !== 0) return;
  const handle = e.target.closest('.handle');
  const r = track.getBoundingClientRect();
  grabOffset = 0;
  if (handle) {
    drag = handle.classList.contains('l') ? 'start' : 'end';
    const t = drag === 'start' ? start : end;
    grabOffset = (e.clientX - r.left) - (t / dur) * r.width;
  } else {
    drag = 'scrub';
  }
  track.setPointerCapture(e.pointerId);
  video.pause();
  onDrag(e);
});

function onDrag(e) {
  if (!drag) return;
  const t = pointerTime(e);
  if (drag === 'start') {
    start = clamp(t, 0, end - MIN_LEN);
    seekTo(start);
  } else if (drag === 'end') {
    end = clamp(t, start + MIN_LEN, dur);
    seekTo(end);
  } else {
    seekTo(t);
  }
}

track.addEventListener('pointermove', onDrag);
const endDrag = () => { drag = null; };
track.addEventListener('pointerup', endDrag);
track.addEventListener('pointercancel', endDrag);

// ---------- buttons & keys ----------

for (const b of document.querySelectorAll('button')) b.addEventListener('click', () => b.blur());

$('openBtn').addEventListener('click', async () => openFile(await window.clipper.openDialog()));
$('playBtn').addEventListener('click', togglePlay);
$('setStart').addEventListener('click', () => setStart(headTime()));
$('setEnd').addEventListener('click', () => setEnd(headTime()));

window.addEventListener('keydown', (e) => {
  if (!$('overlay').hidden) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); $('openBtn').click(); return; }
  if (!dur) return;
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); video.pause(); seekTo(headTime() - (e.shiftKey ? 1 : FRAME)); break;
    case 'ArrowRight': e.preventDefault(); video.pause(); seekTo(headTime() + (e.shiftKey ? 1 : FRAME)); break;
    case 'KeyI': setStart(headTime()); break;
    case 'KeyO': setEnd(headTime()); break;
  }
});

// ---------- drag & drop ----------

const stage = $('stage');
window.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
window.addEventListener('dragleave', () => stage.classList.remove('drop'));
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  stage.classList.remove('drop');
  const f = e.dataTransfer.files[0];
  if (f) openFile(await window.clipper.openDropped(f));
});

window.clipper.onOpenFile(openFile);

// ---------- export ----------

let savedPath = null;

function showDialog({ title, msg = '', busy = false, done = false }) {
  $('overlay').hidden = false;
  $('dlgTitle').textContent = title;
  $('dlgMsg').textContent = msg;
  $('barWrap').hidden = !busy && !done;
  $('dlgCancel').hidden = !busy;
  $('dlgShow').hidden = !done;
  $('dlgClose').hidden = busy;
}

window.clipper.onProgress((p) => {
  if ($('overlay').hidden) showDialog({ title: 'Saving…', busy: true });
  $('bar').style.width = (p * 100).toFixed(1) + '%';
});

$('exportBtn').addEventListener('click', async () => {
  if (!dur) return;
  video.pause();
  $('bar').style.width = '0';
  const r = await window.clipper.exportClip({ file: file.path, start, end, fast: $('fast').checked });
  if (r.canceled) { $('overlay').hidden = true; return; }
  if (r.error) return showDialog({ title: 'Couldn’t save the video', msg: r.error });
  savedPath = r.out;
  $('bar').style.width = '100%';
  showDialog({ title: 'Saved', msg: r.out, done: true });
});

$('dlgCancel').addEventListener('click', () => window.clipper.cancelExport());
$('dlgClose').addEventListener('click', () => { $('overlay').hidden = true; });
$('dlgShow').addEventListener('click', () => window.clipper.showInFolder(savedPath));
