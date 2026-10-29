/* UCF-Crime anomaly detection site.
   Everything on the page is plain JavaScript, no libraries. */
(function () {
  'use strict';

  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var smooth = function (x, a, b) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var MINUS = '−';

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ */
  /* 1. The simulated camera and the segment score timeline              */
  /* ------------------------------------------------------------------ */
  (function scope() {
    var T = 32, THR = 0.5, SEG_SECONDS = 6, SPEED = 2.4;
    var cam = $('#cam'), screen = $('#screen'), svg = $('#trace');
    if (!cam || !svg) return;
    var ctx = cam.getContext('2d');
    var barsG = $('#bars'), ph = $('#ph'), mx = $('#mx');
    var btnPlay = $('#btn-play'), segA = $('#seg-anom'), segN = $('#seg-normal'), btnNew = $('#btn-new');
    var rSeg = $('#r-seg'), rScore = $('#r-score'), rVideo = $('#r-video'), rVerdict = $('#r-verdict');
    var hudTime = $('#hud-time'), hudAlert = $('#hud-alert');
    var NS = 'http://www.w3.org/2000/svg';
    var line = $('#line'), area = $('#area');
    line.style.opacity = 0; area.style.opacity = 0;

    /* Smooth score line and soft area under it (Catmull-Rom turned into Bezier curves) */
    function buildLine() {
      var pts = state.clip.scores.map(function (v, i) { return [i * 30 + 15, 190 - v * 170]; });
      var d = 'M' + pts[0][0] + ' ' + pts[0][1].toFixed(1);
      for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
        var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2[0] + ' ' + p2[1].toFixed(1);
      }
      line.setAttribute('d', d);
      area.setAttribute('d', d + ' L' + pts[pts.length - 1][0] + ' 190 L' + pts[0][0] + ' 190 Z');
    }
    function drawLine() {
      if (reduce) { line.style.strokeDasharray = 'none'; line.style.opacity = 1; area.style.opacity = 1; return; }
      var len = line.getTotalLength();
      line.style.transition = 'none'; line.style.opacity = 1;
      line.style.strokeDasharray = len; line.style.strokeDashoffset = len;
      area.style.transition = 'none'; area.style.opacity = 0;
      line.getBoundingClientRect();
      line.style.transition = 'stroke-dashoffset 1.5s cubic-bezier(.4,0,.2,1)'; line.style.strokeDashoffset = 0;
      area.style.transition = 'opacity 1.2s ease .5s'; area.style.opacity = 1;
    }

    var state = { kind: 'anomalous', seed: 11, clip: null, f: 0, playing: false, last: 0, dragging: false, started: false };

    /* Build the 32 bars once. */
    var bars = [];
    for (var i = 0; i < T; i++) {
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('class', 'bar-rect');
      r.setAttribute('x', i * 30 + 4);
      r.setAttribute('y', 20);
      r.setAttribute('width', 22);
      r.setAttribute('height', 170);
      r.setAttribute('rx', 2);
      r.style.setProperty('--i', i);
      r.style.setProperty('--s', 0.02);
      barsG.appendChild(r);
      bars.push(r);
    }

    /* Illustrative scores: a quiet baseline, plus one bump if the clip is anomalous. */
    function makeClip(kind, seed) {
      var rand = rng(seed * 9301 + 49297);
      var n = 0, noise = [], s = [], k;
      for (k = 0; k < T; k++) { n = n * 0.6 + (rand() - 0.5) * 0.12; noise.push(n); }
      var c = 8 + Math.floor(rand() * 16);
      var w = 2.0 + rand() * 1.2;
      var decoy = 3 + Math.floor(rand() * 26);
      for (k = 0; k < T; k++) {
        var v = 0.1 + noise[k];
        if (kind === 'anomalous') {
          var d = k - c;
          v += 0.8 * Math.exp(-(d * d) / (2 * w * w)) * (0.92 + 0.16 * rand());
          v = clamp(v, 0.02, 0.97);
        } else {
          var e = k - decoy;
          v += 0.24 * Math.exp(-(e * e) / (2 * 2 * 2));
          v = clamp(v, 0.02, 0.44);
        }
        s.push(v);
      }
      var max = 0, arg = 0;
      for (k = 0; k < T; k++) if (s[k] > max) { max = s[k]; arg = k; }
      return { kind: kind, scores: s, c: c, w: w, max: max, arg: arg };
    }

    /* ---- Scene ---- */
    var bg = document.createElement('canvas');
    bg.width = 480; bg.height = 270;
    (function paintBackground() {
      var b = bg.getContext('2d');
      b.scale(1.5, 1.5);
      var g = b.createLinearGradient(0, 0, 0, 180);
      g.addColorStop(0, '#1E2415'); g.addColorStop(0.42, '#232A18');
      g.addColorStop(0.43, '#141710'); g.addColorStop(1, '#0B0C09');
      b.fillStyle = g; b.fillRect(0, 0, 320, 180);
      var rand = rng(5), x, y, r2;
      for (var i = 0; i < 4; i++) {
        x = 12 + i * 78;
        b.fillStyle = '#2B321A'; b.fillRect(x, 20, 64, 52);
        for (r2 = 0; r2 < 3; r2++) {
          y = 20 + r2 * 17;
          for (var p = 0; p < 9; p++) {
            b.fillStyle = ['#4F5B24', '#5F6C30', '#3E471D', '#7C7F7A'][Math.floor(rand() * 4)];
            b.fillRect(x + 3 + p * 6.8, y + 5 + rand() * 3, 5, 9 - rand() * 3);
          }
          b.fillStyle = '#0B0C09'; b.fillRect(x, y + 15, 64, 2);
        }
      }
      b.strokeStyle = 'rgba(218,214,204,.07)'; b.lineWidth = 0.6;
      for (var l = -7; l <= 7; l++) { b.beginPath(); b.moveTo(160 + l * 12, 78); b.lineTo(160 + l * 62, 180); b.stroke(); }
      for (var h = 0; h < 5; h++) { var yy = 84 + h * h * 5.5 + h * 6; b.beginPath(); b.moveTo(0, yy); b.lineTo(320, yy); b.stroke(); }
      b.fillStyle = 'rgba(218,214,204,.2)';
      for (var q = 0; q < 4; q++) b.fillRect(24 + q * 78, 4, 44, 3);
    })();

    var bystanders = [
      { x0: 20, v: 5.6, y: 132, push: -1 },
      { x0: 250, v: -4.3, y: 154, push: 1 },
      { x0: 120, v: 3.4, y: 122, push: -1 },
      { x0: 300, v: -6.2, y: 164, push: 1 }
    ];

    function person(x, y, shade, fall, step) {
      var h = 24 + (y - 110) * 0.5;
      var bw = h * 0.3, bh = h * 0.5, hr = h * 0.11;
      ctx.save();
      ctx.translate(x, y + (step ? Math.abs(Math.sin(step)) * -1.2 : 0));
      if (fall) ctx.rotate(-fall * Math.PI * 0.46);
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath(); ctx.ellipse(0, 0, bw, 2, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = shade;
      ctx.fillRect(-bw / 2, -h * 0.42, bw * 0.42, h * 0.42);
      ctx.fillRect(bw * 0.08, -h * 0.42, bw * 0.42, h * 0.42);
      ctx.fillRect(-bw / 2 - 1, -h * 0.42 - bh, bw + 2, bh);
      ctx.beginPath(); ctx.arc(0, -h * 0.42 - bh - hr - 1, hr, 0, 6.283); ctx.fill();
      ctx.restore();
      return h;
    }

    function drawFrame(f, clip, flagged, score) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(bg, 0, 0);
      ctx.setTransform(1.5, 0, 0, 1.5, 0, 0);

      var anomalous = clip.kind === 'anomalous';
      var c = clip.c, w = clip.w;
      var app = anomalous ? smooth(f, c - 2.8 * w, c - 0.5 * w) : 0;
      var flee = anomalous ? smooth(f, c + 0.5 * w, c + 2.4 * w) : 0;
      var clash = app * (1 - flee);

      bystanders.forEach(function (b, i) {
        var x = ((b.x0 + b.v * f) % 360 + 360) % 360 - 20;
        x += b.push * 40 * clash * Math.exp(-Math.pow(x - 160, 2) / (2 * 80 * 80));
        person(x, b.y, i % 2 ? '#7C7F7A' : '#8D8F88', 0, f * 9 + i);
      });

      var ax = 36 + f * 3.1, ay = 146, bx = 286 - f * 3.0, by = 150, fall = 0;
      if (anomalous) {
        ax = lerp(ax, 153, app); bx = lerp(bx, 167, app);
        ay = lerp(ay, 150, app);
        var jit = Math.sin(f * 75) * 2.6 * clamp((clash - 0.55) / 0.45, 0, 1);
        ax += jit; bx -= jit * 0.6;
        bx += 230 * flee;
        fall = smooth(f, c + 0.1 * w, c + 0.9 * w);
      }
      person(ax, ay, '#DAD6CC', fall, fall > 0.05 ? 0 : f * 9 + 3);
      if (bx < 340) person(bx, by, '#B5B2A8', 0, f * 11 + 5);

      if (flagged) {
        var hh = 24 + (ay - 110) * 0.5;
        var bw2 = anomalous && flee < 0.5 ? 52 : 44;
        var bxL = ax - bw2 / 2 + (flee < 0.5 ? 6 : 0), top = ay - hh - 8;
        ctx.strokeStyle = '#DAD6CC'; ctx.lineWidth = 1.2;
        ctx.strokeRect(bxL, top, bw2, hh + 14);
        ctx.fillStyle = '#DAD6CC'; ctx.fillRect(bxL, top - 8, 30, 8);
        ctx.fillStyle = '#11120F'; ctx.font = '600 6.5px sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillText('score ' + score.toFixed(2), bxL + 2, top - 3.8);
      }
      if (clash > 0.2) { ctx.fillStyle = 'rgba(218,214,204,' + (0.07 * clash) + ')'; ctx.fillRect(0, 0, 320, 180); }

      /* vignette, scanlines, grain */
      var v = ctx.createRadialGradient(160, 90, 60, 160, 90, 200);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = 'rgba(0,0,0,.14)';
      for (var y = 0; y < 180; y += 2) ctx.fillRect(0, y, 320, 0.8);
      ctx.fillStyle = 'rgba(218,214,204,.16)';
      for (var g = 0; g < 38; g++) ctx.fillRect(Math.random() * 320, Math.random() * 180, 1, 1);
    }

    /* ---- Rendering ---- */
    function currentSeg() { return clamp(Math.round(state.f), 0, T - 1); }

    function render() {
      var clip = state.clip, seg = currentSeg(), score = clip.scores[seg];
      var flagged = score > THR;
      ph.setAttribute('transform', 'translate(' + ((state.f + 0.5) * 30).toFixed(1) + ',0)');
      for (var i = 0; i < T; i++) {
        bars[i].classList.toggle('seen', i <= seg);
      }
      rSeg.textContent = (seg + 1) + ' of ' + T;
      rScore.textContent = score.toFixed(2);
      var secs = Math.round(state.f * SEG_SECONDS);
      hudTime.textContent = Math.floor(secs / 60) + ':' + pad(secs % 60) + ' / 3:12';
      hudAlert.hidden = !flagged;
      screen.classList.toggle('alert', flagged);
      svg.setAttribute('aria-valuenow', seg + 1);
      svg.setAttribute('aria-valuetext', 'Segment ' + (seg + 1) + ' of ' + T + ', score ' + score.toFixed(2));
      drawFrame(state.f, clip, flagged, score);
    }

    function applyClip() {
      var clip = state.clip;
      for (var i = 0; i < T; i++) {
        bars[i].style.setProperty('--s', clip.scores[i].toFixed(3));
        bars[i].classList.toggle('hot', clip.scores[i] > THR);
      }
      mx.style.transform = 'translate(' + (clip.arg * 30 + 15) + 'px,' + (190 - clip.max * 170 - 4) + 'px)';
      rVideo.textContent = clip.max.toFixed(2);
      var flag = clip.max > THR;
      rVerdict.textContent = flag ? 'Flagged as anomalous' : 'Not flagged';
      rVideo.parentNode.classList.toggle('flag', flag);
      buildLine();
      if (state.drawn) drawLine();
    }

    function setClip(kind, seed) {
      state.kind = kind; state.seed = seed;
      state.clip = makeClip(kind, seed);
      segA.setAttribute('aria-pressed', kind === 'anomalous');
      segN.setAttribute('aria-pressed', kind === 'normal');
      applyClip();
      state.f = 0;
      render();
    }

    /* ---- Playback ---- */
    function setPlayLabel() {
      btnPlay.textContent = state.playing ? 'Pause' : (state.f >= T - 1 ? 'Replay' : 'Play');
    }
    function tick(ts) {
      if (!state.playing) return;
      var dt = Math.min((ts - state.last) / 1000, 0.1);
      state.last = ts;
      state.f += dt * SPEED;
      if (state.f >= T - 1) { state.f = T - 1; state.playing = false; setPlayLabel(); render(); return; }
      render();
      requestAnimationFrame(tick);
    }
    function play() {
      if (state.f >= T - 1 - 0.01) state.f = 0;
      state.playing = true; state.last = performance.now(); setPlayLabel();
      requestAnimationFrame(tick);
    }
    function pause() { state.playing = false; setPlayLabel(); }

    btnPlay.addEventListener('click', function () { state.playing ? pause() : play(); });
    segA.addEventListener('click', function () { if (state.kind !== 'anomalous') { setClip('anomalous', state.seed + 1); play(); } });
    segN.addEventListener('click', function () { if (state.kind !== 'normal') { setClip('normal', state.seed + 1); play(); } });
    btnNew.addEventListener('click', function () { setClip(state.kind, state.seed + 1 + Math.floor(Math.random() * 40)); play(); });

    /* ---- Scrubbing ---- */
    function seek(e) {
      var r = svg.getBoundingClientRect();
      state.f = clamp(((e.clientX - r.left) / r.width) * T - 0.5, 0, T - 1);
      setPlayLabel(); render();
    }
    svg.addEventListener('pointerdown', function (e) {
      state.dragging = true; svg.setPointerCapture(e.pointerId); pause(); seek(e);
    });
    svg.addEventListener('pointermove', function (e) { if (state.dragging) seek(e); });
    svg.addEventListener('pointerup', function () { state.dragging = false; });
    svg.addEventListener('pointercancel', function () { state.dragging = false; });
    svg.addEventListener('keydown', function (e) {
      var k = e.key, handled = true;
      if (k === 'ArrowRight' || k === 'ArrowUp') state.f = clamp(currentSeg() + 1, 0, T - 1);
      else if (k === 'ArrowLeft' || k === 'ArrowDown') state.f = clamp(currentSeg() - 1, 0, T - 1);
      else if (k === 'Home') state.f = 0;
      else if (k === 'End') state.f = T - 1;
      else if (k === ' ') { state.playing ? pause() : play(); }
      else handled = false;
      if (handled) { e.preventDefault(); if (k !== ' ') { pause(); render(); } }
    });

    /* ---- Opening moment: bars rise one after another, then the playhead sweeps ---- */
    setClip('anomalous', 11);
    var started = false;
    function start() {
      if (started) return; started = true;
      svg.classList.add('ready');
      state.drawn = true; drawLine();
      if (reduce) { state.f = state.clip.arg; setPlayLabel(); render(); return; }
      setTimeout(play, 900);
    }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (en) {
        if (en[0].isIntersecting) { start(); io.disconnect(); }
      }, { threshold: 0.35 });
      io.observe($('#scope'));
    } else { start(); }
    setTimeout(start, 2500);
  })();

  /* ------------------------------------------------------------------ */
  /* 2. The ranking loss playground                                      */
  /* ------------------------------------------------------------------ */
  (function loss() {
    var inA = $('#in-a'), inN = $('#in-n');
    if (!inA) return;
    var outA = $('#out-a'), outN = $('#out-n'), eq = $('#loss-eq'), val = $('#loss-val');
    var fill = $('#loss-fill'), note = $('#loss-note');
    var dA = $('#nl-a'), dN = $('#nl-n'), gap = $('#nl-gap');

    function update() {
      var a = parseFloat(inA.value), n = parseFloat(inN.value);
      var l = Math.max(0, 1 - a + n);
      outA.textContent = a.toFixed(2);
      outN.textContent = n.toFixed(2);
      eq.textContent = 'max(0, 1 ' + MINUS + ' ' + a.toFixed(2) + ' + ' + n.toFixed(2) + ')';
      val.textContent = l.toFixed(2);
      fill.style.width = (l / 2 * 100) + '%';
      dA.style.left = (a * 100) + '%';
      dN.style.left = (n * 100) + '%';
      gap.style.left = (Math.min(a, n) * 100) + '%';
      gap.style.width = (Math.abs(a - n) * 100) + '%';
      var msg;
      if (l === 0) {
        msg = 'Zero loss. The anomalous video leads by a full 1.0, so there is nothing left to learn from this pair.';
      } else if (a > n) {
        msg = 'The anomalous video already leads by ' + (a - n).toFixed(2) + ', but the loss wants a lead of 1.0. Because scores live between 0 and 1, it keeps pushing the anomalous maximum up and the normal maximum down.';
      } else {
        msg = 'The normal video outscores the anomalous one. This is the costliest case, and it produces the strongest correction.';
      }
      note.textContent = msg;
    }
    inA.addEventListener('input', update);
    inN.addEventListener('input', update);
    update();
  })();

  /* ------------------------------------------------------------------ */
  /* 3. The pipeline stepper                                             */
  /* ------------------------------------------------------------------ */
  (function pipeline() {
    var rail = $('#rail');
    if (!rail) return;
    var steps = [
      { name: 'Frames to clips', kind: 'Data', title: 'Frames become 16-frame clips',
        text: 'The Kaggle release stores UCF-Crime as extracted PNG frames. Each frame is resized to 112 by 112 and grouped into clips of 16. The frames are low resolution and sparsely sampled, which limits what any model can see.',
        inp: 'Frames from each video', out: 'Clips shaped (3, 16, 112, 112)' },
      { name: 'Frozen R3D-18', kind: 'Frozen', title: 'A frozen 3D CNN describes every clip',
        text: 'A torchvision r3d_18 pretrained on Kinetics-400 turns each clip into 512 numbers describing what is moving and how. It is never fine-tuned, so the features are computed once and cached. That keeps training fast: only a small head learns.',
        inp: 'Clips, Kinetics mean and std applied', out: 'One 512-d feature per clip' },
      { name: 'Pool to 32 segments', kind: 'Data', title: 'Every video becomes 32 segments',
        text: 'Clip features are mean-pooled into T = 32 segments per video, then L2-normalized. A short video and a long one both end up as the same (32, 512) table, which is what the temporal model expects.',
        inp: 'N clip features, 512-d each', out: 'Segment table (32, 512)' },
      { name: 'Project', kind: 'Trained', title: 'Compress the features',
        text: 'A linear layer from 512 to 256 with a ReLU and dropout shrinks the features before the temporal model sees them.',
        inp: '(32, 512)', out: '(32, 256)' },
      { name: 'BiGRU', kind: 'Trained', title: 'Read the video in both directions',
        text: 'A bidirectional GRU with 128 units per direction reads the 32 segments forward and backward, so a segment can be judged by what happens before and after it. A shove looks different once you know the crowd scattered a moment later.',
        inp: '(32, 256)', out: '(32, 2 x 128) = (32, 256)' },
      { name: 'Score head', kind: 'Trained', title: 'Score every segment from 0 to 1',
        text: 'A small MLP and a sigmoid turn each segment into one number between 0 and 1. High means it looks anomalous.',
        inp: '(32, 256)', out: '(32, 1) segment scores' },
      { name: 'Max over segments', kind: 'Decision', title: 'The video takes its most suspicious moment',
        text: 'A video’s score is its highest segment score. That maximum is what the ranking loss compares in training. At test time a threshold, picked with Youden’s J on validation videos and then frozen, turns it into a yes or no.',
        inp: '32 segment scores', out: 'One video score' }
    ];
    var cur = 0, timer = null;
    var nodes = [];
    var detail = $('.detail'), title = $('#step-title'), text = $('#step-text'), inp = $('#step-in'), out = $('#step-out'), badge = $('#step-badge');
    var prev = $('#step-prev'), next = $('#step-next'), playBtn = $('#step-play');

    steps.forEach(function (s, i) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'node' + (s.kind === 'Frozen' ? ' frozen' : '');
      b.innerHTML = '<span class="n">' + (i + 1) + '</span><span class="nm"></span>';
      $('.nm', b).textContent = s.name;
      b.addEventListener('click', function () { stop(); select(i); });
      li.appendChild(b); rail.appendChild(li); nodes.push(b);
    });

    function fillPanel(i) {
      var s = steps[i];
      title.textContent = s.title; text.textContent = s.text;
      inp.textContent = s.inp; out.textContent = s.out;
      badge.textContent = s.kind === 'Trained' ? 'Trained' : s.kind === 'Frozen' ? 'Frozen' : s.kind;
      badge.className = 'badge' + (s.kind === 'Trained' ? ' is-trained' : s.kind === 'Frozen' ? ' is-frozen' : '');
    }
    function select(i, instant) {
      cur = clamp(i, 0, steps.length - 1);
      rail.style.setProperty('--p', cur / (steps.length - 1));
      nodes.forEach(function (n, k) {
        if (k === cur) n.setAttribute('aria-current', 'step'); else n.removeAttribute('aria-current');
        n.classList.toggle('done', k < cur);
      });
      prev.disabled = cur === 0;
      next.disabled = cur === steps.length - 1;
      if (instant || reduce) { fillPanel(cur); return; }
      detail.classList.add('swap');
      setTimeout(function () { fillPanel(cur); detail.classList.remove('swap'); }, 160);
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } playBtn.textContent = 'Play through'; }
    prev.addEventListener('click', function () { stop(); select(cur - 1); });
    next.addEventListener('click', function () { stop(); select(cur + 1); });
    playBtn.addEventListener('click', function () {
      if (timer) { stop(); return; }
      if (cur >= steps.length - 1) select(0);
      playBtn.textContent = 'Stop';
      timer = setInterval(function () {
        if (cur >= steps.length - 1) { stop(); return; }
        select(cur + 1);
      }, 1700);
    });
    select(0, true);
  })();

  /* ------------------------------------------------------------------ */
  /* 4. Results: bands grow in, plots open large, failed images vanish   */
  /* ------------------------------------------------------------------ */
  (function results() {
    var bands = $('#bands');
    if (bands) {
      if ('IntersectionObserver' in window && !reduce) {
        var io = new IntersectionObserver(function (en) {
          if (en[0].isIntersecting) { bands.classList.add('in'); io.disconnect(); }
        }, { threshold: 0.4 });
        io.observe(bands);
      } else { bands.classList.add('in'); }
    }

    var plots = $('#plots');
    if (plots) {
      var figs = $$('figure', plots);
      var alive = figs.length;
      figs.forEach(function (fig) {
        var img = $('img', fig);
        function gone() { if (fig.parentNode) { fig.parentNode.removeChild(fig); alive--; if (alive <= 0) plots.hidden = true; } }
        img.addEventListener('error', gone);
        if (img.complete && img.naturalWidth === 0) gone();
        $('.plot-btn', fig).addEventListener('click', function () {
          var dlg = $('#lightbox');
          if (!dlg || !dlg.showModal) return;
          var big = $('img', dlg);
          big.src = img.src; big.alt = img.alt;
          dlg.showModal();
        });
      });
    }
    var dlg = $('#lightbox');
    if (dlg) {
      dlg.addEventListener('click', function () { dlg.close(); });
      $('.close', dlg).addEventListener('click', function () { dlg.close(); });
    }
  })();

  /* ------------------------------------------------------------------ */
  /* 5. Copy buttons                                                     */
  /* ------------------------------------------------------------------ */
  $$('.copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.getElementById(btn.getAttribute('data-copy'));
      if (!el) return;
      var txt = el.textContent;
      function done() { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'Press Ctrl+C'; }
        document.body.removeChild(ta);
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* 6. Dashboard-style polish: cursor glow, scroll reveal, count-up      */
  /* ------------------------------------------------------------------ */
  (function fx() {
    $$('.lab, .kpi, .bands, .detail, .run-step, .panel').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        el.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });

    if (!reduce && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
        });
      }, { threshold: 0.12 });
      $$('.sec h2, .sec .lede, .prose, .lab, .kpi, .bands, .fails, .caveats, .detail, .rail, .brackets, .run-step, .plot-grid figure, .h3-plain').forEach(function (el) {
        var idx = Array.prototype.indexOf.call(el.parentNode.children, el);
        el.style.setProperty('--d', Math.min(idx, 6));
        el.classList.add('rv');
        io.observe(el);
      });
    }

    $$('[data-count]').forEach(function (el) {
      var target = parseFloat(el.getAttribute('data-count'));
      var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
      var suf = el.getAttribute('data-suffix') || '';
      function fmt(v) { return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf; }
      el.textContent = fmt(target);
      if (reduce || !('IntersectionObserver' in window)) return;
      el.textContent = fmt(0);
      var co = new IntersectionObserver(function (en) {
        if (!en[0].isIntersecting) return;
        co.disconnect();
        var t0 = performance.now(), dur = 1600;
        (function step(now) {
          var p = clamp((now - t0) / dur, 0, 1), e = 1 - Math.pow(1 - p, 3);
          el.textContent = fmt(target * e);
          if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(target);
        })(t0);
      }, { threshold: 0.6 });
      co.observe(el);
    });
  })();
})();
