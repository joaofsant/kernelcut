// docs/player.js
(async function () {
  const h = (sel) => document.querySelector(sel);

  const resp = await fetch("playlist.json");
  const list = await resp.json();
  if (!Array.isArray(list) || !list.length) return;

  let idx = 0;
  const audio = new Audio();
  const label = document.createElement("div");
  label.style.margin = "8px 0 0";
  label.style.color = "var(--muted, #6b7280)";
  const toolbar = document.createElement("div");
  toolbar.className = "card";
  toolbar.style.display = "flex";
  toolbar.style.gap = "8px";
  toolbar.style.alignItems = "center";

  function setLabel() {
    label.textContent = `(${idx + 1}/${list.length}) ${list[idx].title}`;
  }

  function playIdx(i) {
    idx = (i + list.length) % list.length;
    audio.src = list[idx].src;
    setLabel();
    audio.play().catch(() => {});
  }

  const btnPrev = Object.assign(document.createElement("button"), { className: "chip", textContent: "⏮ Prev" });
  const btnPlay = Object.assign(document.createElement("button"), { className: "chip", textContent: "▶ Play" });
  const btnNext = Object.assign(document.createElement("button"), { className: "chip", textContent: "⏭ Next" });

  btnPrev.onclick = () => playIdx(idx - 1);
  btnPlay.onclick = () => (audio.paused ? audio.play() : audio.pause());
  btnNext.onclick = () => playIdx(idx + 1);
  audio.onended = () => playIdx(idx + 1);

  toolbar.append(btnPrev, btnPlay, btnNext);
  toolbar.append(label);

  const page = document.querySelector(".page") || document.body;
  page.insertBefore(toolbar, page.children[2] || null);

  // botões "Listen" por item
  document.querySelectorAll("[data-play-idx]").forEach((b) => {
    b.addEventListener("click", () => playIdx(parseInt(b.dataset.playIdx, 10) - 1));
  });

  setLabel();
})();