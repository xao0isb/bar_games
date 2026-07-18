/* Flappy Beer — big-screen game, rendered crisp instead of pixelated. The world
   simulation runs in a small 144x192 space (so physics/tuning are unchanged), but
   the canvas backing store is sized to the display and the drawing context is
   scaled to match. That means the player's photo, the HUD text and the drink
   obstacles all come out smooth. The flying character is the player's own photo
   (sent from their phone).

   Two demo flows, switched from the operator page (/admin):
   • demo  (default): 3 plays, then a leaderboard where the player's best lands at
     #12, just below 11 bots scoring slightly higher — "so close to the top 10".
   • single: one play that ends on "Вы проиграли", no leaderboard. */
(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const qrPanel = document.getElementById("qr-panel");
  const overlay = document.getElementById("overlay");

  // World space (physics). Everything is drawn in these units; the context is
  // scaled so 1 world unit spans many device pixels -> crisp, never pixelated.
  const W = 144, H = 192;
  // The canvas backing store tracks the real display resolution (CSS box size ×
  // devicePixelRatio). syncSize() runs each frame and only reallocates when the
  // size actually changes, so it also self-corrects once layout settles.
  canvas.width = 432;
  canvas.height = 576;
  function syncSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cw = Math.round((canvas.clientWidth || 432) * dpr);
    const ch = Math.round((canvas.clientHeight || 576) * dpr);
    if (cw > 0 && ch > 0 && (cw !== canvas.width || ch !== canvas.height)) {
      canvas.width = cw;
      canvas.height = ch;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
  }

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
  const PLAYS_PER_RUN = 3;
  let state = "waiting";     // waiting | lobby | ready | playing | gameover | leaderboard | lost
  let score = 0;
  let best = Number(localStorage.getItem("flappybeer_best") || 0);
  let hero, drinks, groundX = 0;
  let now = 0;
  let player = { name: "", photo: null, img: null };
  let leaveTimer = null;
  let singlePlay = false;    // false = 3-play demo + leaderboard; true = 1 play + "you lost"
  let plays = 0;             // plays finished in the current run
  let bestOfRun = 0;         // best score across the current run
  let hasController = false; // is a phone connected right now?
  let leaderboard = null;    // rows, built when we enter the "leaderboard" state
  const RESTART_LOCK_MS = 3000;  // after a crash, ignore "play again" taps this long
  let restartAt = 0;         // loop-clock time when the restart tap is allowed again

  function reset() {
    hero = { y: H / 2, vy: 0 };
    drinks = [];
    score = 0;
  }
  // A "run" is one demo session (up to PLAYS_PER_RUN plays).
  function startRun() {
    plays = 0;
    bestOfRun = 0;
    leaderboard = null;
    reset();
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
  function sendState() {
    const terminal = state === "gameover" || state === "lost" || state === "leaderboard";
    const lock = terminal ? Math.max(0, Math.round(restartAt - now)) : 0;
    send({
      type: "state", state, score, best, name: player.name,
      single: singlePlay, plays, total: PLAYS_PER_RUN, lock,
    });
  }

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
        if (state === "waiting" || state === "lobby") { startRun(); setState("ready"); }
        else { updateOverlay(); sendState(); }
        break;
      case "controller_joined":
        clearTimeout(leaveTimer);
        hasController = true;
        if (state === "waiting") setState("lobby");
        else sendState();
        break;
      case "controller_left":
        clearTimeout(leaveTimer);
        hasController = false;
        leaveTimer = setTimeout(() => {
          player = { name: "", photo: null, img: null };
          startRun();
          setState("waiting");
        }, 3000);
        break;
      case "mode":                       // operator's /admin page switched the mode
        singlePlay = !!msg.single;
        break;
      case "reset":                      // operator restarted the game
        clearTimeout(leaveTimer);
        startRun();
        if (player.name || player.photo) setState("ready");
        else if (hasController) setState("lobby");
        else setState("waiting");
        break;
    }
  }

  // ---------------------------- game control ---------------------------- //
  function setState(s) {
    state = s;
    qrPanel.style.display = s === "waiting" ? "flex" : "none";
    updateOverlay();
    sendState();
  }

  // Begin a play (from ready/gameover/lost) with the opening flap.
  function startPlaying() {
    reset();
    state = "playing";
    hero.vy = FLAP_V;
    qrPanel.style.display = "none";
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
    } else if (state === "gameover" || state === "lost" || state === "leaderboard") {
      if (now < restartAt) return;         // restart stays locked for a moment after the crash
      if (state === "leaderboard") { startRun(); setState("ready"); }  // demo finished -> new run
      else startPlaying();                 // gameover -> next demo play; lost -> retry
    }
  }

  // Called when a play ends (the avatar crashed).
  function endPlay() {
    plays += 1;
    bestOfRun = Math.max(bestOfRun, score);
    restartAt = now + RESTART_LOCK_MS;     // lock the "play again" tap for a few seconds
    if (singlePlay) {
      setState("lost");
    } else if (plays >= PLAYS_PER_RUN) {
      leaderboard = buildLeaderboard(bestOfRun);
      setState("leaderboard");
    } else {
      setState("gameover");
    }
  }

  // ---- fake leaderboard (demo): the player lands at #12, just shy of the top 10 ----
  const LB_NAMES = [
    "Максим", "Софи", "Дмитрий", "Алина", "Иван", "Настя", "Олег", "Юля",
    "Минхо", "Джису", "Хёну", "Лена", "Артём", "Вика", "Пабло", "Даша",
    "Рома", "Соня", "Женя", "Тимур", "Марк", "Катя",
  ];
  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function buildLeaderboard(playerScore) {
    const names = shuffled(LB_NAMES).slice(0, 11);
    let s = playerScore + 1 + Math.floor(Math.random() * 2);
    const scores = [];
    for (let i = 0; i < 11; i++) {         // 11 bots, tightly clustered just above
      scores.push(s);
      s += 1 + Math.floor(Math.random() * 2);
    }
    scores.reverse();                       // #1 highest ... #11 just above the player
    const rows = names.map((name, i) => ({ rank: i + 1, name, score: scores[i], me: false }));
    rows.push({ rank: 12, name: player.name || "Вы", score: playerScore, me: true });
    return rows;
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
        endPlay();
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

  // A frosty mug of amber beer: cylindrical glass, a foamy head at the rim,
  // rising bubbles and a chunky handle — reads as "beer" even when stretched tall.
  function drinkBeer(len) {
    const w = OBST_W;
    const foamH = Math.max(7, Math.min(13, len * 0.24));
    // cylindrical amber body
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, COL.beerEdge);
    g.addColorStop(0.14, COL.beerSh);
    g.addColorStop(0.4, COL.beerHi);
    g.addColorStop(0.5, COL.beer);
    g.addColorStop(0.72, COL.beerSh);
    g.addColorStop(1, COL.beerEdge);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, len);
    // glossy vertical streak
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(w * 0.26, foamH, 2.4, len - foamH);
    // rising bubbles
    ctx.fillStyle = "rgba(255,247,234,0.55)";
    const span = Math.max(1, len - foamH - 2);
    for (let i = 0; i < 7; i++) {
      const bx = w * (0.28 + 0.14 * (i % 3));
      const by = foamH + 2 + mod(-now * 0.013 + i * 91, span);
      ctx.beginPath();
      ctx.arc(bx, by, 0.6 + (i % 2) * 0.6, 0, 7);
      ctx.fill();
    }
    // chunky glass handle on the side, near the rim
    if (len > 26) {
      const hy = foamH + 8, hr = 6;
      ctx.lineCap = "round";
      ctx.strokeStyle = COL.beerEdge;
      ctx.lineWidth = 4.6;
      ctx.beginPath();
      ctx.arc(w - 2, hy, hr, -1.3, 1.3);
      ctx.stroke();
      ctx.strokeStyle = COL.beerHi;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w - 2, hy, hr, -1.3, 1.3);
      ctx.stroke();
      ctx.lineCap = "butt";
    }
    // foamy head overflowing the rim in rounded lumps, with a couple of drips
    ctx.fillStyle = COL.foam;
    ctx.fillRect(0, 0, w, foamH);
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.arc((i + 0.5) * w / 5, foamH - 0.3, 1.5 + (i % 2) * 0.7, 0, 7);
      ctx.fill();
    }
    ctx.fillRect(w * 0.22, foamH, 1.6, 3.4);
    ctx.fillRect(w * 0.66, foamH, 1.4, 2.2);
    ctx.fillStyle = COL.foamSh;
    ctx.fillRect(0, foamH, w, 0.9);
    ctx.beginPath();
    ctx.arc(w * 0.36, foamH * 0.5, 1.0, 0, 7);
    ctx.arc(w * 0.64, foamH * 0.36, 0.8, 0, 7);
    ctx.fill();
    // outline
    ctx.strokeStyle = COL.beerEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, len - 1);
  }

  // The signature green soju bottle: slim neck, green cap, white paper label.
  function drinkSoju(len) {
    const w = OBST_W;
    const grad = () => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, COL.sojuEdge);
      g.addColorStop(0.15, COL.sojuSh);
      g.addColorStop(0.42, COL.sojuHi);
      g.addColorStop(0.5, COL.soju);
      g.addColorStop(0.74, COL.sojuSh);
      g.addColorStop(1, COL.sojuEdge);
      return g;
    };
    if (len < 24) {                        // too short for a bottle -> plain stub
      ctx.fillStyle = grad();
      ctx.fillRect(0, 0, w, len);
      ctx.strokeStyle = COL.sojuEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, len - 1);
      return;
    }
    const capH = 5, neckH = 8, shoulderH = 7, bodyTop = capH + neckH + shoulderH;
    const neckW = 8, neckX = (w - neckW) / 2;
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
    ctx.fillRect(neckX, capH, neckW, neckH + 1);
    // green screw cap with ridges
    const cg = ctx.createLinearGradient(neckX, 0, neckX + neckW, 0);
    cg.addColorStop(0, COL.sojuEdge);
    cg.addColorStop(0.4, COL.sojuHi);
    cg.addColorStop(1, COL.sojuSh);
    ctx.fillStyle = cg;
    ctx.fillRect(neckX - 0.5, 0, neckW + 1, capH);
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    ctx.fillRect(neckX - 0.5, capH - 1, neckW + 1, 1);
    ctx.fillRect(neckX + 1.5, 1, 0.7, capH - 2);
    ctx.fillRect(neckX + neckW - 2.2, 1, 0.7, capH - 2);
    // white paper label: header stripe, red logo dot, text lines
    const labY = bodyTop + (len - bodyTop) * 0.24;
    const labH = Math.min(20, (len - bodyTop) * 0.52);
    ctx.fillStyle = COL.label;
    ctx.fillRect(1.5, labY, w - 3, labH);
    if (labH > 6) {
      ctx.fillStyle = COL.labelStripe;
      ctx.fillRect(1.5, labY, w - 3, 2.4);
      ctx.fillStyle = COL.labelAccent;
      ctx.beginPath();
      ctx.arc(w / 2, labY + labH * 0.4, 1.8, 0, 7);
      ctx.fill();
      ctx.fillStyle = COL.labelText;
      ctx.fillRect(4.5, labY + labH * 0.68, w - 9, 1);
      if (labH > 12) ctx.fillRect(6.5, labY + labH * 0.68 + 2.6, w - 13, 1);
    }
    // gloss + outline
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(w * 0.26, bodyTop, 2.4, len - bodyTop);
    ctx.strokeStyle = COL.sojuEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, bodyTop, w - 1, len - bodyTop - 0.5);
    ctx.strokeRect(neckX - 0.5, 0.5, neckW + 1, capH + neckH);
  }

  // A stack of thick shot glasses filled with golden liquor.
  function drinkShot(len) {
    const w = OBST_W;
    const n = Math.max(1, Math.round(len / 18));
    const h = len / n;
    for (let i = 0; i < n; i++) shotGlass(i * h, w, h);
  }
  function shotGlass(y0, w, h) {
    ctx.save();
    ctx.translate(0, y0);
    const inset = 1.5;
    const bw = w - inset * 2;
    // glass body with bright vertical reflections
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, COL.glassEdge);
    g.addColorStop(0.18, COL.glassSh);
    g.addColorStop(0.42, COL.glassHi);
    g.addColorStop(0.58, COL.glass);
    g.addColorStop(0.82, COL.glassSh);
    g.addColorStop(1, COL.glassEdge);
    ctx.fillStyle = g;
    ctx.fillRect(inset, 0.5, bw, h - 1);
    // golden liquor (headroom under the rim)
    const liqTop = h * 0.22, liqH = h * 0.5;
    const lg = ctx.createLinearGradient(0, 0, w, 0);
    lg.addColorStop(0, COL.liquorDark);
    lg.addColorStop(0.4, COL.liquorHi);
    lg.addColorStop(0.52, COL.liquor);
    lg.addColorStop(1, COL.liquorDark);
    ctx.fillStyle = lg;
    ctx.fillRect(inset + 1, liqTop, bw - 2, liqH);
    // bright meniscus at the surface
    ctx.fillStyle = COL.meniscus;
    ctx.fillRect(inset + 1, liqTop, bw - 2, 1);
    // thick base
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(inset + 1, h - 3.5, bw - 2, 2.4);
    // rim highlight
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillRect(inset + 1, 1, bw - 2, 1.1);
    // vertical reflection streak
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillRect(w * 0.3, 2, 1.4, h - 4);
    // outline
    ctx.strokeStyle = COL.glassEdge;
    ctx.lineWidth = 0.9;
    ctx.strokeRect(inset + 0.5, 0.5, bw - 1, h - 1);
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
    syncSize();
    // scale the 144×192 world onto the full-resolution backing store
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
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
      const badge = singlePlay
        ? ""
        : '<p class="who">Игра ' + (plays + 1) + " из " + PLAYS_PER_RUN + "</p>";
      overlay.innerHTML =
        '<div class="overlay-card">' + avatarHtml() + badge +
        "<h1>" + (esc(player.name) || "Готовы") + ", вперёд!</h1>" +
        "<p>Нажмите кнопку на телефоне,<br>чтобы взлететь</p></div>";
    } else if (state === "gameover") {           // between the 3 demo plays
      overlay.style.display = "flex";
      overlay.innerHTML =
        '<div class="overlay-card">' + avatarHtml() +
        '<p class="who">Игра ' + plays + " из " + PLAYS_PER_RUN + " сыграна</p>" +
        '<p class="score">' + score + "</p>" +
        "<p>Лучшее за подход: " + bestOfRun + "</p>" +
        '<p class="hint">Нажмите кнопку на телефоне,<br>чтобы сыграть ещё раз</p></div>';
    } else if (state === "lost") {               // single-play mode
      overlay.style.display = "flex";
      overlay.innerHTML =
        '<div class="overlay-card lost">' + avatarHtml() +
        "<h1>Вы проиграли</h1>" +
        (player.name ? '<p class="who">' + esc(player.name) + "</p>" : "") +
        '<p class="score">' + score + "</p>" +
        '<p class="hint">Нажмите кнопку на телефоне,<br>чтобы попробовать снова</p></div>';
    } else if (state === "leaderboard") {        // after the 3rd demo play
      overlay.style.display = "flex";
      overlay.innerHTML = leaderboardHtml();
    } else {
      overlay.style.display = "none";
    }
  }

  function leaderboardHtml() {
    const rows = (leaderboard || []).map((r) =>
      '<div class="lb-row' + (r.me ? " me" : "") + '">' +
      '<span class="rk">' + r.rank + "</span>" +
      '<span class="nm">' + esc(String(r.name).slice(0, 14)) + (r.me ? " (вы)" : "") + "</span>" +
      '<span class="sc">' + r.score + "</span></div>"
    ).join("");
    return (
      '<div class="overlay-card leaderboard">' +
      "<h1>Таблица лидеров</h1>" +
      '<p class="lb-sub">Ваш результат: <b>' + bestOfRun + "</b> — вы почти в топ-10!</p>" +
      '<div class="lb">' + rows + "</div>" +
      '<p class="hint">Нажмите кнопку на телефоне, чтобы сыграть заново</p></div>'
    );
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
