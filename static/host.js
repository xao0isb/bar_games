/* Flappy Beer — runs on the big screen. The flying character is the player's
   own photo (sent from their phone). Obstacles are drinks: beer glasses, soju
   bottles and shot-glass stacks. Physics/rendering happen here; the phone just
   sends "flap" (and once, the player's name + photo). */
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
  const SPEED = 170;         // px/s obstacle scroll
  const OBST_W = 74;         // collision/visual width of a drink column
  const GAP = 180;           // vertical gap the player flies through
  const SPACING = 250;       // horizontal distance between drinks
  const GROUND_H = 96;
  const PLAYER_X = 130;
  const PLAYER_R = 20;
  const DRINKS = ["beer", "soju", "shot"];

  // ---- state ----
  let state = "waiting";     // waiting | lobby | ready | playing | gameover
  let score = 0;
  let best = Number(localStorage.getItem("flappybeer_best") || 0);
  let hero, drinks, groundX = 0;
  let now = 0;
  let player = { name: "", photo: null, img: null };
  let leaveTimer = null;

  function reset() {
    hero = { y: H / 2, vy: 0, angle: 0 };
    drinks = [];
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
  function sendState() { send({ type: "state", state, score, best, name: player.name }); }

  function handleMessage(msg) {
    switch (msg.type) {
      case "flap":
        onFlap();
        break;
      case "player":
        clearTimeout(leaveTimer);
        player.name = String(msg.name || "Игрок").slice(0, 20);
        if (typeof msg.photo === "string" && msg.photo.startsWith("data:image/")) {
          player.photo = msg.photo;
          const im = new Image();
          im.onload = () => { player.img = im; };
          im.src = msg.photo;
        }
        if (state === "waiting" || state === "lobby") setState("ready");
        else { updateOverlay(); sendState(); }
        break;
      case "controller_joined":
        clearTimeout(leaveTimer);
        if (state === "waiting") setState("lobby");
        else sendState();
        break;
      case "controller_left":
        // Tolerate brief mobile drops; only reset to the QR if truly abandoned.
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => {
          player = { name: "", photo: null, img: null };
          setState("waiting");
        }, 3000);
        break;
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
      hero.vy = FLAP_V;
      updateOverlay();
      sendState();
    } else if (state === "playing") {
      hero.vy = FLAP_V;
    } else if (state === "gameover") {
      setState("ready");
    }
    // waiting / lobby: ignore.
  }

  function spawnDrink() {
    const margin = 60;
    const minY = margin + GAP / 2;
    const maxY = H - GROUND_H - margin - GAP / 2;
    const gapY = minY + Math.random() * (maxY - minY);
    const kind = DRINKS[Math.floor(Math.random() * DRINKS.length)];
    drinks.push({ x: W, gapY, kind, passed: false });
  }

  function collides() {
    if (hero.y + PLAYER_R >= H - GROUND_H) return true; // floor = death
    for (const d of drinks) {
      if (PLAYER_X + PLAYER_R > d.x && PLAYER_X - PLAYER_R < d.x + OBST_W) {
        const topH = d.gapY - GAP / 2;
        const botY = d.gapY + GAP / 2;
        if (hero.y - PLAYER_R < topH || hero.y + PLAYER_R > botY) return true;
      }
    }
    return false;
  }

  function update(dt) {
    if (state !== "gameover") groundX -= SPEED * dt;

    if (state === "ready" || state === "waiting" || state === "lobby") {
      hero.y = H / 2 + Math.sin(now / 220) * 10; // gentle idle bob
      hero.angle = Math.sin(now / 220) * 0.12;
      return;
    }

    if (state === "playing") {
      hero.vy += GRAVITY * dt;
      hero.y += hero.vy * dt;
      if (hero.y < PLAYER_R) { hero.y = PLAYER_R; hero.vy = 0; } // bonk ceiling
      hero.angle = Math.max(-0.5, Math.min(1.4, hero.vy / 450 + 0.15));

      if (drinks.length === 0 || drinks[drinks.length - 1].x <= W - SPACING) {
        spawnDrink();
      }
      for (const d of drinks) {
        d.x -= SPEED * dt;
        if (!d.passed && d.x + OBST_W < PLAYER_X) {
          d.passed = true;
          score++;
          sendState();
        }
      }
      drinks = drinks.filter((d) => d.x + OBST_W > -20);

      if (collides()) {
        best = Math.max(best, score);
        localStorage.setItem("flappybeer_best", String(best));
        setState("gameover");
      }
    }
  }

  // ------------------------------ rendering ------------------------------ //
  function rr(x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#4ec0ca");
    g.addColorStop(1, "#8fd9c0");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "rgba(255,255,255,.35)";
    for (let i = 0; i < 3; i++) {
      const cx = ((i * 190 + groundX * 0.3) % (W + 140) + (W + 140)) % (W + 140) - 70;
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

  function drawObstacle(d) {
    const topH = d.gapY - GAP / 2;
    const botY = d.gapY + GAP / 2;
    const groundTop = H - GROUND_H;
    drawDrinkPiece(d.x, botY, groundTop, d.kind);  // bottom: rim faces up into gap
    drawDrinkPiece(d.x, topH, 0, d.kind);          // top: rim faces down into gap
  }
  function drawDrinkPiece(x, rimY, baseY, kind) {
    const len = Math.abs(baseY - rimY);
    if (len <= 1) return;
    const dir = baseY >= rimY ? 1 : -1;
    ctx.save();
    ctx.translate(x, rimY);
    ctx.scale(1, dir);          // local +y goes from rim toward the screen edge
    if (kind === "beer") drawBeer(len);
    else if (kind === "soju") drawSoju(len);
    else drawShotStack(len);
    ctx.restore();
  }

  const W_ = OBST_W;

  function drawBeer(len) {
    const g = ctx.createLinearGradient(0, 0, W_, 0);
    g.addColorStop(0, "#d98407");
    g.addColorStop(0.45, "#ffc63d");
    g.addColorStop(1, "#d17e05");
    ctx.fillStyle = g;
    rr(3, 12, W_ - 6, len - 12, 10);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(120,70,0,.45)";
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.28)";
    for (let i = 0; i < 5; i++) {
      const by = 40 + ((i * 57) % Math.max(1, len - 60));
      ctx.beginPath();
      ctx.arc(18 + (i % 3) * 18, by, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,.4)";
    rr(10, 20, 7, Math.max(1, len - 34), 4);
    ctx.fill();
    ctx.fillStyle = "#fff7ec";
    rr(0, 0, W_, 22, 9);
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i <= 5; i++) ctx.arc(4 + i * 14, 22, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSoju(len) {
    const capH = 12, neckH = 22, shoulderH = 20, neckW = 26;
    const nx = (W_ - neckW) / 2;
    const bodyTop = capH + neckH + shoulderH;
    const g = ctx.createLinearGradient(0, 0, W_, 0);
    g.addColorStop(0, "#2b7a46");
    g.addColorStop(0.45, "#5ec585");
    g.addColorStop(1, "#256b3d");
    ctx.fillStyle = g;
    rr(3, bodyTop, W_ - 6, len - bodyTop, 10);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(nx, capH + neckH);
    ctx.lineTo(nx + neckW, capH + neckH);
    ctx.lineTo(W_ - 5, bodyTop + 4);
    ctx.lineTo(5, bodyTop + 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#2f8a4f";
    ctx.fillRect(nx, capH, neckW, neckH + 2);
    ctx.fillStyle = "#d7dde0";
    rr(nx - 1, 0, neckW + 2, capH + 2, 3);
    ctx.fill();
    ctx.fillStyle = "#f4f6f2";
    const ly = bodyTop + (len - bodyTop) * 0.32;
    rr(8, ly, W_ - 16, Math.min(64, (len - bodyTop) * 0.42), 6);
    ctx.fill();
    ctx.fillStyle = "#3a9d5d";
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(14, ly + 10 + i * 12, W_ - 28 - (i === 2 ? 18 : 0), 4);
    }
    ctx.fillStyle = "rgba(255,255,255,.3)";
    rr(9, bodyTop + 6, 6, Math.max(1, len - bodyTop - 14), 3);
    ctx.fill();
  }

  function drawShotStack(len) {
    const n = Math.max(1, Math.round(len / 50));
    const h = len / n;
    for (let i = 0; i < n; i++) shotGlass(i * h, h);
  }
  function shotGlass(y, h) {
    const topIn = 4, botIn = 11;
    ctx.beginPath();
    ctx.moveTo(topIn, y + 2);
    ctx.lineTo(W_ - topIn, y + 2);
    ctx.lineTo(W_ - botIn, y + h - 1);
    ctx.lineTo(botIn, y + h - 1);
    ctx.closePath();
    ctx.fillStyle = "rgba(216,236,255,.5)";
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "#e79a2a";
    ctx.fillRect(0, y + h * 0.46, W_, h);
    ctx.fillStyle = "rgba(255,255,255,.25)";
    ctx.fillRect(0, y + h * 0.46, W_, 3);
    ctx.restore();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(255,255,255,.75)";
    ctx.beginPath();
    ctx.moveTo(topIn, y + 2);
    ctx.lineTo(W_ - topIn, y + 2);
    ctx.lineTo(W_ - botIn, y + h - 1);
    ctx.lineTo(botIn, y + h - 1);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.95)";
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(topIn, y + 2.5);
    ctx.lineTo(W_ - topIn, y + 2.5);
    ctx.stroke();
  }

  function drawGround() {
    const y = H - GROUND_H;
    ctx.fillStyle = "#5c3a1c";
    ctx.fillRect(0, y, W, 10);
    const g = ctx.createLinearGradient(0, y, 0, H);
    g.addColorStop(0, "#9a6535");
    g.addColorStop(1, "#6e4522");
    ctx.fillStyle = g;
    ctx.fillRect(0, y + 10, W, GROUND_H - 10);
    ctx.fillStyle = "rgba(255,224,176,.18)";
    ctx.fillRect(0, y + 10, W, 5);
    ctx.strokeStyle = "rgba(58,34,14,.5)";
    ctx.lineWidth = 2;
    const tile = 60;
    const off = ((groundX % tile) + tile) % tile;
    for (let x = -tile; x < W + tile; x += tile) {
      const px = x + off;
      ctx.beginPath();
      ctx.moveTo(px, y + 10);
      ctx.lineTo(px, H);
      ctx.stroke();
    }
  }

  // The flying character: the player's photo, clipped to a circle with a beer-gold
  // ring. Falls back to a golden disc with the name's initial until the photo loads.
  function drawPlayer() {
    const R = PLAYER_R;
    ctx.save();
    ctx.translate(PLAYER_X, hero.y);
    ctx.rotate(hero.angle * 0.6);

    ctx.beginPath();
    ctx.arc(0, 0, R + 3, 0, Math.PI * 2);
    ctx.fillStyle = "#f0a400";
    ctx.fill();

    if (player.img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(player.img, -R, -R, R * 2, R * 2);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fillStyle = "#ffca4a";
      ctx.fill();
      ctx.fillStyle = "#7a4e00";
      ctx.font = `800 ${Math.round(R * 1.1)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((player.name || "?").slice(0, 1).toUpperCase(), 0, 1);
    }

    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.restore();
  }

  function drawHud() {
    if (state !== "playing" && state !== "gameover") return;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = '800 56px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0,0,0,.45)";
    ctx.fillStyle = "#fff";
    ctx.strokeText(String(score), W / 2, 92);
    ctx.fillText(String(score), W / 2, 92);
    if (player.name) {
      const nm = player.name.length > 18 ? player.name.slice(0, 18) + "…" : player.name;
      ctx.font = '700 20px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,.4)";
      ctx.strokeText(nm, W / 2, 120);
      ctx.fillStyle = "#fff";
      ctx.fillText(nm, W / 2, 120);
    }
  }

  function render() {
    drawBackground();
    for (const d of drinks) drawObstacle(d);
    drawGround();
    drawPlayer();
    drawHud();
  }

  // ---------------------------- overlay text ---------------------------- //
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function avatarHtml() {
    return player.photo ? `<img class="ov-avatar" src="${player.photo}" alt="">` : "";
  }

  function updateOverlay() {
    if (state === "lobby") {
      overlay.style.display = "flex";
      overlay.innerHTML =
        '<div class="overlay-card"><h1>Игрок подключается…</h1>' +
        "<p>Введите имя и добавьте фото на телефоне</p></div>";
    } else if (state === "ready") {
      overlay.style.display = "flex";
      overlay.innerHTML =
        '<div class="overlay-card">' + avatarHtml() +
        "<h1>" + (esc(player.name) || "Готовы") + ", вперёд!</h1>" +
        "<p>Нажмите кнопку на телефоне,<br>чтобы взлететь</p></div>";
    } else if (state === "gameover") {
      overlay.style.display = "flex";
      overlay.innerHTML =
        '<div class="overlay-card">' + avatarHtml() +
        "<h1>Игра окончена</h1>" +
        (player.name ? '<p class="who">' + esc(player.name) + "</p>" : "") +
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
