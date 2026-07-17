/* Controller — runs on the player's phone. First the player picks a name and a
   photo (the photo becomes their in-game character); then one big button sends
   "flap" events to the host screen over a WebSocket. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const setup = $("setup");
  const control = $("control");
  const photoInput = $("photo-input");
  const photoPreview = $("photo-preview");
  const nameInput = $("name-input");
  const startBtn = $("start-btn");
  const meAvatar = $("me-avatar");
  const meName = $("me-name");
  const statusEl = $("status");
  const labelEl = $("btn-label");
  const scoreEl = $("score");
  const btn = $("flap-btn");

  let ws = null;
  let hostConnected = false;
  let gameState = "waiting";
  let photoData = null;   // compressed data URL of the chosen photo
  let player = null;      // { name, photo } once the player has started
  let joined = false;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/ws/${SESSION_ID}/controller`;

  function connect() {
    setStatus("Подключение…", false);
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      setStatus("Подключено", true);
      if (joined) sendPlayer();   // re-announce after a reconnect
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "state") {
        gameState = m.state;
        if (typeof m.score === "number") scoreEl.textContent = m.score;
        updateLabel();
      } else if (m.type === "host_status") {
        hostConnected = !!m.connected;
        updateLabel();
      }
    };
    ws.onclose = () => {
      ws = null;
      setStatus("Переподключение…", false);
      setTimeout(connect, 1000);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  connect();

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function sendPlayer() {
    if (player) send({ type: "player", name: player.name, photo: player.photo });
  }

  // ------------------------------- photo -------------------------------- //
  photoInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setStatus("Обработка фото…", hostConnected);
    try {
      photoData = await compress(file, 256);
      photoPreview.style.backgroundImage = `url("${photoData}")`;
      photoPreview.classList.add("has-photo");
      startBtn.disabled = false;
      setStatus(hostConnected ? "Подключено" : "Подключение…", hostConnected);
    } catch (_) {
      setStatus("Не удалось загрузить фото — попробуйте другое", false);
    }
  });

  // Downscale + square-crop to keep the WebSocket message small (~20-40 KB).
  async function compress(file, size) {
    let src;
    try {
      src = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (_) {
      src = await loadImg(file);
    }
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const cx = c.getContext("2d");
    const iw = src.width, ih = src.height, s = Math.min(iw, ih);
    cx.drawImage(src, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, size, size);
    if (src.close) src.close();
    return c.toDataURL("image/jpeg", 0.82);
  }
  function loadImg(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }

  // ------------------------------- start -------------------------------- //
  startBtn.addEventListener("click", () => {
    if (!photoData) return;
    const name = (nameInput.value.trim() || "Игрок").slice(0, 20);
    player = { name, photo: photoData };
    joined = true;
    sendPlayer();
    meName.textContent = name;
    meAvatar.src = photoData;
    setup.hidden = true;
    control.hidden = false;
    updateLabel();
  });

  // ------------------------------- flap --------------------------------- //
  function flap() {
    if (!joined) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "flap" }));
      if (navigator.vibrate) navigator.vibrate(15);
    }
    btn.classList.add("active");
    setTimeout(() => btn.classList.remove("active"), 90);
  }
  btn.addEventListener("touchstart", (e) => { e.preventDefault(); flap(); }, { passive: false });
  btn.addEventListener("mousedown", (e) => { e.preventDefault(); flap(); });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") { e.preventDefault(); flap(); }
  });
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  function updateLabel() {
    if (!joined) return;
    if (!hostConnected) { labelEl.textContent = "Ждём экран"; return; }
    switch (gameState) {
      case "ready": labelEl.textContent = "СТАРТ"; break;
      case "playing": labelEl.textContent = "ПРЫЖОК"; break;
      case "gameover": labelEl.textContent = "ЗАНОВО"; break;
      default: labelEl.textContent = "ПРЫЖОК";
    }
  }

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.classList.toggle("ok", !!ok);
  }
})();
