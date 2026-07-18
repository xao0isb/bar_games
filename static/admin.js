/* Operator panel (open /admin on your phone). One switch:
   • OFF -> demo mode: 3 plays, then a leaderboard with the player at #12.
   • ON  -> single play: one round that ends on "Вы проиграли".
   Flipping it POSTs the new mode; the server then restarts every screen. */
(() => {
  "use strict";

  const toggle = document.getElementById("mode-toggle");
  const label = document.getElementById("mode-label");
  const status = document.getElementById("admin-status");

  const DESC = {
    demo: "Демо: 3 попытки, затем таблица лидеров — лучший результат игрока на 12-м месте, почти топ-10.",
    single: "Обычная игра: 1 попытка, без таблицы, в конце — «Вы проиграли».",
  };

  function paint(single) {
    toggle.checked = !!single;
    label.textContent = single ? DESC.single : DESC.demo;
  }

  function setStatus(text, ok) {
    status.textContent = text;
    status.classList.toggle("ok", !!ok);
  }

  async function load() {
    try {
      const d = await (await fetch("/api/mode")).json();
      paint(d.single);
      setStatus("Готово к работе", true);
    } catch (_) {
      setStatus("Нет связи с сервером", false);
    }
  }

  toggle.addEventListener("change", async () => {
    const single = toggle.checked;
    label.textContent = single ? DESC.single : DESC.demo;
    setStatus("Перезапуск игры…", false);
    try {
      const r = await fetch("/api/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ single }),
      });
      if (!r.ok) throw new Error("bad status");
      const d = await r.json();
      paint(d.single);
      setStatus(
        d.single
          ? "Обычный режим включён — игра перезапущена"
          : "Демо-режим включён — игра перезапущена",
        true,
      );
    } catch (_) {
      setStatus("Ошибка — попробуйте ещё раз", false);
    }
  });

  load();
})();
