/* مَشهد — محرر فيديو عربي (كل المعالجة في المتصفح) */
(() => {
'use strict';

const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2,10);
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const fmt = t => {
  t = Math.max(0, t||0);
  const m = Math.floor(t/60), s = Math.floor(t%60), d = Math.floor((t%1)*10);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${d}`;
};
const toast = (m) => {
  const t = $('#toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(()=>t.classList.remove('show'), 2200);
};

const ASPECT = {'9:16':[9,16],'16:9':[16,9],'1:1':[1,1]};
const FILTERS = {
  none:{b:100,c:100,s:100,n:'بدون'},
  vivid:{b:105,c:120,s:140,n:'حيوي'},
  warm:{b:108,c:105,s:120,n:'دافئ'},
  cool:{b:100,c:110,s:90,n:'بارد'},
  mono:{b:100,c:110,s:0,n:'أبيض وأسود'},
  soft:{b:110,c:90,s:90,n:'ناعم'},
  night:{b:85,c:120,s:80,n:'ليلي'},
};
const TRANS = [{id:'none',n:'بدون'},{id:'fade',n:'تلاشي'},{id:'slideL',n:'انزلاق ←'},{id:'slideR',n:'انزلاق →'}];
const EMOJIS = '😀😂😍🔥✨🌟❤️👏🎉🎵🚀🌙⭐🏜️🐪🌅🏍️🎯✅💡🎬📸🌈🌊🌴☕'.split('');

const state = {
  aspect: '9:16',
  pxPerSec: 60,
  t: 0,
  playing: false,
  selected: null,
  media: [], // {id,type,name,url,blob,duration,el}
  clips: [], // video/image on video track
  overlays: [], // text/sticker
  audios: [],
  history: [],
  future: [],
  filter: {b:100,c:100,s:100, preset:'none'},
  speed: 1,
};

const canvas = $('#preview');
const ctx = canvas.getContext('2d');
const wrap = $('.preview-wrap');
let raf = 0, lastTs = 0;
const DRIFT_SEC = 0.25;

/* Single shared Web Audio graph — one source node per media element, forever */
const AudioGraph = {
  ctx: null, master: null, compressor: null, streamDest: null,
  nodes: new Map(), // mediaId -> {source, gain}
  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8; // headroom before limiter
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.2;
    this.streamDest = this.ctx.createMediaStreamDestination();
    this.master.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);
    this.compressor.connect(this.streamDest);
    return this.ctx;
  },
  async resume() {
    this.ensure();
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (e) {}
    }
  },
  attach(item) {
    if (!item || !item.el || item.type === 'image') return null;
    if (this.nodes.has(item.id)) return this.nodes.get(item.id);
    this.ensure();
    try {
      const source = this.ctx.createMediaElementSource(item.el);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this.master);
      // Element output is rerouted through the graph; keep element gain flat
      item.el.muted = false;
      item.el.volume = 1;
      if ('preservesPitch' in item.el) item.el.preservesPitch = true;
      if ('mozPreservesPitch' in item.el) item.el.mozPreservesPitch = true;
      if ('webkitPreservesPitch' in item.el) item.el.webkitPreservesPitch = true;
      const node = { source, gain };
      this.nodes.set(item.id, node);
      return node;
    } catch (e) {
      console.warn('AudioGraph.attach', e);
      return null;
    }
  },
  setGain(mediaId, v) {
    const n = this.nodes.get(mediaId);
    if (!n) return;
    const g = clamp(v, 0, 1);
    if (n._lastGain != null && Math.abs(n._lastGain - g) < 0.01) return;
    n._lastGain = g;
    const param = n.gain.gain;
    const now = this.ctx.currentTime;
    try {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(g, now, 0.02); // short ramp avoids clicks
    } catch (e) {
      param.value = g;
    }
  }
};


function totalDur() {
  let d = 0;
  for (const c of state.clips) d = Math.max(d, c.start + clipDur(c));
  for (const c of state.overlays) d = Math.max(d, c.start + clipDur(c));
  for (const c of state.audios) d = Math.max(d, c.start + clipDur(c));
  return Math.max(d, 0.1);
}
function clipDur(c) {
  if (c.type === 'text' || c.type === 'sticker') return c.duration;
  const raw = (c.trimEnd - c.trimStart);
  return Math.max(0.05, raw / (c.speed || 1));
}
function pushHist() {
  const snap = JSON.stringify({
    clips: state.clips, overlays: state.overlays, audios: state.audios,
    filter: state.filter, speed: state.speed, aspect: state.aspect
  });
  state.history.push(snap);
  if (state.history.length > 40) state.history.shift();
  state.future = [];
}
function restore(snap) {
  const o = JSON.parse(snap);
  state.clips = o.clips; state.overlays = o.overlays; state.audios = o.audios;
  state.filter = o.filter; state.speed = o.speed; state.aspect = o.aspect;
  $('#aspect').value = state.aspect;
  applyAspect();
  renderTimeline(); renderPanel(); draw(); saveProject();
}

function applyAspect() {
  const [w,h] = ASPECT[state.aspect];
  wrap.classList.remove('r169','r11');
  if (state.aspect === '16:9') wrap.classList.add('r169');
  if (state.aspect === '1:1') wrap.classList.add('r11');
  const long = 1280, short = Math.round(long * Math.min(w,h) / Math.max(w,h));
  if (w > h) { canvas.width = long; canvas.height = short; }
  else if (w < h) { canvas.width = short; canvas.height = long; }
  else { canvas.width = long; canvas.height = long; }
  draw();
}

/* ---------- Media import ---------- */
async function importFiles(files) {
  for (const f of files) {
    const type = f.type.startsWith('video') ? 'video' : f.type.startsWith('audio') ? 'audio' : f.type.startsWith('image') ? 'image' : null;
    if (!type) { toast('نوع غير مدعوم: '+f.name); continue; }
    const url = URL.createObjectURL(f);
    const id = uid();
    let duration = 3, el = null;
    if (type === 'video' || type === 'audio') {
      el = document.createElement(type === 'video' ? 'video' : 'audio');
      el.preload = 'auto'; el.src = url; el.muted = false; el.volume = 1;
      if ('preservesPitch' in el) el.preservesPitch = true;
      if ('mozPreservesPitch' in el) el.mozPreservesPitch = true;
      await new Promise(r => { el.onloadedmetadata = r; el.onerror = r; setTimeout(r, 4000); });
      duration = isFinite(el.duration) ? el.duration : 3;
      if (type === 'video') { try { el.currentTime = Math.min(0.15, duration/4); } catch(e){} }
    } else {
      el = new Image(); el.src = url;
      await new Promise(r => { el.onload = r; el.onerror = r; });
      duration = 3;
    }
    const item = {id, type, name: f.name, url, blob: f, duration, el};
    state.media.push(item);
    AudioGraph.attach(item);
    try { await DB.put('media', id, f); } catch(e){}
    // auto add to timeline
    if (type === 'audio') addAudioClip(item);
    else addAVClip(item);
  }
  $('#empty').classList.toggle('hidden', state.clips.length > 0);
  renderTimeline(); renderPanel(); draw(); saveProject();
  toast('تمت إضافة الوسائط');
}

function addAVClip(item) {
  pushHist();
  const start = state.clips.reduce((m,c)=>Math.max(m, c.start + clipDur(c)), 0);
  state.clips.push({
    id: uid(), mediaId: item.id, type: item.type, name: item.name,
    start, trimStart: 0, trimEnd: item.duration,
    speed: state.speed, transition: 'none', vol: 0.85
  });
}
function addAudioClip(item) {
  pushHist();
  const start = state.audios.reduce((m,c)=>Math.max(m, c.start + clipDur(c)), 0);
  state.audios.push({
    id: uid(), mediaId: item.id, type: 'audio', name: item.name,
    start, trimStart: 0, trimEnd: item.duration, speed: 1, vol: 0.4
  });
}

function mediaOf(c) { return state.media.find(m => m.id === c.mediaId); }

/* ---------- Timeline UI ---------- */
function renderTimeline() {
  const px = state.pxPerSec;
  const dur = Math.max(totalDur() + 2, 8);
  const width = Math.ceil(dur * px) + 60;
  const ruler = $('#ruler');
  ruler.style.width = width + 'px';
  ruler.innerHTML = '';
  for (let t=0; t<=dur; t++) {
    const s = document.createElement('span');
    s.style.left = (52 + t*px) + 'px';
    s.textContent = fmt(t).slice(0,5);
    ruler.appendChild(s);
  }
  const tracks = [
    {el: $('#trk-video'), list: state.clips, kind: 'av'},
    {el: $('#trk-overlay'), list: state.overlays, kind: 'ov'},
    {el: $('#trk-audio'), list: state.audios, kind: 'au'},
  ];
  for (const tr of tracks) {
    tr.el.style.width = width + 'px';
    $$('.clip', tr.el).forEach(n => n.remove());
    for (const c of tr.list) {
      const d = clipDur(c);
      const div = document.createElement('div');
      div.className = 'clip ' + (c.type === 'text' || c.type === 'sticker' ? 'overlay' : c.type);
      if (state.selected === c.id) div.classList.add('selected');
      div.style.left = (52 + c.start * px) + 'px';
      div.style.width = Math.max(18, d * px) + 'px';
      div.dataset.id = c.id;
      const label = c.type === 'sticker' ? c.text : (c.type === 'text' ? (c.text||'نص').slice(0,18) : (c.name||'').slice(0,14));
      div.innerHTML = `<i class="h l"></i><span>${label}</span><i class="h r"></i>`;
      bindClipDrag(div, c);
      tr.el.appendChild(div);
    }
  }
  updatePlayhead();
  $('#tdur').textContent = fmt(totalDur());
  $('#tcur').textContent = fmt(state.t);
}

function updatePlayhead() {
  const x = 52 + state.t * state.pxPerSec;
  $('#playhead').style.left = x + 'px';
}

function bindClipDrag(div, clip) {
  let mode = null, sx=0, sStart=0, sTrim0=0, sTrim1=0;
  const onDown = (e) => {
    const t = e.target;
    mode = t.classList.contains('h') ? (t.classList.contains('l') ? 'L' : 'R') : 'M';
    state.selected = clip.id;
    renderTimeline(); renderPanel();
    sx = (e.touches?e.touches[0]:e).clientX;
    sStart = clip.start; sTrim0 = clip.trimStart; sTrim1 = clip.trimEnd;
    e.preventDefault();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, {passive:false});
    window.addEventListener('touchend', onUp);
  };
  const onMove = (e) => {
    const x = (e.touches?e.touches[0]:e).clientX;
    const dx = (x - sx) / state.pxPerSec;
    if (mode === 'M') {
      clip.start = Math.max(0, sStart + dx);
    } else if (clip.type === 'text' || clip.type === 'sticker') {
      if (mode === 'R') clip.duration = Math.max(0.3, (clip.duration||1) + dx - (clip.start - sStart)*0);
      // simplify: duration resize via right handle relative
      if (mode === 'R') {
        const nd = Math.max(0.3, (sTrim1 - sTrim0 || clip.duration) + dx);
        clip.duration = nd;
      }
    } else {
      const med = mediaOf(clip);
      const max = med ? med.duration : 60;
      if (mode === 'L') {
        const nt = clamp(sTrim0 + dx, 0, sTrim1 - 0.1);
        const dTrim = nt - sTrim0;
        clip.trimStart = nt;
        clip.start = Math.max(0, sStart + dTrim / (clip.speed||1));
      } else if (mode === 'R') {
        clip.trimEnd = clamp(sTrim1 + dx * (clip.speed||1), clip.trimStart + 0.1, max);
      }
    }
    renderTimeline();
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
    pushHist(); saveProject(); draw();
  };
  div.addEventListener('mousedown', onDown);
  div.addEventListener('touchstart', onDown, {passive:false});
  div.addEventListener('click', e => { e.stopPropagation(); state.selected = clip.id; renderTimeline(); renderPanel(); });
}

$('#timeline').addEventListener('click', e => {
  if (e.target.closest('.clip')) return;
  const rect = $('#timeline').getBoundingClientRect();
  const x = e.clientX - rect.left + $('#timeline').scrollLeft - 52;
  seek(Math.max(0, x / state.pxPerSec));
});

function seek(t) {
  state.t = clamp(t, 0, totalDur());
  updatePlayhead();
  $('#tcur').textContent = fmt(state.t);
  syncMedia(state.t);
  draw();
}

/* ---------- Playback & draw ---------- */
function findActiveClip(list, t) {
  return list.find(c => t >= c.start && t < c.start + clipDur(c));
}
function localTime(c, t) {
  const rel = (t - c.start) * (c.speed || 1);
  return (c.trimStart || 0) + rel;
}

function syncMedia(t, opts) {
  const forceSeek = opts && opts.forceSeek;
  AudioGraph.ensure();
  const wanted = new Map(); // mediaId -> {lt, rate, vol}

  const vc = findActiveClip(state.clips, t);
  if (vc && vc.type === 'video') {
    const m = mediaOf(vc);
    if (m && m.el) {
      AudioGraph.attach(m);
      wanted.set(m.id, {
        lt: localTime(vc, t),
        rate: vc.speed || 1,
        vol: Math.min(1, vc.vol ?? 0.85)
      });
    }
  }
  for (const ac of state.audios) {
    if (t >= ac.start && t < ac.start + clipDur(ac)) {
      const m = mediaOf(ac);
      if (m && m.el) {
        AudioGraph.attach(m);
        wanted.set(m.id, {
          lt: localTime(ac, t),
          rate: ac.speed || 1,
          // lower default BGM to avoid clipping when mixed with clip audio
          vol: Math.min(1, ac.vol ?? 0.4)
        });
      }
    }
  }

  for (const m of state.media) {
    if (!m.el || typeof m.el.pause !== 'function') continue;
    const w = wanted.get(m.id);
    if (!w) {
      if (!m.el.paused) {
        try { m.el.pause(); } catch (e) {}
      }
      AudioGraph.setGain(m.id, 0);
      continue;
    }
    try {
      if ('preservesPitch' in m.el) m.el.preservesPitch = true;
      if (Math.abs((m.el.playbackRate || 1) - w.rate) > 0.001) {
        m.el.playbackRate = w.rate;
      }
      const drift = Math.abs((m.el.currentTime || 0) - w.lt);
      if (forceSeek || drift > DRIFT_SEC) {
        try { m.el.currentTime = Math.max(0, w.lt); } catch (e) {}
      }
      if (state.playing) {
        AudioGraph.setGain(m.id, w.vol);
        if (m.el.paused) m.el.play().catch(() => {});
      } else {
        AudioGraph.setGain(m.id, 0);
        if (!m.el.paused) m.el.pause();
      }
    } catch (e) {}
  }
}

function drawFrameAt(t, targetCtx, W, H) {
  const g = targetCtx;
  g.fillStyle = '#000'; g.fillRect(0,0,W,H);
  const vc = findActiveClip(state.clips, t);
  let alpha = 1, slide = 0;
  if (vc) {
    const into = t - vc.start;
    const left = clipDur(vc) - into;
    if (vc.transition === 'fade') {
      if (into < 0.4) alpha = into / 0.4;
      if (left < 0.4) alpha = Math.min(alpha, left / 0.4);
    } else if (vc.transition === 'slideL' && into < 0.4) {
      slide = (1 - into/0.4) * W;
    } else if (vc.transition === 'slideR' && into < 0.4) {
      slide = -(1 - into/0.4) * W;
    }
    const m = mediaOf(vc);
    if (m && m.el) {
      g.save();
      g.globalAlpha = alpha;
      g.filter = `brightness(${state.filter.b}%) contrast(${state.filter.c}%) saturate(${state.filter.s}%)`;
      const el = m.el;
      const ew = el.videoWidth || el.naturalWidth || W;
      const eh = el.videoHeight || el.naturalHeight || H;
      const scale = Math.max(W/ew, H/eh);
      const dw = ew*scale, dh = eh*scale;
      g.drawImage(el, (W-dw)/2 + slide, (H-dh)/2, dw, dh);
      g.restore();
    }
  }
  // overlays
  for (const o of state.overlays) {
    if (t < o.start || t >= o.start + clipDur(o)) continue;
    const prog = (t - o.start) / clipDur(o);
    let oa = 1, oy = 0;
    if (o.anim === 'fade') {
      if (prog < 0.15) oa = prog/0.15;
      if (prog > 0.85) oa = (1-prog)/0.15;
    } else if (o.anim === 'up') {
      oy = (1 - Math.min(1, prog/0.2)) * 40;
      oa = Math.min(1, prog/0.2);
    } else if (o.anim === 'pop') {
      const s = prog < 0.2 ? 0.5 + prog*2.5 : 1;
      g.save(); g.translate(W/2, H/2); g.scale(s,s); g.translate(-W/2,-H/2);
    }
    g.save();
    g.globalAlpha = oa;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.direction = 'rtl';
    const x = (o.x ?? 0.5) * W;
    const y = (o.y ?? 0.5) * H + oy;
    if (o.type === 'sticker') {
      g.font = `${Math.round((o.size||64)/100 * Math.min(W,H)*0.18)}px Cairo,sans-serif`;
      g.fillText(o.text, x, y);
    } else {
      const fs = Math.round((o.size||40)/100 * Math.min(W,H)*0.12);
      g.font = `700 ${fs}px Cairo,sans-serif`;
      g.lineWidth = Math.max(2, fs*0.08);
      g.strokeStyle = o.stroke || '#000';
      g.fillStyle = o.color || '#fff';
      const lines = String(o.text||'').split('\n');
      lines.forEach((ln,i) => {
        const yy = y + (i - (lines.length-1)/2) * fs * 1.25;
        g.strokeText(ln, x, yy);
        g.fillText(ln, x, yy);
      });
    }
    g.restore();
    if (o.anim === 'pop') g.restore();
  }
}

function draw() {
  drawFrameAt(state.t, ctx, canvas.width, canvas.height);
}

function tick(ts) {
  if (!state.playing) return;
  if (!lastTs) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  state.t += dt;
  if (state.t >= totalDur()) {
    state.t = totalDur();
    pause();
  }
  updatePlayhead();
  $('#tcur').textContent = fmt(state.t);
  // keep video elements advancing naturally; just draw
  draw();
  // ensure audio/video playing
  syncMedia(state.t);
  raf = requestAnimationFrame(tick);
}
function play() {
  if (!state.clips.length && !state.overlays.length) { toast('أضف وسائط أولاً'); return; }
  state.playing = true;
  $('#play').textContent = '⏸';
  lastTs = 0;
  AudioGraph.resume().then(() => {
    syncMedia(state.t, { forceSeek: true });
    raf = requestAnimationFrame(tick);
  });
}
function pause() {
  state.playing = false;
  $('#play').textContent = '▶';
  cancelAnimationFrame(raf);
  for (const m of state.media) {
    if (m.el && m.el.pause) try { m.el.pause(); } catch (e) {}
    AudioGraph.setGain(m.id, 0);
  }
}

/* ---------- Selection actions ---------- */
function selectedClip() {
  const id = state.selected;
  return state.clips.find(c=>c.id===id) || state.overlays.find(c=>c.id===id) || state.audios.find(c=>c.id===id);
}
function allLists() { return [state.clips, state.overlays, state.audios]; }

$$('[data-act]').forEach(btn => btn.addEventListener('click', () => {
  const act = btn.dataset.act;
  const c = selectedClip();
  if (!c && act !== 'split') { toast('اختر مقطعاً أولاً'); return; }
  pushHist();
  if (act === 'del') {
    for (const L of allLists()) {
      const i = L.findIndex(x=>x.id===c.id);
      if (i>=0) L.splice(i,1);
    }
    state.selected = null;
  } else if (act === 'dup') {
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = uid();
    copy.start = c.start + clipDur(c);
    if (state.clips.includes(c)) state.clips.push(copy);
    else if (state.overlays.includes(c)) state.overlays.push(copy);
    else state.audios.push(copy);
    state.selected = copy.id;
  } else if (act === 'left' || act === 'right') {
    const L = state.clips.includes(c) ? state.clips : state.overlays.includes(c) ? state.overlays : state.audios;
    const i = L.indexOf(c);
    const j = act === 'left' ? i-1 : i+1;
    if (j>=0 && j<L.length) {
      // swap starts roughly
      const other = L[j];
      const tmp = c.start; c.start = other.start; other.start = tmp;
      L[i]=other; L[j]=c;
    }
  } else if (act === 'split') {
    const t = state.t;
    const target = findActiveClip(state.clips, t) || findActiveClip(state.overlays, t) || findActiveClip(state.audios, t);
    if (!target) { toast('لا يوجد مقطع عند المؤشر'); state.history.pop(); return; }
    const into = t - target.start;
    if (into < 0.15 || into > clipDur(target)-0.15) { toast('حرّك المؤشر داخل المقطع'); state.history.pop(); return; }
    const right = JSON.parse(JSON.stringify(target));
    right.id = uid();
    right.start = t;
    if (target.type === 'text' || target.type === 'sticker') {
      target.duration = into;
      right.duration = clipDur(right) - into; // will be overwritten
      right.duration = JSON.parse(JSON.stringify(target)).duration; // fix
      // recompute
      const origDur = into + (clipDur({...target, duration: right.duration}) || 0);
    } else {
      const lt = localTime(target, t);
      target.trimEnd = lt;
      right.trimStart = lt;
    }
    if (target.type === 'text' || target.type === 'sticker') {
      const oldDur = clipDur(target) + (right.duration || 0);
      // simpler approach: duration was full; set left duration = into, right = rest
      const full = (target.duration || into);
      // Actually before mutation we need original duration
    }
    // Fix split for overlays properly:
    // Re-do overlay split cleanly by reading original duration from before mutation — skip messy path.
    // For AV we already set trim.
    if (target.type === 'text' || target.type === 'sticker') {
      // undo messy and redo
      // The target.duration was set to into above incorrectly depending on state.
    }
    const L = state.clips.includes(target) ? state.clips : state.overlays.includes(target) ? state.overlays : state.audios;
    if (target.type === 'text' || target.type === 'sticker') {
      // reload from history last? Too messy. Compute from into:
      // We pushed hist already with pre-split. Let's re-parse:
      const prev = JSON.parse(state.history[state.history.length-1]);
      const orig = [...prev.clips, ...prev.overlays, ...prev.audios].find(x=>x.id===target.id);
      if (orig) {
        Object.assign(target, JSON.parse(JSON.stringify(orig)));
        const right2 = JSON.parse(JSON.stringify(orig));
        right2.id = uid();
        right2.start = t;
        if (orig.type === 'text' || orig.type === 'sticker') {
          target.duration = into;
          right2.duration = orig.duration - into;
        } else {
          const lt = (t - orig.start) * (orig.speed||1) + (orig.trimStart||0);
          target.trimEnd = lt;
          right2.trimStart = lt;
        }
        L.splice(L.indexOf(target)+1, 0, right2);
        // remove accidental right if pushed
        const bad = L.findIndex(x=>x.id===right.id);
        if (bad>=0) L.splice(bad,1);
        state.selected = right2.id;
      }
    } else {
      L.splice(L.indexOf(target)+1, 0, right);
      state.selected = right.id;
    }
  }
  $('#empty').classList.toggle('hidden', state.clips.length > 0);
  renderTimeline(); renderPanel(); draw(); saveProject();
}));

/* ---------- Panels ---------- */
let currentTab = 'media';
function renderPanel() {
  const p = $('#panel');
  const c = selectedClip();
  if (currentTab === 'media') {
    p.innerHTML = `<h4>الوسائط</h4>
      <div class="row" style="margin-bottom:.5rem"><button class="primary" id="addMedia">＋ استيراد فيديو / صورة / صوت</button></div>
      <div class="media-list" id="mlist"></div>`;
    const list = $('#mlist');
    for (const m of state.media) {
      if (m.type === 'audio') {
        const d = document.createElement('div');
        d.className = 'mthumb audio'; d.title = m.name; d.textContent = '🎵';
        d.onclick = () => { addAudioClip(m); renderTimeline(); toast('أُضيف للصوت'); };
        list.appendChild(d);
      } else {
        const img = document.createElement(m.type==='video'?'video':'img');
        img.className = 'mthumb'; img.src = m.url; if (m.type==='video'){img.muted=true;img.currentTime=0.1}
        img.title = m.name;
        img.onclick = () => { addAVClip(m); $('#empty').classList.add('hidden'); renderTimeline(); draw(); toast('أُضيف للخط الزمني'); };
        list.appendChild(img);
      }
    }
    $('#addMedia').onclick = () => $('#fileIn').click();
  } else if (currentTab === 'text') {
    p.innerHTML = `<h4>نص على الفيديو</h4>
      <div class="field"><label>النص</label><textarea id="tx">مرحباً بكم في مَشهد</textarea></div>
      <div class="row">
        <div class="field"><label>اللون</label><input type="color" id="tcol" value="#ffffff"></div>
        <div class="field"><label>الحجم</label><input type="range" id="tsz" min="20" max="100" value="50"></div>
        <div class="field"><label>حركة</label><select id="tanim"><option value="none">بدون</option><option value="fade">تلاشي</option><option value="up">صعود</option><option value="pop">ظهور</option></select></div>
      </div>
      <div class="row" style="margin-top:.4rem"><button class="primary" id="addText">＋ إضافة النص</button>
      ${c && c.type==='text' ? '<button id="updText">تحديث المحدد</button>' : ''}</div>`;
    $('#addText').onclick = () => {
      pushHist();
      state.overlays.push({
        id: uid(), type:'text', text: $('#tx').value, color: $('#tcol').value,
        size: +$('#tsz').value, anim: $('#tanim').value, stroke:'#000',
        start: state.t, duration: 3, x:0.5, y:0.5
      });
      renderTimeline(); draw(); saveProject(); toast('أُضيف النص');
    };
    const u = $('#updText');
    if (u) u.onclick = () => {
      pushHist();
      c.text = $('#tx').value; c.color = $('#tcol').value; c.size = +$('#tsz').value; c.anim = $('#tanim').value;
      renderTimeline(); draw(); saveProject();
    };
    if (c && c.type==='text') {
      $('#tx').value = c.text; $('#tcol').value = c.color||'#ffffff'; $('#tsz').value = c.size||50; $('#tanim').value = c.anim||'none';
    }
  } else if (currentTab === 'sticker') {
    p.innerHTML = `<h4>ملصقات وإيموجي</h4><div class="grid" id="emgrid"></div>`;
    const g = $('#emgrid');
    for (const e of EMOJIS) {
      const b = document.createElement('button');
      b.className = 'tile big'; b.textContent = e;
      b.onclick = () => {
        pushHist();
        state.overlays.push({id:uid(), type:'sticker', text:e, size:70, anim:'pop', start:state.t, duration:2.5, x:0.5, y:0.4});
        renderTimeline(); draw(); saveProject();
      };
      g.appendChild(b);
    }
  } else if (currentTab === 'filter') {
    p.innerHTML = `<h4>فلاتر الصورة</h4><div class="grid" id="fgrid"></div>
      <div class="row" style="margin-top:.5rem">
        <div class="field"><label>سطوع ${state.filter.b}%</label><input type="range" id="fb" min="50" max="150" value="${state.filter.b}"></div>
        <div class="field"><label>تباين ${state.filter.c}%</label><input type="range" id="fc" min="50" max="150" value="${state.filter.c}"></div>
        <div class="field"><label>تشبّع ${state.filter.s}%</label><input type="range" id="fs" min="0" max="200" value="${state.filter.s}"></div>
      </div>`;
    const g = $('#fgrid');
    for (const [k,v] of Object.entries(FILTERS)) {
      const b = document.createElement('button');
      b.className = 'tile' + (state.filter.preset===k?' on':'');
      b.textContent = v.n;
      b.onclick = () => {
        pushHist();
        state.filter = {b:v.b,c:v.c,s:v.s,preset:k};
        renderPanel(); draw(); saveProject();
      };
      g.appendChild(b);
    }
    const bind = (id, key) => $(id).oninput = e => {
      state.filter[key] = +e.target.value; state.filter.preset = 'custom'; draw();
      renderPanel(); // refresh labels — may reset focus, so use lighter update
    };
    // lighter: just draw on input without full re-render
    $('#fb').oninput = e => { state.filter.b=+e.target.value; state.filter.preset='custom'; draw(); };
    $('#fc').oninput = e => { state.filter.c=+e.target.value; state.filter.preset='custom'; draw(); };
    $('#fs').oninput = e => { state.filter.s=+e.target.value; state.filter.preset='custom'; draw(); };
    $('#fb').onchange = $('#fc').onchange = $('#fs').onchange = () => { pushHist(); saveProject(); };
  } else if (currentTab === 'speed') {
    const speeds = [0.5, 0.75, 1, 1.5, 2];
    p.innerHTML = `<h4>سرعة المقطع المحدد</h4><div class="grid" id="sgrid"></div>
      <p style="color:var(--mut);font-size:.78rem;margin:.5rem 0 0">اختر مقطعاً من مسار الفيديو أولاً، ثم غيّر سرعته.</p>`;
    const g = $('#sgrid');
    for (const s of speeds) {
      const b = document.createElement('button');
      b.className = 'tile' + (c && c.speed===s ? ' on':'');
      b.textContent = s + '×';
      b.onclick = () => {
        if (!c || (c.type!=='video' && c.type!=='image' && c.type!=='audio')) { toast('اختر مقطع فيديو أو صوت'); return; }
        pushHist(); c.speed = s; renderTimeline(); renderPanel(); saveProject();
      };
      g.appendChild(b);
    }
  } else if (currentTab === 'trans') {
    p.innerHTML = `<h4>انتقال بداية المقطع</h4><div class="grid" id="trgrid"></div>`;
    const g = $('#trgrid');
    for (const t of TRANS) {
      const b = document.createElement('button');
      b.className = 'tile' + (c && c.transition===t.id ? ' on':'');
      b.textContent = t.n;
      b.onclick = () => {
        if (!c || !state.clips.includes(c)) { toast('اختر مقطع فيديو'); return; }
        pushHist(); c.transition = t.id; renderPanel(); draw(); saveProject();
      };
      g.appendChild(b);
    }
  } else if (currentTab === 'audio') {
    p.innerHTML = `<h4>الصوت والموسيقى</h4>
      <div class="row"><button class="primary" id="addAud">＋ إضافة مقطع صوتي</button></div>
      <div class="field" style="margin-top:.5rem"><label>مستوى صوت المقطع المحدد</label>
      <input type="range" id="vol" min="0" max="100" value="${c && c.vol!=null ? Math.round(c.vol*100) : 40}"></div>
      <p style="color:var(--mut);font-size:.78rem">يمكنك كتم صوت الفيديو بخفض مستواه إلى ٠، وإضافة موسيقى على مسار الصوت.</p>`;
    $('#addAud').onclick = () => $('#audioIn').click();
    $('#vol').oninput = e => {
      if (!c) return;
      c.vol = +e.target.value / 100;
      draw();
    };
    $('#vol').onchange = () => { if (c) { pushHist(); saveProject(); } };
  } else if (currentTab === 'project') {
    p.innerHTML = `<h4>المشروع</h4>
      <div class="row">
        <button class="primary" id="saveP">💾 حفظ</button>
        <button id="newP">مشروع جديد</button>
        <button id="clearMedia">مسح الوسائط</button>
      </div>
      <p style="color:var(--mut);font-size:.78rem;margin-top:.5rem">يُحفظ المشروع تلقائياً في متصفحك (IndexedDB). لا يُرفع لأي سيرفر.</p>
      <p style="color:var(--mut);font-size:.78rem">© ٢٠٢٦ وطن النهار / Ahmadalfayed — تطبيق مَشهد، جميع الحقوق محفوظة.</p>`;
    $('#saveP').onclick = async () => { await saveProject(); toast('تم الحفظ'); };
    $('#newP').onclick = () => {
      if (!confirm('بدء مشروع جديد؟')) return;
      pushHist();
      state.clips=[]; state.overlays=[]; state.audios=[]; state.selected=null; state.t=0;
      $('#empty').classList.remove('hidden');
      renderTimeline(); draw(); saveProject();
    };
    $('#clearMedia').onclick = async () => {
      if (!confirm('مسح كل الوسائط المحفوظة؟')) return;
      for (const m of state.media) { try{URL.revokeObjectURL(m.url)}catch(e){} try{await DB.del('media',m.id)}catch(e){} }
      state.media=[]; state.clips=[]; state.overlays=[]; state.audios=[];
      $('#empty').classList.remove('hidden');
      renderTimeline(); renderPanel(); draw(); saveProject();
    };
  }
}

$$('.tabs button').forEach(b => b.addEventListener('click', () => {
  $$('.tabs button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  currentTab = b.dataset.tab;
  renderPanel();
}));
$$('.tabs button')[0].classList.add('on');

/* ---------- Export ---------- */
async function exportVideo() {
  const dlg = $('#exportDlg'); dlg.hidden = false;
  $('#exLink').hidden = true;
  const q = +$('#exQ').value;
  const [aw,ah] = ASPECT[state.aspect];
  let W, H;
  if (aw > ah) { W = Math.round(q * aw/ah); H = q; }
  else if (aw < ah) { W = q; H = Math.round(q * ah/aw); }
  else { W = q; H = q; }
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm',
    'video/mp4'
  ];
  let mime = types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
  $('#exFmt').textContent = `الصيغة: ${mime.includes('mp4')?'MP4':'WebM'} — ${W}×${H} — ${state.aspect}`;
  $('#exMsg').textContent = 'جاهز للتصدير';
  $('#exBar').style.width = '0%';

  $('#exGo').onclick = async () => {
    $('#exGo').disabled = true;
    $('#exMsg').textContent = 'جاري التصدير… لا تغلق الصفحة';
    pause();
    await AudioGraph.resume();
    for (const m of state.media) AudioGraph.attach(m);

    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d');
    const fps = 30;
    // Manual canvas frames when supported — avoids dropped/duped captureStream ticks
    const canvasStream = off.captureStream(0);
    const vTrack = canvasStream.getVideoTracks()[0];
    const combined = new MediaStream();
    canvasStream.getVideoTracks().forEach(tr => combined.addTrack(tr));
    AudioGraph.streamDest.stream.getAudioTracks().forEach(tr => combined.addTrack(tr));

    const chunks = [];
    let rec;
    const recOpts = { mimeType: mime, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 192_000 };
    try {
      rec = new MediaRecorder(combined, recOpts);
    } catch (e) {
      try {
        rec = new MediaRecorder(combined, { mimeType: mime, audioBitsPerSecond: 192_000 });
      } catch (e2) {
        rec = new MediaRecorder(combined);
        mime = rec.mimeType || mime;
      }
    }
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(r => { rec.onstop = r; });

    const dur = totalDur();
    // Real-time export: let media elements play naturally (no per-frame seeking)
    state.t = 0;
    state.playing = true;
    syncMedia(0, { forceSeek: true });
    // Kick play on active elements
    for (const m of state.media) {
      const active = [...state.clips, ...state.audios].some(c =>
        c.mediaId === m.id && 0 >= c.start && 0 < c.start + clipDur(c)
      );
      if (active && m.el && m.el.play) m.el.play().catch(() => {});
    }

    rec.start(100);
    const wall0 = performance.now();
    await new Promise(resolve => {
      const tickExport = () => {
        const elapsed = (performance.now() - wall0) / 1000;
        state.t = Math.min(elapsed, dur);
        // Natural playback — only correct large drift
        syncMedia(state.t);
        drawFrameAt(state.t, octx, W, H);
        try {
          if (vTrack && typeof vTrack.requestFrame === 'function') vTrack.requestFrame();
        } catch (e) {}
        const pct = Math.min(100, Math.round((state.t / dur) * 100));
        $('#exBar').style.width = pct + '%';
        $('#exMsg').textContent = `تصدير… ${pct}%`;
        if (elapsed < dur) {
          requestAnimationFrame(tickExport);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tickExport);
    });

    // Brief tail so encoder flushes audio
    await new Promise(r => setTimeout(r, 200));
    state.playing = false;
    for (const m of state.media) {
      if (m.el && m.el.pause) try { m.el.pause(); } catch (e) {}
      AudioGraph.setGain(m.id, 0);
    }
    try { rec.stop(); } catch (e) {}
    await done;

    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = $('#exLink');
    a.href = url;
    a.download = `mashhad-${Date.now()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
    a.hidden = false;
    a.textContent = `⬇ تنزيل (${(blob.size / 1024 / 1024).toFixed(1)} MB)`;
    $('#exMsg').textContent = 'اكتمل التصدير ✓';
    $('#exBar').style.width = '100%';
    $('#exGo').disabled = false;
    $('#play').textContent = '▶';
    toast('الفيديو جاهز للتنزيل');
  };
}

$('#exClose').onclick = () => { $('#exportDlg').hidden = true; };

/* ---------- Persist ---------- */
async function saveProject() {
  const data = {
    clips: state.clips, overlays: state.overlays, audios: state.audios,
    filter: state.filter, speed: state.speed, aspect: state.aspect,
    mediaMeta: state.media.map(m => ({id:m.id, type:m.type, name:m.name, duration:m.duration}))
  };
  try { await DB.put('project', 'current', data); } catch(e){}
}
async function loadProject() {
  try {
    const data = await DB.get('project', 'current');
    if (!data) return;
    state.clips = data.clips||[]; state.overlays = data.overlays||[]; state.audios = data.audios||[];
    state.filter = data.filter||state.filter; state.aspect = data.aspect||'9:16';
    $('#aspect').value = state.aspect; applyAspect();
    for (const meta of (data.mediaMeta||[])) {
      const blob = await DB.get('media', meta.id);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      let el;
      if (meta.type==='video' || meta.type==='audio') {
        el = document.createElement(meta.type==='video'?'video':'audio');
        el.preload='auto'; el.src=url; if(meta.type==='video') el.muted=true;
        await new Promise(r=>{el.onloadedmetadata=r; el.onerror=r; setTimeout(r,3000)});
      } else {
        el = new Image(); el.src=url;
        await new Promise(r=>{el.onload=r; el.onerror=r});
      }
      state.media.push({...meta, url, blob, el});
      AudioGraph.attach(state.media[state.media.length-1]);
    }
    $('#empty').classList.toggle('hidden', state.clips.length>0);
  } catch(e){ console.warn(e); }
}

/* ---------- Wire UI ---------- */
$('#fileIn').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value=''; });
$('#audioIn').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value=''; });
$('#emptyAdd').onclick = () => $('#fileIn').click();
$('#play').onclick = () => state.playing ? pause() : play();
$('#aspect').onchange = e => { pushHist(); state.aspect = e.target.value; applyAspect(); saveProject(); };
$('#zoom').oninput = e => { state.pxPerSec = +e.target.value; renderTimeline(); };
$('#undo').onclick = () => {
  if (!state.history.length) return;
  state.future.push(JSON.stringify({clips:state.clips,overlays:state.overlays,audios:state.audios,filter:state.filter,speed:state.speed,aspect:state.aspect}));
  restore(state.history.pop());
};
$('#redo').onclick = () => {
  if (!state.future.length) return;
  pushHist();
  restore(state.future.pop());
  state.history.pop(); // pushHist added current; remove
};
$('#exportBtn').onclick = exportVideo;

// keyboard
window.addEventListener('keydown', e => {
  if (e.code==='Space' && e.target.tagName!=='TEXTAREA' && e.target.tagName!=='INPUT') {
    e.preventDefault(); state.playing?pause():play();
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js',{scope:'./'}).catch(()=>{});

(async () => {
  applyAspect();
  await loadProject();
  renderTimeline();
  renderPanel();
  draw();
  // auto-load sample if present and empty
  if (!state.clips.length) {
    try {
      const r = await fetch('sample/sample.webm');
      if (r.ok) {
        const blob = await r.blob();
        const f = new File([blob], 'عينة-مشهد.webm', {type: blob.type||'video/webm'});
        await importFiles([f]);
      }
    } catch(e){}
  }
})();
})();
