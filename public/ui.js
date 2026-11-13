// UI-only helpers: keyboard access for the drop area, proxy buttons and the video before/after wipe.
document.addEventListener('keydown', (e) => {
  const d = document.querySelector('.drop');
  const f = document.getElementById('fileInput');
  if (d && f && e.target === d && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); f.click(); }
});
// A visible button that simply triggers another control (keeps element IDs unique).
document.addEventListener('click', (e) => {
  const proxy = e.target.closest('[data-proxy]');
  if (!proxy) return;
  const target = document.getElementById(proxy.dataset.proxy);
  if (target) target.click();
});
const media = document.getElementById('comparePlayer');
if (media) {
  let drag = false;
  const set = (x) => {
    const r = media.getBoundingClientRect();
    media.style.setProperty('--x', Math.min(100, Math.max(0, ((x - r.left) / r.width) * 100)) + '%');
  };
  media.addEventListener('pointerdown', (e) => { if (e.target.closest('.wipe,video')) { drag = true; media.setPointerCapture(e.pointerId); set(e.clientX); } });
  media.addEventListener('pointermove', (e) => { if (drag) set(e.clientX); });
  media.addEventListener('pointerup', () => { drag = false; });
}

// Loading card: the watermark sparkle turns to dust as the engine's progress climbs.
const bar = document.getElementById('progressBar');
const pct = document.getElementById('busyPct');
const txt = document.getElementById('busyText');
const ptxt = document.getElementById('progressText');
const cv = document.getElementById('dust');
let target = 0;
function syncBusy() {
  target = Math.max(0, Math.min(100, parseFloat(bar.style.width) || 0));
  pct.textContent = Math.round(target);
  const ttl = document.querySelector('.busy-title'); if (ttl) ttl.textContent = target >= 100 ? 'Sparkle gone' : 'Blowing the sparkle away';
  if (ptxt && ptxt.textContent.trim()) txt.textContent = ptxt.textContent.trim();
}
if (bar && pct && txt && cv) {
  new MutationObserver(syncBusy).observe(bar, { attributes: true, attributeFilter: ['style'] });
  if (ptxt) new MutationObserver(syncBusy).observe(ptxt, { childList: true, characterData: true, subtree: true });

  const ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = 340, H = 260, S = 210, ox = (W - S) / 2 + 10, oy = (H - S) / 2, PAD = 36;
  cv.width = W * dpr; cv.height = H * dpr;

  // ---- 1. The sparkle itself: one smooth vector shape with a soft glow, drawn once into a sprite. ----
  const SP = S + PAD * 2;
  const sparklePath = () => new Path2D(`M${PAD + S/2} ${PAD}C${PAD + S*.54} ${PAD + S*.31} ${PAD + S*.69} ${PAD + S*.46} ${PAD + S} ${PAD + S/2}C${PAD + S*.69} ${PAD + S*.54} ${PAD + S*.54} ${PAD + S*.69} ${PAD + S/2} ${PAD + S}C${PAD + S*.46} ${PAD + S*.69} ${PAD + S*.31} ${PAD + S*.54} ${PAD} ${PAD + S/2}C${PAD + S*.31} ${PAD + S*.46} ${PAD + S*.46} ${PAD + S*.31} ${PAD + S/2} ${PAD}Z`);
  const mk = (n) => { const c = document.createElement('canvas'); c.width = c.height = n * dpr; const x = c.getContext('2d'); x.scale(dpr, dpr); return [c, x]; };
  const [sprite, sx] = mk(SP);
  const [work, wx] = mk(SP);
  {
    const path = sparklePath();
    sx.shadowColor = 'rgba(255,140,90,.65)'; sx.shadowBlur = 28;
    const body = sx.createLinearGradient(PAD, PAD, PAD + S, PAD + S);
    body.addColorStop(0, '#fffaf3'); body.addColorStop(.55, '#ffe6d1'); body.addColorStop(1, '#ffc29a');
    sx.fillStyle = body; sx.fill(path);
    sx.shadowColor = 'transparent'; sx.shadowBlur = 0;
    const hi = sx.createRadialGradient(PAD + S/2, PAD + S/2, 0, PAD + S/2, PAD + S/2, S * .34);
    hi.addColorStop(0, 'rgba(255,255,255,.95)'); hi.addColorStop(1, 'rgba(255,255,255,0)');
    sx.fillStyle = hi; sx.fill(path);
  }

  // Points inside the shape: dust is born from these, only where the dissolve edge is passing.
  const probe = document.createElement('canvas'); probe.width = probe.height = S;
  const pr = probe.getContext('2d', { willReadFrequently: true });
  pr.fillStyle = '#fff'; pr.translate(-PAD, -PAD); pr.fill(sparklePath());
  const pd = pr.getImageData(0, 0, S, S).data;
  const pts = [];
  for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) if (pd[(y * S + x) * 4 + 3] > 128) pts.push([x, y]);

  // ---- 2. Dissolve geometry: a soft, slightly tilted feathered edge sweeps across the shape. ----
  const ANG = .22, COS = Math.cos(ANG), SIN = Math.sin(ANG);
  const HALF = (S / 2) * (COS + SIN), FEATHER = S * .42;
  const edgeAt = (k) => -HALF + k * (2 * HALF + FEATHER);              // k: 0..1
  const proj = (x, y) => (x - S / 2) * COS + (y - S / 2) * SIN;
  const ease = (t) => t * t * (3 - 2 * t);

  // ---- 3. Dust: soft round motes that lift off and fade, no hard squares. ----
  const MAX = 240, dust = [];
  const spawn = (px, py) => {
    const a = -.5 + Math.random() * .9;
    dust.push({ x: ox + px, y: oy + py, vx: 26 + Math.random() * 60, vy: -10 - Math.random() * 38 + a * 10,
      r: .9 + Math.random() * 1.8, age: 0, life: 1.1 + Math.random() * 1.1, ph: Math.random() * 6.28 });
  };

  let shown = 0, last = 0, appear = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (!cv.offsetParent) { last = 0; return; }                         // only animate while the loading card is visible
    const dt = Math.min(.05, (ts - (last || ts)) / 1000); last = ts;
    if (target + 4 < shown) { shown = 0; appear = 0; dust.length = 0; } // a new job started
    const prev = shown;
    shown += (target - shown) * (1 - Math.exp(-dt * 3));                // smooth, never jumps
    if (target - shown < .05) shown = target;
    appear = Math.min(1, appear + dt * 2.5);
    const k = Math.min(1, shown / 100);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // sparkle sprite with a feathered erase mask
    const u = edgeAt(k), cx = SP / 2, cy = SP / 2;
    wx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wx.globalCompositeOperation = 'source-over';
    wx.clearRect(0, 0, SP, SP);
    wx.drawImage(sprite, 0, 0, SP, SP);
    if (k > 0) {
      const g = wx.createLinearGradient(cx + COS * (u - FEATHER), cy + SIN * (u - FEATHER), cx + COS * u, cy + SIN * u);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(.5, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      wx.globalCompositeOperation = 'destination-out';
      wx.fillStyle = g; wx.fillRect(0, 0, SP, SP);
      wx.globalCompositeOperation = 'source-over';
    }
    const tw = reduce ? 0 : Math.sin(ts / 700);
    const pulse = 1 + tw * .012 * (1 - k);                              // gentle breathing while it waits
    ctx.globalAlpha = ease(appear);
    ctx.save();
    ctx.translate(ox + S / 2, oy + S / 2); ctx.scale(pulse, pulse);
    ctx.drawImage(work, -SP / 2, -SP / 2, SP, SP);
    ctx.restore();
    ctx.globalAlpha = 1;

    // spawn dust only where the edge currently is
    if (!reduce && k < 1 && dust.length < MAX) {
      const tries = (60 + Math.max(0, shown - prev) * 40 / Math.max(dt, .001)) * dt * 3;
      for (let i = 0; i < tries; i++) {
        const [x, y] = pts[(Math.random() * pts.length) | 0];
        const d = u - proj(x, y);                                       // 0 at the clear edge, FEATHER deep inside the solid
        if (d > 0 && d < FEATHER && Math.random() < Math.sin((d / FEATHER) * Math.PI) * .9) spawn(x, y);
      }
    }

    // draw dust
    ctx.globalCompositeOperation = 'lighter';
    for (let i = dust.length - 1; i >= 0; i--) {
      const p = dust[i];
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) { dust.splice(i, 1); continue; }
      const drag = Math.exp(-1.4 * dt);
      p.vx *= drag; p.vy *= drag; p.vy -= 6 * dt;
      p.x += p.vx * dt + Math.sin(p.age * 3 + p.ph) * .25;
      p.y += p.vy * dt + Math.cos(p.age * 2.4 + p.ph) * .2;
      const a = (1 - ease(t)) * Math.min(1, p.age * 8) * .9;
      const r = p.r * (1 - t * .55);
      ctx.fillStyle = `rgba(255,${200 - t * 70 | 0},${150 - t * 70 | 0},${a * .22})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.6, 0, 6.2832); ctx.fill();
      ctx.fillStyle = `rgba(255,${238 - t * 50 | 0},${220 - t * 70 | 0},${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  requestAnimationFrame(frame);
}
