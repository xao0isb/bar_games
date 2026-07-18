/* Flappy Beer — big-screen game, rendered crisp instead of pixelated. The world
   simulation runs in a small 144x192 space (so physics/tuning are unchanged), but
   the canvas backing store is sized to the display and the drawing context is
   scaled up by an integer factor S. That means the player's photo, the HUD text
   and the drink obstacles all come out smooth. The flying character is the
   player's own photo (sent from their phone). */
(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const qrPanel = document.getElementById("qr-panel");
  const overlay = document.getElementById("overlay");

  // World space (physics). Everything is drawn in these units; the context is
  // scaled by S device-pixels-per-unit so the result is crisp, not pixelated.
  const W = 144, H = 192;
  let S = 3;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = canvas.clientWidth ||
      (canvas.parentElement && canvas.parentElement.clientWidth) || 432;
    S = Math.max(3, Math.min(8, Math.round((cssW * dpr) / W)));
    canvas.width = W * S;
    canvas.height = H * S;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }
  window.addEventListener("resize", resize);
  window.addEventListener("load", resize);
  resize();

  // ---- tunables (world runs in the 144x192 space) ----
  const GRAVITY = 450;
  const FLAP_V = -141;
  const SPEED = 51;
  const OBST_W = 22;
  const GAP = 56;
  const SPACING = 75;
  const GROUND_H = 28;
  const PLAYER_X = 40;
  const PLAYER_R = 7;      // collision radius (gameplay)
  const AVATAR_R = 8.4;    // drawn radius (slightly larger, forgiving)
  const DRINKS = ["beer", "soju", "shot"];

  const COL = {
    sky: "#5ec7d6", skyTop: "#93e2ec", cloud: "#ffffff", outline: "#20160c",
    // beer
    beerHi: "#ffe08a", beer: "#ffb43f", beerSh: "#d98b24", beerEdge: "#9c5b12",
    foam: "#fff7ea", foamSh: "#e7d6bb",
    // soju
    soju: "#37b06a", sojuHi: "#79dfa2", sojuSh: "#1f8f52", sojuEdge: "#12673a",
    capHi: "#ffffff", capSh: "#9aa2a7",
    label: "#f5f3ec", labelStripe: "#2ea3d8", labelText: "#aeb6bb", labelAccent: "#d6493f",
    // shot / liquor
    glass: "#bfe0ff", glassHi: "#ffffff", glassSh: "#a7ccec", glassEdge: "#6f97bb",
    liquorHi: "#f2bb55", liquor: "#df9a2c", liquorDark: "#b06f18", meniscus: "#ffe7ab",
    // bar / ground
    wood: "#8f5f31", woodDark: "#6a441f", woodTop: "#b5824e", woodHi: "#caa070",
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
          im.onload = () => { player.img = im; };   // keep it full-res -> crisp
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
      hero.vy = Math.cos(now / 220) * 3 * (1000 / 220); // for a gentle avatar tilt
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

  // ------------------------------ rendering ------------------------------ //
  function mod(a, n) { return ((a % n) + n) % n; }

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COL.skyTop);
    g.addColorStop(0.65, COL.sky);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 3; i++) {
      const cx = mod(i * 58 + groundX * 0.3, W + 44) - 24;
      cloud(cx, 20 + i * 15);
    }
  }
  function cloud(x, y) {
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.arc(x + 4, y + 3, 5, 0, 7);
    ctx.arc(x + 11, y + 1, 6, 0, 7);
    ctx.arc(x + 18, y + 3, 5, 0, 7);
    ctx.rect(x + 2, y + 3, 18, 5);
    ctx.fill();
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
    ctx.translate(x, rimY);
    ctx.scale(1, dir);        // top piece is flipped so its "mouth" faces the gap
    if (kind === "beer") drinkBeer(len);
    else if (kind === "soju") drinkSoju(len);
    else drinkShot(len);
    ctx.restore();
  }

  // A frosty mug of amber beer with a foamy head at the rim.
  function drinkBeer(len) {
    const w = OBST_W;
    const foamH = Math.max(6, Math.min(11, len * 0.22));
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, COL.beerEdge);
    g.addColorStop(0.16, COL.beerSh);
    g.addColorStop(0.42, COL.beerHi);
    g.addColorStop(0.5, COL.beer);
    g.addColorStop(0.72, COL.beerSh);
    g.addColorStop(1, COL.beerEdge);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, len);
    // glossy vertical streak
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(w * 0.3, foamH, 2, len - foamH);
    // rising bubbles
    ctx.fillStyle = "rgba(255,247,234,0.55)";
    const span = Math.max(1, len - foamH - 2);
    for (let i = 0; i < 6; i++) {
      const bx = w * (0.32 + 0.12 * (i % 3));
      const by = foamH + 2 + mod(-now * 0.012 + i * 97, span);
      ctx.beginPath();
      ctx.arc(bx, by, 0.6 + (i % 2) * 0.5, 0, 7);
      ctx.fill();
    }
    // foam head at the rim
    ctx.fillStyle = COL.foam;
    ctx.fillRect(0, 0, w, foamH);
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.arc((i + 0.5) * w / 5, foamH - 0.2, 1.1 + (i % 2) * 0.5, 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = COL.foamSh;
    ctx.fillRect(0, foamH, w, 0.8);
    ctx.beginPath();
    ctx.arc(w * 0.36, foamH * 0.44, 0.9, 0, 7);
    ctx.arc(w * 0.62, foamH * 0.32, 0.7, 0, 7);
    ctx.fill();
    // outline
    ctx.strokeStyle = COL.beerEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, len - 1);
  }

  // The signature green soju bottle: neck + cap at the mouth, white label.
  function drinkSoju(len) {
    const w = OBST_W;
    const grad = () => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, COL.sojuEdge);
      g.addColorStop(0.16, COL.sojuSh);
      g.addColorStop(0.42, COL.sojuHi);
      g.addColorStop(0.5, COL.soju);
      g.addColorStop(0.74, COL.sojuSh);
      g.addColorStop(1, COL.sojuEdge);
      return g;
    };
    if (len < 24) {                       // too short for a bottle -> stub
      ctx.fillStyle = grad();
      ctx.fillRect(0, 0, w, len);
      ctx.strokeStyle = COL.sojuEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, len - 1);
      return;
    }
    const capH = 4, neckH = 7, shoulderH = 6, bodyTop = capH + neckH + shoulderH;
    const neckW = 7, neckX = (w - neckW) / 2;
    const green = grad();
    // body
    ctx.fillStyle = green;
    ctx.fillRect(0, bodyTop, w, len - bodyTop);
    // shoulders (neck -> full width)
    ctx.beginPath();
    ctx.moveTo(neckX, capH + neckH);
    ctx.lineTo(neckX + neckW, capH + neckH);
    ctx.lineTo(w, bodyTop + 0.5);
    ctx.lineTo(0, bodyTop + 0.5);
    ctx.closePath();
    ctx.fillStyle = green;
    ctx.fill();
    // neck
    ctx.fillStyle = green;
    ctx.fillRect(neckX, capH, neckW, neckH + 1);
    // metal cap
    const cg = ctx.createLinearGradient(neckX, 0, neckX + neckW, 0);
    cg.addColorStop(0, COL.capSh);
    cg.addColorStop(0.4, COL.capHi);
    cg.addColorStop(1, COL.capSh);
    ctx.fillStyle = cg;
    ctx.fillRect(neckX - 0.5, 0, neckW + 1, capH);
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(neckX - 0.5, capH - 0.8, neckW + 1, 0.8);
    // label
    const labY = bodyTop + (len - bodyTop) * 0.26;
    const labH = Math.min(17, (len - bodyTop) * 0.5);
    ctx.fillStyle = COL.label;
    ctx.fillRect(1.5, labY, w - 3, labH);
    ctx.fillStyle = COL.labelStripe;
    ctx.fillRect(1.5, labY, w - 3, 2.2);
    ctx.fillStyle = COL.labelAccent;
    ctx.beginPath();
    ctx.arc(w / 2, labY + labH * 0.4, 1.6, 0, 7);
    ctx.fill();
    ctx.fillStyle = COL.labelText;
    ctx.fillRect(4, labY + labH * 0.62, w - 8, 1);
    ctx.fillRect(6, labY + labH * 0.62 + 2.5, w - 12, 1);
    // gloss + outline
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(w * 0.28, bodyTop, 2.2, len - bodyTop);
    ctx.strokeStyle = COL.sojuEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, bodyTop, w - 1, len - bodyTop - 0.5);
    ctx.strokeRect(neckX - 0.5, 0.5, neckW + 1, capH + neckH);
  }

  // A stack of shot glasses filled with golden liquor.
  function drinkShot(len) {
    const w = OBST_W;
    const n = Math.max(1, Math.round(len / 15));
    const h = len / n;
    for (let i = 0; i < n; i++) shotGlass(i * h, w, h);
  }
  function shotGlass(y0, w, h) {
    ctx.save();
    ctx.translate(0, y0);
    // glass body
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, COL.glassEdge);
    g.addColorStop(0.2, COL.glassSh);
    g.addColorStop(0.44, COL.glassHi);
    g.addColorStop(0.56, COL.glass);
    g.addColorStop(0.8, COL.glassSh);
    g.addColorStop(1, COL.glassEdge);
    ctx.fillStyle = g;
    ctx.fillRect(1, 0, w - 2, h);
    // liquor
    const liqTop = h * 0.16, liqH = h * 0.5;
    const lg = ctx.createLinearGradient(0, 0, w, 0);
    lg.addColorStop(0, COL.liquorDark);
    lg.addColorStop(0.4, COL.liquorHi);
    lg.addColorStop(0.52, COL.liquor);
    lg.addColorStop(1, COL.liquorDark);
    ctx.fillStyle = lg;
    ctx.fillRect(2, liqTop, w - 4, liqH);
    ctx.fillStyle = COL.meniscus;
    ctx.fillRect(2, liqTop, w - 4, 1);              // bright surface line
    // thick base + rim + side reflection
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(2, h - 3, w - 4, 2);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillRect(2, 0.5, w - 4, 1);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(w * 0.28, 1, 1.4, h - 2);
    ctx.strokeStyle = COL.glassEdge;
    ctx.lineWidth = 0.8;
    ctx.strokeRect(1.4, 0.4, w - 2.8, h - 0.8);
    ctx.restore();
  }

  function drawGround() {
    const y = H - GROUND_H;
    const g = ctx.createLinearGradient(0, y, 0, H);
    g.addColorStop(0, COL.woodHi);
    g.addColorStop(0.14, COL.wood);
    g.addColorStop(1, COL.woodDark);
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W, GROUND_H);
    ctx.fillStyle = COL.woodTop;
    ctx.fillRect(0, y, W, 1.5);
    ctx.fillStyle = COL.outline;
    ctx.fillRect(0, y - 1, W, 1);
    // grain
    ctx.strokeStyle = "rgba(60,35,15,0.22)";
    ctx.lineWidth = 0.8;
    const tile = 16, off = mod(groundX, tile);
    for (let x = -tile; x < W + tile; x += tile) {
      ctx.beginPath();
      ctx.moveTo(x + off, y + 4);
      ctx.lineTo(x + off, H);
      ctx.stroke();
    }
  }

  // The player's photo as a smooth round portrait that tilts with velocity.
  function drawPlayer() {
    const cx = PLAYER_X, cy = hero.y, r = AVATAR_R;
    const tilt = Math.max(-0.5, Math.min(0.7, (hero.vy || 0) / 260));
    // soft shadow
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    ctx.beginPath();
    ctx.ellipse(cx, cy + r + 1.5, r * 0.8, 1.6, 0, 0, 7);
    ctx.fill();
    // photo, circular-clipped
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 7);
    ctx.clip();
    ctx.fillStyle = COL.foam;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    if (player.img) {
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      ctx.drawImage(player.img, -r, -r, r * 2, r * 2);
    } else {
      ctx.fillStyle = COL.beer;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.fillStyle = COL.outline;
      ctx.beginPath();
      ctx.arc(cx - r * 0.35, cy - r * 0.2, 1.1, 0, 7);
      ctx.arc(cx + r * 0.35, cy - r * 0.2, 1.1, 0, 7);
      ctx.fill();
      ctx.strokeStyle = COL.outline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy + r * 0.1, r * 0.5, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
    ctx.restore();
    // frame rings
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = COL.foam;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 7);
    ctx.stroke();
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = COL.outline;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 0.7, 0, 7);
    ctx.stroke();
  }

  function hudText(str, x, y, size, weight) {
    ctx.font = `${weight || 800} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = COL.hudSh;
    ctx.lineWidth = size * 0.24;
    ctx.strokeText(str, x, y);
    ctx.fillStyle = COL.hud;
    ctx.fillText(str, x, y);
  }
  function drawHud() {
    if (state !== "playing" && state !== "gameover") return;
    hudText(String(score), W / 2, 8, 22);
    if (player.name) {
      const nm = player.name.length > 14 ? player.name.slice(0, 14) : player.name;
      hudText(nm, W / 2, 33, 9, 700);
    }
  }

  function render() {
    ctx.setTransform(S, 0, 0, S, 0, 0);   // draw in world units, S px per unit
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
