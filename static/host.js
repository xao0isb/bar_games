/* Flappy Beer — big-screen game, rendered as old-school pixel art. The canvas
   backing store is a tiny 144x192; CSS upscales it with nearest-neighbour, so
   everything (sprites, the player's photo, text) comes out chunky and retro.
   The flying character is the player's own photo (sent from their phone). */
(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const qrPanel = document.getElementById("qr-panel");
  const overlay = document.getElementById("overlay");

  // Low-res pixel buffer (0.75 aspect, matches the 480x640 stage). CSS scales up.
  const W = 144, H = 192;
  canvas.width = W;
  canvas.height = H;
  ctx.imageSmoothingEnabled = false;

  // ---- tunables (world runs in the 144x192 pixel space) ----
  const GRAVITY = 450;
  const FLAP_V = -141;
  const SPEED = 51;
  const OBST_W = 22;
  const GAP = 56;
  const SPACING = 75;
  const GROUND_H = 28;
  const PLAYER_X = 40;
  const PLAYER_R = 7;
  const DRINKS = ["beer", "soju", "shot"];

  const COL = {
    sky: "#4ec0ca", cloud: "#ffffff", outline: "#20160c",
    beer: "#ffb43f", beerHi: "#ffd889", beerSh: "#e2902a", foam: "#fff6e6",
    soju: "#37b06a", sojuHi: "#69d998", sojuSh: "#238a4f", label: "#f2f2ea", cap: "#cfd6d8",
    glass: "#bfe0ff", glassHi: "#ffffff", shot: "#e79a2a",
    wood: "#9a6535", woodDark: "#6e4522", woodTop: "#b98a55",
    hud: "#ffffff", hudSh: "#20160c",
  };

  // ---- state ----
  let state = "waiting";     // waiting | lobby | ready | playing | gameover
  let score = 0;
  let best = Number(localStorage.getItem("flappybeer_best") || 0);
  let hero, drinks, groundX = 0;
  let now = 0;
  let player = { name: "", photo: null, img: null };
  let leaveTimer = null;

  function reset() {
    hero = { y: H / 2, vy: 0 };
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
          im.onload = () => { player.img = pixelate(im, PLAYER_R * 2); };
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
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => {
          player = { name: "", photo: null, img: null };
          setState("waiting");
        }, 3000);
        break;
    }
  }

  // Pre-shrink the photo to a tiny square once, so it draws crisp & blocky.
  function pixelate(image, d) {
    const oc = document.createElement("canvas");
    oc.width = oc.height = d;
    const ox = oc.getContext("2d");
    ox.imageSmoothingEnabled = true; // quality downsample to d x d
    ox.drawImage(image, 0, 0, d, d);
    return oc;
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
  }

  function spawnDrink() {
    const margin = 16;
    const minY = margin + GAP / 2;
    const maxY = H - GROUND_H - margin - GAP / 2;
    const gapY = Math.round(minY + Math.random() * (maxY - minY));
    const kind = DRINKS[Math.floor(Math.random() * DRINKS.length)];
    drinks.push({ x: W, gapY, kind, passed: false });
  }

  function collides() {
    if (hero.y + PLAYER_R >= H - GROUND_H) return true;
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
      hero.y = H / 2 + Math.sin(now / 220) * 3; // idle bob
      return;
    }

    if (state === "playing") {
      hero.vy += GRAVITY * dt;
      hero.y += hero.vy * dt;
      if (hero.y < PLAYER_R) { hero.y = PLAYER_R; hero.vy = 0; }

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
      drinks = drinks.filter((d) => d.x + OBST_W > -6);

      if (collides()) {
        best = Math.max(best, score);
        localStorage.setItem("flappybeer_best", String(best));
        setState("gameover");
      }
    }
  }

  // ------------------------------ pixel rendering ------------------------------ //
  function mod(a, n) { return ((a % n) + n) % n; }
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  function drawBackground() {
    px(0, 0, W, H, COL.sky);
    for (let i = 0; i < 3; i++) {
      const cx = mod(i * 58 + groundX * 0.3, W + 44) - 24;
      pixelCloud(cx, 20 + i * 15);
    }
  }
  function pixelCloud(x, y) {
    px(x, y, 20, 6, COL.cloud);
    px(x + 5, y - 4, 11, 5, COL.cloud);
    px(x - 3, y + 3, 26, 5, COL.cloud);
  }

  function drawObstacle(d) {
    const topH = d.gapY - GAP / 2;
    const botY = d.gapY + GAP / 2;
    const groundTop = H - GROUND_H;
    drawDrinkPiece(d.x, botY, groundTop, d.kind);
    drawDrinkPiece(d.x, topH, 0, d.kind);
  }
  function drawDrinkPiece(x, rimY, baseY, kind) {
    const len = Math.abs(baseY - rimY);
    if (len <= 0) return;
    const dir = baseY >= rimY ? 1 : -1;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(rimY));
    ctx.scale(1, dir);
    if (kind === "beer") drinkBeer(len);
    else if (kind === "soju") drinkSoju(len);
    else drinkShot(len);
    ctx.restore();
  }

  function drinkBeer(len) {
    px(0, 0, OBST_W, len, COL.beer);
    px(0, 0, 4, len, COL.beerHi);
    px(OBST_W - 4, 0, 4, len, COL.beerSh);
    px(0, 0, OBST_W, 6, COL.foam);          // foam head at rim
    px(2, 6, 3, 2, COL.foam);
    px(9, 6, 4, 2, COL.foam);
    px(16, 6, 3, 2, COL.foam);
    px(0, 0, 1, len, COL.outline);
    px(OBST_W - 1, 0, 1, len, COL.outline);
    px(0, len - 1, OBST_W, 1, COL.outline);
  }

  function drinkSoju(len) {
    if (len < 20) {
      px(0, 0, OBST_W, len, COL.soju);
      px(0, 0, 1, len, COL.outline);
      px(OBST_W - 1, 0, 1, len, COL.outline);
      return;
    }
    const cap = 3, neck = 6, shoulder = 4, bodyTop = cap + neck + shoulder;
    px(0, bodyTop, OBST_W, len - bodyTop, COL.soju);
    px(0, bodyTop, 4, len - bodyTop, COL.sojuHi);
    px(OBST_W - 4, bodyTop, 4, len - bodyTop, COL.sojuSh);
    px(4, bodyTop - 2, OBST_W - 8, 2, COL.soju);   // shoulder step
    px(8, cap, 6, neck, COL.soju);                 // neck
    px(8, 0, 6, cap, COL.cap);                     // cap
    const lh = Math.min(14, Math.floor((len - bodyTop) * 0.45));
    px(2, bodyTop + Math.floor((len - bodyTop) * 0.3), OBST_W - 4, lh, COL.label);
    px(0, bodyTop, 1, len - bodyTop, COL.outline);
    px(OBST_W - 1, bodyTop, 1, len - bodyTop, COL.outline);
    px(0, len - 1, OBST_W, 1, COL.outline);
  }

  function drinkShot(len) {
    const n = Math.max(1, Math.round(len / 14));
    const h = len / n;
    for (let i = 0; i < n; i++) {
      const y = i * h;
      px(1, y, OBST_W - 2, h - 1, COL.glass);
      const lq = Math.max(2, Math.floor(h * 0.45));
      px(1, y + h - 1 - lq, OBST_W - 2, lq, COL.shot);
      px(1, y, OBST_W - 2, 2, COL.glassHi);
      px(0, y, 1, h, COL.outline);
      px(OBST_W - 1, y, 1, h, COL.outline);
      px(0, y + h - 1, OBST_W, 1, COL.outline);
    }
  }

  function drawGround() {
    const y = H - GROUND_H;
    px(0, y, W, 2, COL.outline);
    px(0, y + 2, W, 2, COL.woodTop);
    px(0, y + 4, W, GROUND_H - 4, COL.wood);
    const tile = 16;
    const off = mod(groundX, tile);
    for (let x = -tile; x < W + tile; x += tile) {
      px(x + off, y + 4, 1, GROUND_H - 4, COL.woodDark);
    }
  }

  // The player's photo as a framed pixel portrait (square = retro).
  function drawPlayer() {
    const R = PLAYER_R;
    const d = R * 2;
    const x = Math.round(PLAYER_X - R);
    const y = Math.round(hero.y - R);
    px(x - 2, y - 2, d + 4, d + 4, COL.outline);
    px(x - 1, y - 1, d + 2, d + 2, COL.foam);
    if (player.img) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(player.img, x, y, d, d);
    } else {
      px(x, y, d, d, COL.beer);
      px(x + 3, y + 4, 2, 2, COL.outline);
      px(x + d - 5, y + 4, 2, 2, COL.outline);
      px(x + 4, y + d - 4, d - 8, 1, COL.outline);
    }
  }

  function hudText(str, x, y, size, align) {
    ctx.font = `bold ${size}px "Courier New", ui-monospace, monospace`;
    ctx.textAlign = align || "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = COL.hudSh;
    ctx.fillText(str, x + 1, y + 1);
    ctx.fillStyle = COL.hud;
    ctx.fillText(str, x, y);
  }
  function drawHud() {
    if (state !== "playing" && state !== "gameover") return;
    hudText(String(score), W / 2, 6, 18);
    if (player.name) {
      const nm = player.name.length > 12 ? player.name.slice(0, 12) : player.name;
      hudText(nm, W / 2, 26, 8);
    }
  }

  function render() {
    drawBackground();
    for (const d of drinks) drawObstacle(d);
    drawGround();
    drawPlayer();
    drawHud();
  }

  // ---------------------------- overlay text (DOM) ---------------------------- //
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
    if (dt > 0.05) dt = 0.05;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  setState("waiting");
})();
