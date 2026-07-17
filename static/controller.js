/* Controller — runs on the player's phone. One big button; each press sends a
   "flap" event to the host screen over a WebSocket. */
(() => {
  "use strict";

  const btn = document.getElementById("flap-btn");
  const statusEl = document.getElementById("status");
  const labelEl = document.getElementById("btn-label");
  const scoreEl = document.getElementById("score");

  let ws = null;
  let hostConnected = false;
  let gameState = "waiting";

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/ws/${SESSION_ID}/controller`;

  function connect() {
    setStatus("Подключение…", false);
    ws = new WebSocket(wsUrl);
    ws.onopen = () => setStatus("Подключено", true);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "state") {
        gameState = msg.state;
        if (typeof msg.score === "number") scoreEl.textContent = msg.score;
        updateLabel();
      } else if (msg.type === "host_status") {
        hostConnected = !!msg.connected;
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

  function flap() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "flap" }));
      if (navigator.vibrate) navigator.vibrate(15);
    }
    btn.classList.add("active");
    setTimeout(() => btn.classList.remove("active"), 90);
  }

  // Touch first (with preventDefault to avoid the 300ms delay / synthetic click),
  // mouse for desktop testing, space/up-arrow as a bonus.
  btn.addEventListener("touchstart", (e) => { e.preventDefault(); flap(); }, { passive: false });
  btn.addEventListener("mousedown", (e) => { e.preventDefault(); flap(); });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") { e.preventDefault(); flap(); }
  });
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  function updateLabel() {
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
    statusEl.classList.toggle("ok", ok);
  }

  updateLabel();
})();
