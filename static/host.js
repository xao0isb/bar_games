/* Flappy Bird — runs on the big screen. Receives "flap" events from the phone
   over a WebSocket and makes the bird jump. All physics/rendering happen here. */
(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const qrPanel = document.getElementById("qr-panel");
  const overlay = document.getElementById("overlay");

  // Logical game size (rendered crisp via devicePixelRatio, scaled by CSS).
  const W = 480, H = 640;
  const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.scale(DPR, DPR);

  // ---- tunables ----
  const GRAVITY = 1500;      // px/s^2
  const FLAP_V = -470;       // px/s impulse
  const PIPE_SPEED = 170;    // px/s
  const PIPE_W = 74;
  const PIPE_GAP = 180;
  const PIPE_INTERVAL = 250; // horizontal gap between pipes
  const GROUND_H = 96;
  const BIRD_X = 130;
  const BIRD_R = 16;

  // ---- state ----
  let state = "waiting";     // waiting | ready | playing | gameover
  let score = 0;
  let best = Number(localStorage.getItem("flappy_best") || 0);
  let bird, pipes, groundX = 0;
  let now = 0;

  function reset() {
    bird = { y: H / 2, vy: 0, angle: 0 };
    pipes = [];
    score = 0;
  }
  reset();

  // ---------------------------- networking ---------------------------- //
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/ws/${SESSION_ID}/host`;
  let ws = null;

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => sendState();
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = () => { ws = null; setTimeout(connect, 1000); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  connect();

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function sendState() { send({ type: "state", state, score, best }); }

  function handleMessage(msg) {
    switch (msg.type) {
      case "flap":
        onFlap();
        break;
      case "controller_joined":
        if (state === "waiting") setState("ready");
        else sendState();
        break;
      // "controller_left" — keep the game running; the phone may reconnect.
    }
  }

  // ---------------------------- game control ---------------------------- //
  function setState(s) {
    state = s;
    if (s === "ready") reset();
    qrPanel.style.display = s === "waiting" ? "flex" : "none";
    updateOverlay();
    sendState();
  }

  function onFlap() {
    if (state === "ready") {
      state = "playing";
      bird.vy = FLAP_V;
      updateOverlay();
      sendState();
    } else if (state === "playing") {
      bird.vy = FLAP_V;
    } else if (state === "gameover") {
      setState("ready");
    }
    // "waiting": no controller yet — ignore.
  }

  function spawnPipe() {
    const margin = 60;
    const minY = margin + PIPE_GAP / 2;
    const maxY = H - GROUND_H - margin - PIPE_GAP / 2;
    const gapY = minY + Math.random() * (maxY - minY);
    pipes.push({ x: W, gapY, passed: false });
  }

  function collides() {
    if (bird.y + BIRD_R >= H - GROUND_H) return true; // ground = death
    for (const p of pipes) {
      if (BIRD_X + BIRD_R > p.x && BIRD_X - BIRD_R < p.x + PIPE_W) {
        const topH = p.gapY - PIPE_GAP / 2;
        const botY = p.gapY + PIPE_GAP / 2;
        if (bird.y - BIRD_R < topH || bird.y + BIRD_R > botY) return true;
      }
    }
    return false;
  }

  function update(dt) {
    if (state !== "gameover") groundX = (groundX - PIPE_SPEED * dt) % 48;

    if (state === "ready" || state === "waiting") {
      // gentle idle bob
      bird.y = H / 2 + Math.sin(now / 220) * 10;
      bird.angle = Math.sin(now / 220) * 0.12;
      return;
    }

    if (state === "playing") {
      bird.vy += GRAVITY * dt;
      bird.y += bird.vy * dt;
      if (bird.y < BIRD_R) { bird.y = BIRD_R; bird.vy = 0; } // bonk ceiling
      bird.angle = Math.max(-0.5, Math.min(1.4, bird.vy / 450 + 0.15));

      if (pipes.length === 0 || pipes[pipes.length - 1].x <= W - PIPE_INTERVAL) {
        spawnPipe();
      }
      for (const p of pipes) {
        p.x -= PIPE_SPEED * dt;
        if (!p.passed && p.x + PIPE_W < BIRD_X) {
          p.passed = true;
          score++;
          sendState();
        }
      }
      pipes = pipes.filter((p) => p.x + PIPE_W > -20);

      if (collides()) {
        best = Math.max(best, score);
        localStorage.setItem("flappy_best", String(best));
        setState("gameover");
      }
    }
  }

  // ------------------------------ rendering ------------------------------ //
  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#4ec0ca");
    g.addColorStop(1, "#8fd9c0");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "rgba(255,255,255,.35)";
    for (let i = 0; i < 3; i++) {
      const cx = ((i * 190 + groundX * 0.3) % (W + 140)) - 70;
      cloud(cx, 90 + i * 46, 30 + i * 6);
    }
  }
  function cloud(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.arc(x + r, y + 6, r * 0.8, 0, Math.PI * 2);
    ctx.arc(x - r, y + 8, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPipe(p) {
    const topH = p.gapY - PIPE_GAP / 2;
    const botY = p.gapY + PIPE_GAP / 2;
    const botH = H - GROUND_H - botY;
    const capH = 26, capOver = 4;

    ctx.fillStyle = "#5aa02c";
    ctx.strokeStyle = "#3f7a1e";
    ctx.lineWidth = 3;

    ctx.fillRect(p.x, 0, PIPE_W, topH);
    ctx.strokeRect(p.x, 0, PIPE_W, topH);
    ctx.fillRect(p.x - capOver, topH - capH, PIPE_W + capOver * 2, capH);
    ctx.strokeRect(p.x - capOver, topH - capH, PIPE_W + capOver * 2, capH);

    ctx.fillRect(p.x, botY, PIPE_W, botH);
    ctx.strokeRect(p.x, botY, PIPE_W, botH);
    ctx.fillRect(p.x - capOver, botY, PIPE_W + capOver * 2, capH);
    ctx.strokeRect(p.x - capOver, botY, PIPE_W + capOver * 2, capH);

    ctx.fillStyle = "rgba(255,255,255,.18)";
    ctx.fillRect(p.x + 6, 0, 8, topH);
    ctx.fillRect(p.x + 6, botY, 8, botH);
  }

  function drawGround() {
    const y = H - GROUND_H;
    ctx.fillStyle = "#5aa02c";
    ctx.fillRect(0, y, W, 16);
    ctx.fillStyle = "#ded895";
    ctx.fillRect(0, y + 16, W, GROUND_H - 16);

    ctx.fillStyle = "#c9bf7a";
    const tile = 48;
    for (let x = -tile; x < W + tile; x += tile) {
      const px = x + (groundX % tile);
      ctx.beginPath();
      ctx.moveTo(px, y + 16);
      ctx.lineTo(px + tile / 2, y + 16);
      ctx.lineTo(px + tile / 2 - 8, y + GROUND_H);
      ctx.lineTo(px - 8, y + GROUND_H);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawBird() {
    ctx.save();
    ctx.translate(BIRD_X, bird.y);
    ctx.rotate(bird.angle);

    ctx.fillStyle = "#f4d03f";
    ctx.strokeStyle = "#c9a227";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#fff7d6";
    ctx.beginPath();
    ctx.ellipse(-3, 3, 8, 5, Math.sin(now / 90) * 0.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(7, -6, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#222";
    ctx.beginPath(); ctx.arc(9, -6, 2.4, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = "#e67e22";
    ctx.beginPath();
    ctx.moveTo(13, -2); ctx.lineTo(24, 1); ctx.lineTo(13, 5); ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawScore() {
    if (state !== "playing" && state !== "gameover") return;
    ctx.font = '800 56px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "center";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0,0,0,.45)";
    ctx.fillStyle = "#fff";
    ctx.strokeText(String(score), W / 2, 96);
    ctx.fillText(String(score), W / 2, 96);
  }

  function render() {
    drawBackground();
    for (const p of pipes) drawPipe(p);
    drawGround();
    drawBird();
    drawScore();
  }

  // ---------------------------- overlay text ---------------------------- //
  function updateOverlay() {
    if (state === "ready") {
      overlay.style.display = "flex";
      overlay.innerHTML =
        '<div class="overlay-card"><h1>Приготовьтесь!</h1>' +
        "<p>Нажмите кнопку на телефоне,<br>чтобы птичка взлетела</p></div>";
    } else if (state === "gameover") {
      overlay.style.display = "flex";
      overlay.innerHTML =
        '<div class="overlay-card"><h1>Игра окончена</h1>' +
        '<p class="score">' + score + "</p>" +
        "<p>Рекорд: " + best + "</p>" +
        '<p class="hint">Нажмите кнопку на телефоне,<br>чтобы сыграть снова</p></div>';
    } else {
      overlay.style.display = "none";
    }
  }

  // ------------------------------ main loop ------------------------------ //
  let last = 0;
  function loop(t) {
    now = t;
    if (!last) last = t;
    let dt = (t - last) / 1000;
    last = t;
    if (dt > 0.05) dt = 0.05; // clamp after tab was backgrounded
    update(dt);
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  setState("waiting");
})();
