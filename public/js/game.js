/**
 * game.js — KANLI AY (2D Top-Down Asymmetric Survival Horror Engine)
 * Features:
 * - 60+ FPS Canvas 2D engine with offscreen cached ground & raycasted 2D Fog of War
 * - Werewolf Red Stain + Dynamic Terror Radius Heartbeat
 * - DBD Mechanics: 5/7 Totem Repairs + Rotary Skill Checks, Pallets (Stun/Vault/Smash),
 *   Lockers, Carry/Wiggle/Sacrifice Cages, Blood Scratch Marks, Silver Lantern Flash
 * - Full AI Bot state machines for both Villagers and Werewolf
 * - Ultra-low latency RFC 6455 WebSocket multiplayer + seamless solo fallback
 * - Live Drag-and-Drop Custom AI Sprite Loader with client-side chroma key
 */

(() => {
  "use strict";

  // ===================== CONSTANTS =====================
  const WORLD_W = 2400;
  const WORLD_H = 1800;
  const TOTEMS_REQUIRED = 5;
  const TOTAL_TOTEMS = 7;
  const TOTAL_CAGES = 6;

  const WOLF_SPEED = 178;
  const WOLF_HOWL_SPEED = 212;
  const WOLF_CARRY_SPEED = 136;
  const WOLF_WIPE_SPEED = 62;
  const VILLAGER_WALK = 102;
  const VILLAGER_SPRINT = 158;
  const VILLAGER_CRAWL = 42;
  const VILLAGER_HIT_BURST = 230;
  const CARRY_ESCAPE_DURATION = 14.0; // Fixed 14s carry timer before auto escape

  const TERROR_RADIUS = 560;
  const SIGHT_WOLF = 690;
  const SIGHT_VILLAGER = 560;

  // ===================== DOM REFERENCES =====================
  const webglCanvas = document.getElementById("webgl-canvas");
  const canvas = document.getElementById("game-canvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  const renderer3d = window.GothicRenderer3D && webglCanvas ? new window.GothicRenderer3D(webglCanvas) : null;
  const minimapCanvas = document.getElementById("minimap-canvas");
  const mctx = minimapCanvas.getContext("2d");
  const scCanvas = document.getElementById("skill-check-canvas");
  const scCtx = scCanvas.getContext("2d");

  const lobbyScreen = document.getElementById("lobby-screen");
  const gameHud = document.getElementById("game-hud");
  const gameoverScreen = document.getElementById("gameover-screen");
  const aiModal = document.getElementById("ai-modal");

  const netPill = document.getElementById("net-pill");
  const netStatusText = document.getElementById("net-status-text");
  const perfPill = document.getElementById("perf-pill");
  const terrorVignette = document.getElementById("terror-vignette");
  const damageFlash = document.getElementById("damage-flash");

  const playerNameInput = document.getElementById("player-name");
  const roomCodeInput = document.getElementById("room-code");
  const roomModeSelect = document.getElementById("room-mode");
  const botDifficultySelect = document.getElementById("bot-difficulty");
  const lobbyPlayersEl = document.getElementById("lobby-players");
  const activeRoomsListEl = document.getElementById("active-rooms-list");
  const btnCreateRoom = document.getElementById("btn-create-room");
  const btnJoinRoom = document.getElementById("btn-join-room");
  const btnCopyInvite = document.getElementById("btn-copy-invite");
  const btnStartMatch = document.getElementById("btn-start-match");
  const guestWaitNote = document.getElementById("guest-wait-note");

  const objTitleEl = document.getElementById("obj-title");
  const objSubEl = document.getElementById("obj-sub");
  const hudSurvivorsEl = document.getElementById("hud-survivors");
  const hudToastWrap = document.getElementById("hud-toast-wrap");
  const actionPromptEl = document.getElementById("action-prompt");
  const channelWrapEl = document.getElementById("channel-wrap");
  const channelNameEl = document.getElementById("channel-name");
  const channelPctEl = document.getElementById("channel-pct");
  const channelFillEl = document.getElementById("channel-fill");
  const skillCheckOverlay = document.getElementById("skill-check-overlay");
  const perkRowEl = document.getElementById("perk-row");

  // ===================== AUDIO & ASSETS =====================
  const audio = new window.HorrorAudio();

  const DEFAULT_SPRITE_URLS = {
    werewolf: "/assets/sprites/werewolf.png",
    villager: "/assets/sprites/villager.png",
    totem: "/assets/sprites/totem.png",
    cage: "/assets/sprites/cage.png",
    ground: "/assets/sprites/ground_tile.png",
  };

  const sprites = {
    werewolf: null,
    villager: null,
    totem: null,
    cage: null,
    ground: null,
  };

  let groundPattern = null;
  let staticMapCanvas = null; // Cached floor + walls + decorative ground

  // Offscreen fog canvas for raycast visibility mask
  const fogCanvas = document.createElement("canvas");
  const fogCtx = fogCanvas.getContext("2d");

  function loadSprite(key, src, persist = false) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        sprites[key] = img;
        if (key === "ground") {
          groundPattern = ctx.createPattern(img, "repeat");
          if (world) rebuildStaticMapCache();
          if (renderer3d) renderer3d.updateGroundTexture(src);
        }
        const modalImg = document.getElementById(`modal-img-${key}`);
        if (modalImg) modalImg.src = src;
        if (key === "werewolf") {
          const p = document.getElementById("preview-role-wolf");
          if (p) p.src = src;
        }
        if (key === "villager") {
          const p = document.getElementById("preview-role-villager");
          if (p) p.src = src;
        }
        if (persist) {
          try { localStorage.setItem(`kanliay_sprite_${key}`, src); } catch (_) {}
        }
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function initSprites() {
    const keys = Object.keys(DEFAULT_SPRITE_URLS);
    await Promise.all(
      keys.map((k) => {
        let saved = null;
        try { saved = localStorage.getItem(`kanliay_sprite_${k}`); } catch (_) {}
        return loadSprite(k, saved || DEFAULT_SPRITE_URLS[k], false);
      })
    );
  }

  // ===================== PRNG & MATH HELPERS =====================
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const dist2 = (x1, y1, x2, y2) => (x1 - x2) ** 2 + (y1 - y2) ** 2;
  const dist = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);
  const angleTo = (x1, y1, x2, y2) => Math.atan2(y2 - y1, x2 - x1);
  function lerpAngle(a, b, t) {
    let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  // ===================== NETWORK & LOBBY STATE =====================
  let ws = null;
  let wsConnected = false;
  let myId = "local_p1";
  let hostId = "local_p1";
  let roomCode = new URLSearchParams(location.search).get("room") || "KANLI-AY";
  if (roomCodeInput) roomCodeInput.value = roomCode;
  let roomFillBots = true;
  let activeRooms = [];
  let selectedPrefRole = "villager";
  let lobbyPlayers = [{ id: "local_p1", name: "Avcı", role: "villager", ping: 1 }];
  let rttMs = 0;
  let lastPingSent = 0;
  let isAdmin = false;

  function isHost() {
    return !wsConnected || myId === hostId;
  }

  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      setOfflineMode();
      return;
    }

    ws.onopen = () => {
      wsConnected = true;
      netPill.classList.remove("offline");
      netPill.classList.add("online");
      sendWS({
        t: "join",
        room: roomCodeInput.value || roomCode || "KANLI-AY",
        name: playerNameInput.value || "Avcı",
        role: selectedPrefRole,
      });
      sendWS({ t: "list_rooms" });
      pingServer();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      handleWSMessage(msg);
    };

    ws.onclose = () => {
      wsConnected = false;
      setOfflineMode();
      setTimeout(connectWebSocket, 2500);
    };

    ws.onerror = () => {
      wsConnected = false;
      setOfflineMode();
    };
  }

  function setOfflineMode() {
    netPill.classList.remove("online");
    netPill.classList.add("offline");
    netStatusText.textContent = "Yerel Mod (Botlara Karşı)";
    renderLobbyRoster();
  }

  function sendWS(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function pingServer() {
    if (!wsConnected) return;
    lastPingSent = performance.now();
    sendWS({ t: "p", ts: lastPingSent, rtt: rttMs || 1 });
  }
  setInterval(pingServer, 1500);

  function handleWSMessage(msg) {
    switch (msg.t) {
      case "po": {
        rttMs = Math.max(1, Math.round(performance.now() - msg.ts));
        netStatusText.textContent = `Sunucu Bağlı (${rttMs} ms)`;
        break;
      }
      case "welcome": {
        myId = msg.id;
        hostId = msg.hostId;
        roomCode = msg.room;
        if (roomCodeInput) roomCodeInput.value = roomCode;
        roomFillBots = msg.fillBots !== false;
        if (roomModeSelect) roomModeSelect.value = roomFillBots ? "bots" : "humans";
        if (botDifficultySelect && msg.difficulty) botDifficultySelect.value = msg.difficulty;
        lobbyPlayers = msg.players || [];
        if (typeof msg.isAdmin === "boolean") setAdminState(msg.isAdmin);
        if (msg.customSprites) {
          Object.entries(msg.customSprites).forEach(([k, url]) => loadSprite(k, url, false));
        }
        renderLobbyRoster();
        break;
      }
      case "rooms": {
        activeRooms = msg.list || [];
        renderActiveRooms();
        break;
      }
      case "admin_ok": {
        setAdminState(!!msg.ok);
        if (msg.ok) showToast("🔓 Admin yetkisi açıldı!", "good");
        else showToast("❌ Hatalı Admin şifresi!", "danger");
        break;
      }
      case "sprite_sync": {
        if (msg.sprites) {
          Object.entries(msg.sprites).forEach(([k, url]) => loadSprite(k, url, false));
          showToast("🎨 Admin oyun görsellerini güncelledi!", "normal");
        }
        break;
      }
      case "sprite_reset": {
        Object.entries(DEFAULT_SPRITE_URLS).forEach(([k, url]) => {
          try { localStorage.removeItem(`kanliay_sprite_${k}`); } catch (_) {}
          loadSprite(k, url, false);
        });
        showToast("🎨 Admin görselleri varsayılana döndürdü.", "normal");
        break;
      }
      case "lobby": {
        hostId = msg.hostId;
        roomCode = msg.room;
        if (roomCodeInput) roomCodeInput.value = roomCode;
        if (typeof msg.fillBots === "boolean") {
          roomFillBots = msg.fillBots;
          if (roomModeSelect) roomModeSelect.value = roomFillBots ? "bots" : "humans";
        }
        if (msg.difficulty && botDifficultySelect) botDifficultySelect.value = msg.difficulty;
        lobbyPlayers = msg.players || [];
        renderLobbyRoster();
        break;
      }
      case "host_changed": {
        hostId = msg.hostId;
        renderLobbyRoster();
        break;
      }
      case "started": {
        startMatchFromAssignments(
          msg.seed,
          msg.assignments,
          msg.difficulty || "normal",
          msg.fillBots !== false
        );
        break;
      }
      case "s": {
        if (!isHost() && world) {
          applyNetworkSnapshot(msg);
        }
        break;
      }
      case "i": {
        if (isHost() && world && msg.from) {
          applyGuestInput(msg.from, msg);
        }
        break;
      }
      case "e": {
        handleNetworkEvent(msg);
        break;
      }
    }
  }

  function renderActiveRooms() {
    if (!activeRoomsListEl) return;
    if (!wsConnected || activeRooms.length === 0) {
      activeRoomsListEl.innerHTML = `<div class="room-browser-empty">${
        wsConnected ? "Henüz açık oda yok — hemen yeni oda oluştur!" : "Sunucuya bağlanıldığında aktif odalar burada görünür."
      }</div>`;
      return;
    }
    activeRoomsListEl.innerHTML = activeRooms
      .map((r) => {
        const isCurrent = r.id === roomCode;
        const modeTag = r.fillBots ? "🤖 Botlu" : "👥 Botsuz";
        const stateTag = r.inGame ? " • Oyunda" : "";
        return `
          <div class="room-browser-item">
            <span><strong>${escapeHtml(r.title)}</strong> <code>[${escapeHtml(r.id)}]</code> &bull; ${r.count}/${r.max} &bull; ${modeTag}${stateTag}</span>
            <button class="btn btn-outline btn-sm join-listed-room" data-room="${escapeHtml(r.id)}" type="button" ${
          isCurrent ? "disabled" : ""
        }>${isCurrent ? "Odadasın" : "Katıl"}</button>
          </div>
        `;
      })
      .join("");
    activeRoomsListEl.querySelectorAll(".join-listed-room").forEach((btn) => {
      btn.addEventListener("click", () => {
        const code = btn.dataset.room;
        if (!code) return;
        roomCodeInput.value = code;
        sendWS({
          t: "join",
          room: code,
          name: playerNameInput.value || "Avcı",
          role: selectedPrefRole,
        });
      });
    });
  }

  function renderLobbyRoster() {
    const list = wsConnected
      ? lobbyPlayers
      : [{ id: myId, name: playerNameInput.value || "Avcı", role: selectedPrefRole, ping: 1 }];

    const hasHumanWolf = list.some((p) => p.role === "werewolf");
    const totalSlots = 5;
    const html = [];

    list.forEach((p) => {
      const roleClass =
        p.role === "werewolf" ? "badge-wolf" : p.role === "random" ? "badge-random" : "badge-villager";
      const roleText =
        p.role === "werewolf" ? "🐺 Kurt" : p.role === "random" ? "🎲 Rastgele" : "🏮 Köylü";
      const hostTag = p.id === hostId || !wsConnected ? `<span class="badge badge-host">Kurucu</span>` : "";
      const meTag = p.id === myId || !wsConnected ? " (Sen)" : "";
      const pingTag = wsConnected ? ` <span style="color:#94a3b8;font-size:0.74rem;">${p.ping || 1}ms</span>` : "";
      html.push(`
        <div class="roster-item">
          <span><strong>${escapeHtml(p.name)}</strong>${meTag}${hostTag}${pingTag}</span>
          <span class="badge ${roleClass}">${roleText}</span>
        </div>
      `);
    });

    if (roomFillBots) {
      const botsNeeded = Math.max(0, totalSlots - list.length);
      let botWolfNeeded = !hasHumanWolf && list.every((p) => p.role !== "random");
      for (let i = 0; i < botsNeeded; i++) {
        const isWolfBot = botWolfNeeded && i === 0;
        html.push(`
          <div class="roster-item bot">
            <span>🤖 ${isWolfBot ? "Karanlık Kurt (AI Bot)" : `Köylü Bot #${i + 1}`}</span>
            <span class="badge ${isWolfBot ? "badge-wolf" : "badge-villager"}">${
          isWolfBot ? "🐺 Kurt AI" : "🏮 Köylü AI"
        }</span>
          </div>
        `);
      }
    } else if (list.length < 2) {
      html.push(`
        <div class="roster-item bot">
          <span>👥 Kendi Aranızda Modu — Başlamak için en az 1 arkadaşını odaya davet et.</span>
        </div>
      `);
    }

    lobbyPlayersEl.innerHTML = html.join("");

    const amHost = !wsConnected || myId === hostId;
    if (roomModeSelect) roomModeSelect.disabled = !amHost || !wsConnected;
    if (botDifficultySelect) botDifficultySelect.disabled = !amHost;
    const tooFewHumans = wsConnected && !roomFillBots && list.length < 2;
    btnStartMatch.disabled = !amHost || tooFewHumans;
    guestWaitNote.classList.toggle("hidden", amHost);
    renderActiveRooms();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ===================== WORLD & MAP GENERATION =====================
  let world = null;
  let running = false;
  let lastFrameTime = 0;
  let fpsCounter = 60;
  let lastSnapshotSent = 0;
  let lastInputSent = 0;

  const keys = {};
  const mouse = { x: 0, y: 0, worldX: 0, worldY: 0, down: false };
  const guestInputs = {}; // host stores latest input per guestId

  function createWorld(seed, assignments, difficulty, fillBots = true) {
    const rng = mulberry32(seed);

    const walls = [];
    const trees = [];
    const totems = [];
    const cages = [];
    const pallets = [];
    const lockers = [];
    const gates = [];

    // Perimeter stone walls with North and South Exit Gate openings (center x=1120..1280)
    const wallThick = 42;
    // Top walls (leave 1120..1280 for North Gate)
    walls.push({ x: 0, y: 0, w: 1120, h: wallThick, kind: "stone" });
    walls.push({ x: 1280, y: 0, w: WORLD_W - 1280, h: wallThick, kind: "stone" });
    // Bottom walls (leave 1120..1280 for South Gate)
    walls.push({ x: 0, y: WORLD_H - wallThick, w: 1120, h: wallThick, kind: "stone" });
    walls.push({ x: 1280, y: WORLD_H - wallThick, w: WORLD_W - 1280, h: wallThick, kind: "stone" });
    // Left & Right walls
    walls.push({ x: 0, y: wallThick, w: wallThick, h: WORLD_H - wallThick * 2, kind: "stone" });
    walls.push({ x: WORLD_W - wallThick, y: wallThick, w: wallThick, h: WORLD_H - wallThick * 2, kind: "stone" });

    // 2 Exit Gates
    gates.push({
      id: "g_north",
      name: "Kuzey Çıkış Kapısı",
      x: 1120,
      y: 0,
      w: 160,
      h: 48,
      switchX: 1090,
      switchY: 74,
      progress: 0,
      open: false,
      exitY: 22,
    });
    gates.push({
      id: "g_south",
      name: "Güney Çıkış Kapısı",
      x: 1120,
      y: WORLD_H - 48,
      w: 160,
      h: 48,
      switchX: 1310,
      switchY: WORLD_H - 74,
      progress: 0,
      open: false,
      exitY: WORLD_H - 22,
    });

    // Helper: Build gothic cabin with 2 open doorways for DBD looping
    function addCabin(cx, cy, w, h, doorSideA, doorSideB) {
      const t = 24;
      const dw = 84;
      // Top wall
      if (doorSideA === "top" || doorSideB === "top") {
        const seg = (w - dw) / 2;
        walls.push({ x: cx - w / 2, y: cy - h / 2, w: seg, h: t, kind: "wood" });
        walls.push({ x: cx + dw / 2, y: cy - h / 2, w: seg, h: t, kind: "wood" });
      } else {
        walls.push({ x: cx - w / 2, y: cy - h / 2, w: w, h: t, kind: "wood" });
      }
      // Bottom wall
      if (doorSideA === "bottom" || doorSideB === "bottom") {
        const seg = (w - dw) / 2;
        walls.push({ x: cx - w / 2, y: cy + h / 2 - t, w: seg, h: t, kind: "wood" });
        walls.push({ x: cx + dw / 2, y: cy + h / 2 - t, w: seg, h: t, kind: "wood" });
      } else {
        walls.push({ x: cx - w / 2, y: cy + h / 2 - t, w: w, h: t, kind: "wood" });
      }
      // Left wall
      if (doorSideA === "left" || doorSideB === "left") {
        const seg = (h - dw) / 2;
        walls.push({ x: cx - w / 2, y: cy - h / 2 + t, w: t, h: seg - t, kind: "wood" });
        walls.push({ x: cx - w / 2, y: cy + dw / 2, w: t, h: seg - t, kind: "wood" });
      } else {
        walls.push({ x: cx - w / 2, y: cy - h / 2 + t, w: t, h: h - t * 2, kind: "wood" });
      }
      // Right wall
      if (doorSideA === "right" || doorSideB === "right") {
        const seg = (h - dw) / 2;
        walls.push({ x: cx + w / 2 - t, y: cy - h / 2 + t, w: t, h: seg - t, kind: "wood" });
        walls.push({ x: cx + w / 2 - t, y: cy + dw / 2, w: t, h: seg - t, kind: "wood" });
      } else {
        walls.push({ x: cx + w / 2 - t, y: cy - h / 2 + t, w: t, h: h - t * 2, kind: "wood" });
      }
    }

    // Central Gothic Chapel Ruins
    addCabin(1200, 900, 320, 260, "left", "right");
    // 4 Outer Village Cabins
    addCabin(450, 420, 260, 220, "right", "bottom");
    addCabin(1950, 420, 260, 220, "left", "bottom");
    addCabin(450, 1380, 260, 220, "right", "top");
    addCabin(1950, 1380, 260, 220, "left", "top");

    // Loop Ruin Walls (L-walls & Jungle Gyms)
    const ruins = [
      { x: 860, y: 500, w: 160, h: 26 },
      { x: 860, y: 500, w: 26, h: 150 },
      { x: 1540 - 160, y: 500, w: 160, h: 26 },
      { x: 1540 - 26, y: 500, w: 26, h: 150 },
      { x: 860, y: 1280, w: 160, h: 26 },
      { x: 860, y: 1150, w: 26, h: 150 },
      { x: 1540 - 160, y: 1280, w: 160, h: 26 },
      { x: 1540 - 26, y: 1150, w: 26, h: 150 },
      // Mid lane cover
      { x: 640, y: 885, w: 170, h: 26 },
      { x: 1590, y: 885, w: 170, h: 26 },
    ];
    ruins.forEach((r) => walls.push({ ...r, kind: "stone" }));

    // 10 Pallets (Devrilebilir Ahşap Barikatlar) placed in narrow 76px walled choke points!
    // Dropping a pallet completely blocks the passage; Villagers can slide over, Werewolf must break it.
    const palletCoords = [
      { x: 450, y: 575, dir: "h" },
      { x: 1950, y: 575, dir: "h" },
      { x: 450, y: 1225, dir: "h" },
      { x: 1950, y: 1225, dir: "h" },
      { x: 960, y: 690, dir: "v" },
      { x: 1440, y: 690, dir: "v" },
      { x: 960, y: 1110, dir: "v" },
      { x: 1440, y: 1110, dir: "v" },
      { x: 725, y: 985, dir: "h" },
      { x: 1675, y: 815, dir: "h" },
    ];
    palletCoords.forEach((p, idx) => {
      pallets.push({
        id: `pal_${idx}`,
        x: p.x,
        y: p.y,
        dir: p.dir,
        state: "upright", // "upright" | "dropped" | "broken"
      });
      // Flanking stone walls creating a mandatory narrow barricade corridor
      if (p.dir === "h") {
        walls.push({ x: p.x - 102, y: p.y - 14, w: 64, h: 28, kind: "stone" });
        walls.push({ x: p.x + 38, y: p.y - 14, w: 64, h: 28, kind: "stone" });
      } else {
        walls.push({ x: p.x - 14, y: p.y - 102, w: 28, h: 64, kind: "stone" });
        walls.push({ x: p.x - 14, y: p.y + 38, w: 28, h: 64, kind: "stone" });
      }
    });

    // 8 Vaultable Low Window / Hurdle Obstacles (Üstünden Atlanan Engeller)
    const vaults = [];
    const vaultCoords = [
      { x: 1200, y: 740, dir: "h" },
      { x: 1200, y: 1060, dir: "h" },
      { x: 605, y: 420, dir: "v" },
      { x: 1795, y: 420, dir: "v" },
      { x: 605, y: 1380, dir: "v" },
      { x: 1795, y: 1380, dir: "v" },
      { x: 860, y: 720, dir: "v" },
      { x: 1540, y: 1080, dir: "v" },
    ];
    vaultCoords.forEach((vc, idx) => {
      vaults.push({ id: `vlt_${idx}`, x: vc.x, y: vc.y, dir: vc.dir });
      // Flanking stone posts so jumping over is faster than circling around
      if (vc.dir === "h") {
        walls.push({ x: vc.x - 92, y: vc.y - 12, w: 54, h: 24, kind: "stone" });
        walls.push({ x: vc.x + 38, y: vc.y - 12, w: 54, h: 24, kind: "stone" });
      } else {
        walls.push({ x: vc.x - 12, y: vc.y - 92, w: 24, h: 54, kind: "stone" });
        walls.push({ x: vc.x - 12, y: vc.y + 38, w: 24, h: 54, kind: "stone" });
      }
    });

    // 8 Lockers (Saklanma Dolapları)
    const lockerCoords = [
      { x: 356, y: 355 },
      { x: 2044, y: 355 },
      { x: 356, y: 1445 },
      { x: 2044, y: 1445 },
      { x: 1082, y: 815 },
      { x: 1318, y: 985 },
      { x: 906, y: 560 },
      { x: 1494, y: 1240 },
    ];
    lockerCoords.forEach((l, idx) => {
      lockers.push({ id: `loc_${idx}`, x: l.x, y: l.y, occupantId: null });
    });

    // 7 Totems (Kutsal Tılsımlar)
    const totemSpots = [
      { x: 450, y: 420 },
      { x: 1950, y: 420 },
      { x: 450, y: 1380 },
      { x: 1950, y: 1380 },
      { x: 1200, y: 900 },
      { x: 1200, y: 310 },
      { x: 1200, y: 1490 },
    ];
    totemSpots.forEach((t, idx) => {
      totems.push({
        id: `tot_${idx}`,
        x: t.x,
        y: t.y,
        progress: 0,
        done: false,
        repairers: 0,
        lastFailTime: 0,
      });
    });

    // 6 Sacrifice Cages (Kurban Kafesleri)
    const cageSpots = [
      { x: 750, y: 260 },
      { x: 1650, y: 260 },
      { x: 260, y: 900 },
      { x: 2140, y: 900 },
      { x: 750, y: 1540 },
      { x: 1650, y: 1540 },
    ];
    cageSpots.forEach((c, idx) => {
      cages.push({ id: `cage_${idx}`, x: c.x, y: c.y, prisonerId: null });
    });

    // Dense Gothic Pine Trees (placed safely away from walls, doors, totems, pallets, cages)
    const treeCenters = [
      { x: 240, y: 220, r: 42 },
      { x: 680, y: 180, r: 38 },
      { x: 1720, y: 180, r: 38 },
      { x: 2160, y: 220, r: 42 },
      { x: 220, y: 650, r: 40 },
      { x: 2180, y: 650, r: 40 },
      { x: 220, y: 1150, r: 40 },
      { x: 2180, y: 1150, r: 40 },
      { x: 240, y: 1580, r: 42 },
      { x: 680, y: 1620, r: 38 },
      { x: 1720, y: 1620, r: 38 },
      { x: 2160, y: 1580, r: 42 },
      { x: 720, y: 670, r: 34 },
      { x: 1680, y: 670, r: 34 },
      { x: 720, y: 1130, r: 34 },
      { x: 1680, y: 1130, r: 34 },
      { x: 1030, y: 310, r: 32 },
      { x: 1370, y: 310, r: 32 },
      { x: 1030, y: 1490, r: 32 },
      { x: 1370, y: 1490, r: 32 },
    ];
    // Add slight seeded jitter so every match feels organic
    treeCenters.forEach((tc, idx) => {
      trees.push({
        id: `tree_${idx}`,
        x: tc.x + (rng() - 0.5) * 26,
        y: tc.y + (rng() - 0.5) * 26,
        r: tc.r,
      });
    });

    // Precompute shadow/raycast segments from walls only (trees are round 3D pine cones)
    const segments = [];
    for (const w of walls) {
      const x1 = w.x, y1 = w.y, x2 = w.x + w.w, y2 = w.y + w.h;
      segments.push([x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]);
    }

    // Build Players (1 Werewolf + 4 Villagers)
    const players = {};
    const villagerSpawns = [
      { x: 180, y: 180 },
      { x: 2220, y: 180 },
      { x: 180, y: 1620 },
      { x: 2220, y: 1620 },
    ];
    const wolfSpawn = { x: 1200, y: 690 };

    const botNames = ["Kâhin Elif", "Demirci Kaya", "Avcı Mert", "Şifacı Aslı"];
    let vIdx = 0;
    let hasWolf = false;

    const fullList = [...assignments];
    for (const a of fullList) {
      if (a.role === "werewolf") hasWolf = true;
    }
    const needBots = fillBots || fullList.length < 2;
    if (needBots) {
      if (!hasWolf) {
        fullList.push({ id: "bot_wolf", name: "Karanlık Kurt", role: "werewolf", isBot: true });
      }
      let currentVillagers = fullList.filter((a) => a.role === "villager").length;
      while (currentVillagers < 4) {
        fullList.push({
          id: `bot_v${currentVillagers + 1}`,
          name: botNames[currentVillagers % botNames.length],
          role: "villager",
          isBot: true,
        });
        currentVillagers++;
      }
    }

    const totalVillagers = fullList.filter((a) => a.role === "villager").length;
    const totemsRequired = totalVillagers <= 1 ? 3 : totalVillagers === 2 ? 4 : TOTEMS_REQUIRED;

    const cloakColors = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24"];

    for (const entry of fullList) {
      if (entry.role === "werewolf") {
        players[entry.id] = {
          id: entry.id,
          name: entry.name,
          role: "werewolf",
          isBot: !!entry.isBot,
          x: wolfSpawn.x,
          y: wolfSpawn.y,
          vx: 0,
          vy: 0,
          angle: Math.PI / 2,
          r: 22,
          speed: WOLF_SPEED,
          lungeTimer: 0,
          lungeDidHit: false,
          lungeHitSet: new Set(),
          attackCd: 0,
          wipeTimer: 0,
          stunTimer: 0,
          blindTimer: 0,
          howlActiveTimer: 0,
          howlCd: 0,
          instinctActiveTimer: 0,
          instinctCd: 0,
          carryingId: null,
          vaultTimer: 0,
          vaultDur: 0.95,
          vaultFromX: 0,
          vaultFromY: 0,
          vaultToX: 0,
          vaultToY: 0,
          channel: null, // { type: 'break_pallet', targetId, progress, duration }
          score: 0,
          botState: { targetX: 1200, targetY: 900, repath: 0, stuckTimer: 0, prevX: wolfSpawn.x, prevY: wolfSpawn.y },
        };
      } else {
        const sp = villagerSpawns[vIdx % villagerSpawns.length];
        const color = cloakColors[vIdx % cloakColors.length];
        vIdx++;
        players[entry.id] = {
          id: entry.id,
          name: entry.name,
          role: "villager",
          isBot: !!entry.isBot,
          color,
          x: sp.x,
          y: sp.y,
          vx: 0,
          vy: 0,
          angle: 0,
          r: 18,
          hp: 2, // 2=Healthy, 1=Injured, 0=Downed
          state: "active", // "active" | "carried" | "caged" | "escaped" | "dead"
          cageStages: 0,
          cageTimer: 60, // seconds remaining in current cage stage
          campProtected: false,
          bleedTimer: 90,
          wiggleProgress: 0,
          invulTimer: 0,
          hitBurstTimer: 0,
          inLockerId: null,
          vaultTimer: 0,
          vaultDur: 0.48,
          vaultFromX: 0,
          vaultFromY: 0,
          vaultToX: 0,
          vaultToY: 0,
          flashlightCd: 0,
          flashlightBurstTimer: 0,
          channel: null, // { type: 'repair'|'heal'|'rescue'|'gate', targetId, duration }
          healProgress: 0,
          sprinting: false,
          scratchTimer: 0,
          bloodTimer: 0,
          score: 0,
          botState: {
            repath: 0,
            scTimer: 2 + rng() * 4,
            stuckTimer: 0,
            prevX: sp.x,
            prevY: sp.y,
            wanderAngle: rng() * Math.PI * 2,
          },
        };
      }
    }

    return {
      seed,
      difficulty,
      time: 0,
      matchOver: false,
      winnerText: "",
      winnerSub: "",
      powered: false,
      repairedCount: 0,
      totemsRequired,
      walls,
      trees,
      totems,
      cages,
      pallets,
      vaults,
      lockers,
      gates,
      segments,
      players,
      scratches: [], // { x, y, life, maxLife }
      bloodPools: [], // { x, y, r, life }
      noisePings: [], // { x, y, life, maxLife, label, color }
      particles: [], // { x, y, vx, vy, r, color, life, maxLife }
      skillCheck: null, // active local skill check
      nextSkillCheckIn: 4.5,
      camera: { x: 1200, y: 900, shake: 0 },
    };
  }

  function rebuildStaticMapCache() {
    if (!world) return;
    staticMapCanvas = document.createElement("canvas");
    staticMapCanvas.width = WORLD_W;
    staticMapCanvas.height = WORLD_H;
    const sctx = staticMapCanvas.getContext("2d");

    // 1. Floor
    if (groundPattern) {
      sctx.fillStyle = groundPattern;
      sctx.fillRect(0, 0, WORLD_W, WORLD_H);
      sctx.fillStyle = "rgba(6, 8, 13, 0.32)";
      sctx.fillRect(0, 0, WORLD_W, WORLD_H);
    } else {
      sctx.fillStyle = "#12151c";
      sctx.fillRect(0, 0, WORLD_W, WORLD_H);
    }

    // Subtle cobble paths connecting central chapel & gates
    sctx.save();
    sctx.strokeStyle = "rgba(95, 86, 74, 0.16)";
    sctx.lineWidth = 68;
    sctx.lineCap = "round";
    sctx.beginPath();
    sctx.moveTo(1200, 50);
    sctx.lineTo(1200, WORLD_H - 50);
    sctx.moveTo(450, 420);
    sctx.lineTo(1950, 1380);
    sctx.moveTo(1950, 420);
    sctx.lineTo(450, 1380);
    sctx.stroke();
    sctx.restore();

    // 2. Walls (stone & dark timber)
    for (const w of world.walls) {
      sctx.save();
      sctx.fillStyle = w.kind === "stone" ? "#262a34" : "#2e221b";
      sctx.fillRect(w.x, w.y, w.w, w.h);
      sctx.strokeStyle = w.kind === "stone" ? "#475061" : "#5a4232";
      sctx.lineWidth = 2;
      sctx.strokeRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
      // Inner top highlight for crisp top-down depth
      sctx.fillStyle = "rgba(255,255,255,0.06)";
      sctx.fillRect(w.x + 3, w.y + 3, Math.max(0, w.w - 6), Math.min(6, w.h - 4));
      sctx.restore();
    }

    // 3. Trees (dark gothic canopy tops)
    for (const tr of world.trees) {
      sctx.save();
      // Drop shadow
      sctx.fillStyle = "rgba(0,0,0,0.45)";
      sctx.beginPath();
      sctx.arc(tr.x + 6, tr.y + 8, tr.r * 1.05, 0, Math.PI * 2);
      sctx.fill();
      // Outer foliage
      const grad = sctx.createRadialGradient(tr.x - 6, tr.y - 6, 4, tr.x, tr.y, tr.r);
      grad.addColorStop(0, "#1f3327");
      grad.addColorStop(0.65, "#122119");
      grad.addColorStop(1, "#09110d");
      sctx.fillStyle = grad;
      sctx.beginPath();
      sctx.arc(tr.x, tr.y, tr.r, 0, Math.PI * 2);
      sctx.fill();
      // Trunk rim
      sctx.strokeStyle = "rgba(55, 80, 62, 0.35)";
      sctx.lineWidth = 2;
      sctx.stroke();
      sctx.restore();
    }
  }

  // ===================== COLLISION & LINE OF SIGHT =====================
  function resolveCircleCollisions(ent, radius) {
    // Clamp world bounds (allow passing into open Exit Gate doorway!)
    let minY = 42 + radius;
    let maxY = WORLD_H - 42 - radius;
    for (const g of world.gates) {
      if (g.open && ent.x > g.x + radius * 0.5 && ent.x < g.x + g.w - radius * 0.5) {
        if (g.id === "g_north") minY = 8;
        if (g.id === "g_south") maxY = WORLD_H - 8;
      }
    }
    ent.x = clamp(ent.x, 42 + radius, WORLD_W - 42 - radius);
    ent.y = clamp(ent.y, minY, maxY);

    // Walls
    for (const w of world.walls) {
      const closestX = clamp(ent.x, w.x, w.x + w.w);
      const closestY = clamp(ent.y, w.y, w.y + w.h);
      const dx = ent.x - closestX;
      const dy = ent.y - closestY;
      const d2 = dx * dx + dy * dy;
      if (d2 < radius * radius) {
        const d = Math.sqrt(d2) || 0.001;
        const push = radius - d;
        ent.x += (dx / d) * push;
        ent.y += (dy / d) * push;
      }
    }

    // Closed exit gates block passage
    for (const g of world.gates) {
      if (!g.open) {
        const closestX = clamp(ent.x, g.x, g.x + g.w);
        const closestY = clamp(ent.y, g.y, g.y + g.h);
        const dx = ent.x - closestX;
        const dy = ent.y - closestY;
        const d2 = dx * dx + dy * dy;
        if (d2 < radius * radius) {
          const d = Math.sqrt(d2) || 0.001;
          const push = radius - d;
          ent.x += (dx / d) * push;
          ent.y += (dy / d) * push;
        }
      }
    }

    // Dropped pallets act as physical barriers
    for (const p of world.pallets) {
      if (p.state === "dropped") {
        const pw = p.dir === "h" ? 76 : 24;
        const ph = p.dir === "h" ? 24 : 76;
        const rx = p.x - pw / 2;
        const ry = p.y - ph / 2;
        const closestX = clamp(ent.x, rx, rx + pw);
        const closestY = clamp(ent.y, ry, ry + ph);
        const dx = ent.x - closestX;
        const dy = ent.y - closestY;
        const d2 = dx * dx + dy * dy;
        if (d2 < radius * radius) {
          const d = Math.sqrt(d2) || 0.001;
          const push = radius - d;
          ent.x += (dx / d) * push;
          ent.y += (dy / d) * push;
        }
      }
    }

    // Vaultable obstacles block walking (must press E to jump over)
    if (world.vaults) {
      for (const vlt of world.vaults) {
        const vw = vlt.dir === "h" ? 76 : 20;
        const vh = vlt.dir === "h" ? 20 : 76;
        const rx = vlt.x - vw / 2;
        const ry = vlt.y - vh / 2;
        const closestX = clamp(ent.x, rx, rx + vw);
        const closestY = clamp(ent.y, ry, ry + vh);
        const dx = ent.x - closestX;
        const dy = ent.y - closestY;
        const d2 = dx * dx + dy * dy;
        if (d2 < radius * radius) {
          const d = Math.sqrt(d2) || 0.001;
          const push = radius - d;
          ent.x += (dx / d) * push;
          ent.y += (dy / d) * push;
        }
      }
    }

    // Trees
    for (const tr of world.trees) {
      const trR = tr.r * 0.78;
      const dx = ent.x - tr.x;
      const dy = ent.y - tr.y;
      const minD = radius + trR;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2) || 0.001;
        const push = minD - d;
        ent.x += (dx / d) * push;
        ent.y += (dy / d) * push;
      }
    }

    // Totems solid center core
    for (const tot of world.totems) {
      const dx = ent.x - tot.x;
      const dy = ent.y - tot.y;
      const minD = radius + 24;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2) || 0.001;
        const push = minD - d;
        ent.x += (dx / d) * push;
        ent.y += (dy / d) * push;
      }
    }
  }

  function raySegmentDist(ox, oy, dx, dy, x1, y1, x2, y2) {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const denom = dx * vy - dy * vx;
    if (Math.abs(denom) < 1e-8) return Infinity;
    const qpx = x1 - ox;
    const qpy = y1 - oy;
    const t = (qpx * vy - qpy * vx) / denom;
    if (t < 0) return Infinity;
    const u = (qpx * dy - qpy * dx) / denom;
    if (u < 0 || u > 1) return Infinity;
    return t;
  }

  function hasLineOfSight(x1, y1, x2, y2, maxDist = 720) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const d = Math.hypot(dx, dy);
    if (d > maxDist) return false;
    if (d < 1) return true;
    const ndx = dx / d;
    const ndy = dy / d;
    for (const s of world.segments) {
      const hit = raySegmentDist(x1, y1, ndx, ndy, s[0], s[1], s[2], s[3]);
      if (hit < d - 4) return false;
    }
    return true;
  }

  function computeVisibilityPolygon(ox, oy, radius) {
    const r2 = (radius + 60) * (radius + 60);
    const localSegs = [];
    for (const s of world.segments) {
      const mx = (s[0] + s[2]) * 0.5 - ox;
      const my = (s[1] + s[3]) * 0.5 - oy;
      if (mx * mx + my * my <= r2 || dist2(ox, oy, s[0], s[1]) <= r2 || dist2(ox, oy, s[2], s[3]) <= r2) {
        localSegs.push(s);
      }
    }

    const angles = [];
    // Uniform ring rays so open curves are smooth
    const ringCount = 72;
    for (let i = 0; i < ringCount; i++) {
      angles.push((i / ringCount) * Math.PI * 2 - Math.PI);
    }
    // Corner rays for razor-sharp shadows around walls
    for (const s of localSegs) {
      const a1 = Math.atan2(s[1] - oy, s[0] - ox);
      const a2 = Math.atan2(s[3] - oy, s[2] - ox);
      angles.push(a1 - 0.0006, a1 + 0.0006, a2 - 0.0006, a2 + 0.0006);
    }

    const pts = [];
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let minT = radius;
      for (let j = 0; j < localSegs.length; j++) {
        const s = localSegs[j];
        const t = raySegmentDist(ox, oy, dx, dy, s[0], s[1], s[2], s[3]);
        if (t < minT) minT = t;
      }
      pts.push({ a, x: ox + dx * minT, y: oy + dy * minT });
    }
    pts.sort((p, q) => p.a - q.a);
    return pts;
  }

  // ===================== TOASTS & PARTICLES =====================
  function showToast(text, kind = "normal") {
    const el = document.createElement("div");
    el.className = `hud-toast ${kind}`;
    el.textContent = text;
    hudToastWrap.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3400);
    while (hudToastWrap.children.length > 4) {
      hudToastWrap.firstChild.remove();
    }
  }

  function spawnParticles(x, y, color, count = 12, speed = 150) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random() * 0.7) * speed;
      world.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        r: 2 + Math.random() * 3,
        color,
        life: 0.45 + Math.random() * 0.4,
        maxLife: 0.85,
      });
    }
  }

  function addNoisePing(x, y, label, color = "#ef4444") {
    world.noisePings.push({ x, y, label, color, life: 3.4, maxLife: 3.4 });
  }

  function broadcastEvent(ev) {
    handleNetworkEvent(ev, true);
    if (wsConnected) {
      sendWS({ t: "e", ...ev });
    }
  }

  function handleNetworkEvent(ev, isLocal = false) {
    if (!world) return;
    switch (ev.ev) {
      case "toast":
        showToast(ev.msg, ev.kind || "normal");
        break;
      case "howl":
        audio.playHowl();
        if (ev.msg) showToast(ev.msg, "danger");
        break;
      case "hit":
        audio.playHit();
        if (ev.targetId === myId) {
          damageFlash.style.opacity = "1";
          setTimeout(() => (damageFlash.style.opacity = "0"), 220);
        }
        spawnParticles(ev.x, ev.y, "#dc2626", 18, 220);
        break;
      case "slash":
        audio.playSlash();
        break;
      case "explode":
        audio.playGeneratorExplosion();
        addNoisePing(ev.x, ev.y, "Tılsım Patlaması!", "#f97316");
        spawnParticles(ev.x, ev.y, "#fb923c", 22, 240);
        if (ev.msg) showToast(ev.msg, "danger");
        break;
      case "totem_done":
        audio.playTotemComplete();
        addNoisePing(ev.x, ev.y, "Tılsım Onarıldı!", "#38bdf8");
        showToast(ev.msg || "Kutsal Tılsım Onarıldı!", "good");
        break;
      case "powered":
        audio.playExitPowered();
        showToast("⚡ 5 Tılsım Tamamlandı! Çıkış Kapıları Aktif!", "good");
        break;
      case "pallet":
        if (ev.stun) {
          audio.playStun();
          world.camera.shake = 12;
          showToast(ev.msg || "🪵 KURT SERSEMLETİLDİ! (+500)", "good");
        } else {
          audio.playPalletDrop();
        }
        break;
      case "cage":
        audio.playCageLock();
        addNoisePing(ev.x, ev.y, "Kafes Kilidi!", "#ef4444");
        if (ev.msg) showToast(ev.msg, "danger");
        break;
      case "rescue":
        showToast(ev.msg || "🔓 Köylü Kafesten Kurtarıldı!", "good");
        break;
      case "flash":
        audio.playFlashlight();
        spawnParticles(ev.x, ev.y, "#e0f2fe", 20, 260);
        if (ev.blinded) showToast("✨ GÜMÜŞ FENER KURTU KÖR ETTİ!", "good");
        break;
      case "gameover":
        if (!isLocal) {
          world.matchOver = true;
          world.winnerText = ev.title;
          world.winnerSub = ev.sub;
          openGameOverScreen();
        }
        break;
      case "sc_res":
        if (isHost() && ev.totemId) {
          const totem = world.totems.find((t) => t.id === ev.totemId);
          const sender = world.players[ev.from];
          if (totem && !totem.done) {
            if (ev.grade === "great") {
              totem.progress = Math.min(1, totem.progress + 0.08);
              if (sender) sender.score += 300;
            } else if (ev.grade === "good") {
              totem.progress = Math.min(1, totem.progress + 0.02);
              if (sender) sender.score += 100;
            } else {
              totem.progress = Math.max(0, totem.progress - 0.1);
              totem.lastFailTime = world.time;
              broadcastEvent({
                ev: "explode",
                x: totem.x,
                y: totem.y,
                msg: "💥 TILSIM PATLADI! Kurt sesini duydu!",
              });
            }
          }
        }
        break;
    }
  }

  // ===================== SKILL CHECK ENGINE (VILLAGER) =====================
  function triggerSkillCheck() {
    if (!world || world.skillCheck || world.matchOver) return;
    const me = world.players[myId];
    if (!me || me.role !== "villager" || !me.channel || me.channel.type !== "repair") return;

    audio.playSkillCheckWarn();
    const targetStart = 0.25 + Math.random() * 0.45; // normalized 0..1 of circle
    const goodSpan = 0.14;
    const greatSpan = 0.04;

    world.skillCheck = {
      totemId: me.channel.targetId,
      needle: 0,
      speed: 0.74, // smoother rotations per second
      targetStart,
      goodSpan,
      greatSpan,
      warnDelay: 0.42, // brief pause before needle moves
      resolved: false,
    };
    skillCheckOverlay.classList.remove("hidden");
  }

  function resolveSkillCheck(hit) {
    const sc = world && world.skillCheck;
    if (!sc || sc.resolved) return;
    sc.resolved = true;
    skillCheckOverlay.classList.add("hidden");
    world.skillCheck = null;

    const me = world.players[myId];
    const totem = world.totems.find((t) => t.id === sc.totemId);
    if (!me || !totem || totem.done) return;

    const n = sc.needle;
    const inGreat = n >= sc.targetStart && n <= sc.targetStart + sc.greatSpan;
    const inGood = n >= sc.targetStart && n <= sc.targetStart + sc.goodSpan;

    if (hit && inGreat) {
      audio.playSkillCheckSuccess(true);
      if (isHost()) {
        totem.progress = Math.min(1, totem.progress + 0.08);
        me.score += 300;
      } else {
        sendWS({ t: "e", ev: "sc_res", totemId: totem.id, grade: "great" });
      }
      showToast("✨ KUSURSUZ KONTROL! (+%8 İlerleme, +300 Puan)", "good");
    } else if (hit && inGood) {
      audio.playSkillCheckSuccess(false);
      if (isHost()) {
        totem.progress = Math.min(1, totem.progress + 0.02);
        me.score += 100;
      } else {
        sendWS({ t: "e", ev: "sc_res", totemId: totem.id, grade: "good" });
      }
      showToast("✔️ İyi Kontrol (+100 Puan)", "good");
    } else {
      // Failed skill check!
      if (isHost()) {
        totem.progress = Math.max(0, totem.progress - 0.1);
        totem.lastFailTime = world.time;
        broadcastEvent({
          ev: "explode",
          x: totem.x,
          y: totem.y,
          msg: "💥 TILSIM PATLADI! Kurt sesini duydu!",
        });
      } else {
        sendWS({ t: "e", ev: "sc_res", totemId: totem.id, grade: "fail" });
        audio.playGeneratorExplosion();
        showToast("💥 TILSIM PATLADI! Kurt sesini duydu!", "danger");
      }
    }
  }

  function drawSkillCheck() {
    const sc = world && world.skillCheck;
    if (!sc) return;
    const w = scCanvas.width;
    const h = scCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = 68;

    scCtx.clearRect(0, 0, w, h);

    // Outer dark backing
    scCtx.beginPath();
    scCtx.arc(cx, cy, r + 14, 0, Math.PI * 2);
    scCtx.fillStyle = "rgba(8, 10, 16, 0.85)";
    scCtx.fill();

    // Base ring
    scCtx.beginPath();
    scCtx.arc(cx, cy, r, 0, Math.PI * 2);
    scCtx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    scCtx.lineWidth = 14;
    scCtx.stroke();

    const startA = -Math.PI / 2 + sc.targetStart * Math.PI * 2;
    const goodEndA = startA + sc.goodSpan * Math.PI * 2;
    const greatEndA = startA + sc.greatSpan * Math.PI * 2;

    // Good Zone (cyan)
    scCtx.beginPath();
    scCtx.arc(cx, cy, r, startA, goodEndA);
    scCtx.strokeStyle = "#0ea5e9";
    scCtx.lineWidth = 15;
    scCtx.stroke();

    // Great Zone (pure white)
    scCtx.beginPath();
    scCtx.arc(cx, cy, r, startA, greatEndA);
    scCtx.strokeStyle = "#ffffff";
    scCtx.lineWidth = 17;
    scCtx.stroke();

    // Sweeping Needle
    const nA = -Math.PI / 2 + sc.needle * Math.PI * 2;
    scCtx.beginPath();
    scCtx.moveTo(cx + Math.cos(nA) * (r - 22), cy + Math.sin(nA) * (r - 22));
    scCtx.lineTo(cx + Math.cos(nA) * (r + 18), cy + Math.sin(nA) * (r + 18));
    scCtx.strokeStyle = "#ef4444";
    scCtx.lineWidth = 4;
    scCtx.lineCap = "round";
    scCtx.stroke();

    // Center badge
    scCtx.fillStyle = "#eae3d5";
    scCtx.font = "bold 13px sans-serif";
    scCtx.textAlign = "center";
    scCtx.textBaseline = "middle";
    scCtx.fillText("SPACE", cx, cy);
  }

  // ===================== INTERACTION & ACTIONS =====================
  function findNearestInteraction(p) {
    if (!world || world.matchOver) return null;

    if (p.role === "werewolf") {
      if (p.stunTimer > 0 || p.channel || p.vaultTimer > 0) return null;

      // 1. Cage if carrying
      if (p.carryingId) {
        for (const c of world.cages) {
          if (!c.prisonerId && dist(p.x, p.y, c.x, c.y) < 76) {
            return { type: "cage_drop", target: c, label: "[E] Kurban Kafesine Hapset!" };
          }
        }
        return null;
      }

      // 2. Pick up downed villager
      for (const other of Object.values(world.players)) {
        if (other.role === "villager" && other.state === "active" && other.hp === 0) {
          if (dist(p.x, p.y, other.x, other.y) < 62) {
            return { type: "pickup", target: other, label: `[E] ${other.name} Sırtla` };
          }
        }
      }

      // 3. Smash dropped pallet (mandatory to pass choked barricade)
      for (const pal of world.pallets) {
        if (pal.state === "dropped" && dist(p.x, p.y, pal.x, pal.y) < 68) {
          return { type: "break_pallet", target: pal, label: "[E] Barikatı Kır" };
        }
      }

      // 4. Vault over low obstacle slowly
      if (world.vaults) {
        for (const vlt of world.vaults) {
          if (dist(p.x, p.y, vlt.x, vlt.y) < 60) {
            return { type: "vault_obstacle", target: vlt, label: "[E] Engeli Aş" };
          }
        }
      }

      // 5. Search locker
      for (const loc of world.lockers) {
        if (dist(p.x, p.y, loc.x, loc.y) < 58) {
          return { type: "search_locker", target: loc, label: "[E] Dolabı Kontrol Et" };
        }
      }
      return null;
    }

    // VILLAGER INTERACTIONS
    if (p.state !== "active" || p.vaultTimer > 0) return null;

    if (p.inLockerId) {
      return { type: "exit_locker", target: p.inLockerId, label: "[E] Dolaptan Çık" };
    }

    if (p.hp === 0) return null; // downed villagers cannot interact

    // 0. Instant escape if standing right inside an open Exit Gate doorway
    if (world.powered) {
      for (const g of world.gates) {
        if (g.open && dist(p.x, p.y, g.x + g.w / 2, g.exitY) < 92) {
          return { type: "escape_gate", target: g, label: "[E] Çıkış Kapısından Kaç!" };
        }
      }
    }

    // 1. Rescue caged ally
    for (const c of world.cages) {
      if (c.prisonerId && dist(p.x, p.y, c.x, c.y) < 72) {
        return { type: "rescue", target: c, label: "[E] Arkadaşını Kafesten Kurtar" };
      }
    }

    // 2. Heal injured / downed ally
    for (const other of Object.values(world.players)) {
      if (
        other.id !== p.id &&
        other.role === "villager" &&
        other.state === "active" &&
        other.hp < 2 &&
        dist(p.x, p.y, other.x, other.y) < 62
      ) {
        return { type: "heal", target: other, label: `[E] ${other.name} İyileştir` };
      }
    }

    // 3. Pallet (Drop or Slide/Vault across)
    for (const pal of world.pallets) {
      if (pal.state === "upright" && dist(p.x, p.y, pal.x, pal.y) < 62) {
        return { type: "drop_pallet", target: pal, label: "[E] Barikatı Devir!" };
      }
      if (pal.state === "dropped" && dist(p.x, p.y, pal.x, pal.y) < 58) {
        return { type: "vault_pallet", target: pal, label: "[E] Barikatın Üstünden Kayarak Geç" };
      }
    }

    // 3b. Vaultable Obstacle / Window
    if (world.vaults) {
      for (const vlt of world.vaults) {
        if (dist(p.x, p.y, vlt.x, vlt.y) < 62) {
          return { type: "vault_obstacle", target: vlt, label: "[E] Engelin Üstünden Atla" };
        }
      }
    }

    // 4. Open Exit Gate if powered
    if (world.powered) {
      for (const g of world.gates) {
        if (!g.open && dist(p.x, p.y, g.switchX, g.switchY) < 76) {
          return { type: "gate", target: g, label: "[E] Çıkış Kapısını Aç" };
        }
      }
    }

    // 5. Repair Totem
    for (const tot of world.totems) {
      if (!tot.done && dist(p.x, p.y, tot.x, tot.y) < 72) {
        return { type: "repair", target: tot, label: `[E] Kutsal Tılsımı Onar (%${Math.floor(tot.progress * 100)})` };
      }
    }

    // 6. Hide in Locker
    for (const loc of world.lockers) {
      if (!loc.occupantId && dist(p.x, p.y, loc.x, loc.y) < 54) {
        return { type: "enter_locker", target: loc, label: "[E] Dolaba Saklan" };
      }
    }

    return null;
  }

  function performInstantOrStartChannel(p, act) {
    if (!act) return;

    if (p.role === "werewolf") {
      if (act.type === "pickup") {
        const v = act.target;
        v.state = "carried";
        v.wiggleProgress = 0;
        v.channel = null;
        p.carryingId = v.id;
        return;
      }
      if (act.type === "cage_drop") {
        const v = world.players[p.carryingId];
        if (v) {
          v.state = "caged";
          v.x = act.target.x;
          v.y = act.target.y;
          v.cageStages += 1;
          if (v.cageStages >= 3) {
            v.state = "dead";
            act.target.prisonerId = null;
            broadcastEvent({
              ev: "cage",
              x: act.target.x,
              y: act.target.y,
              msg: `☠️ ${v.name} Karanlık Kafeste Kurban Edildi!`,
            });
          } else {
            v.cageTimer = v.cageStages === 1 ? 60 : 35;
            act.target.prisonerId = v.id;
            broadcastEvent({
              ev: "cage",
              x: act.target.x,
              y: act.target.y,
              msg: `⛓️ ${v.name} Kurban Kafesine Kilitlendi!`,
            });
          }
          p.score += 350;
        }
        p.carryingId = null;
        return;
      }
      if (act.type === "break_pallet") {
        p.channel = { type: "break_pallet", targetId: act.target.id, progress: 0, duration: 1.6 };
        return;
      }
      if (act.type === "vault_obstacle") {
        const vlt = act.target;
        p.vaultDur = 0.95;
        p.vaultTimer = 0.95;
        p.vaultFromX = p.x;
        p.vaultFromY = p.y;
        if (vlt.dir === "h") {
          p.vaultToX = vlt.x;
          p.vaultToY = p.y < vlt.y ? vlt.y + 38 : vlt.y - 38;
        } else {
          p.vaultToX = p.x < vlt.x ? vlt.x + 38 : vlt.x - 38;
          p.vaultToY = vlt.y;
        }
        return;
      }
      if (act.type === "search_locker") {
        const loc = act.target;
        if (loc.occupantId) {
          const v = world.players[loc.occupantId];
          loc.occupantId = null;
          if (v) {
            v.inLockerId = null;
            v.hp = 0;
            v.state = "carried";
            v.wiggleProgress = 0;
            p.carryingId = v.id;
            broadcastEvent({
              ev: "hit",
              targetId: v.id,
              x: loc.x,
              y: loc.y,
            });
            broadcastEvent({ ev: "toast", msg: `🐺 ${v.name} dolapta yakalandı!`, kind: "danger" });
          }
        } else {
          p.wipeTimer = 0.6;
          if (p.id === myId) showToast("Dolap boş.", "normal");
        }
        return;
      }
      return;
    }

    // VILLAGER
    if (act.type === "escape_gate") {
      p.state = "escaped";
      p.score += 1000;
      broadcastEvent({ ev: "rescue", msg: `🏃 ${p.name} ormandan kaçtı! (+1000)` });
      return;
    }
    if (act.type === "enter_locker") {
      act.target.occupantId = p.id;
      p.inLockerId = act.target.id;
      p.x = act.target.x;
      p.y = act.target.y;
      p.channel = null;
      return;
    }
    if (act.type === "exit_locker") {
      const loc = world.lockers.find((l) => l.id === p.inLockerId);
      if (loc) loc.occupantId = null;
      p.inLockerId = null;
      p.y += 28;
      resolveCircleCollisions(p, p.r);
      return;
    }
    if (act.type === "drop_pallet") {
      const pal = act.target;
      pal.state = "dropped";
      const wolf = Object.values(world.players).find((pl) => pl.role === "werewolf");
      let stunned = false;
      if (wolf && dist(wolf.x, wolf.y, pal.x, pal.y) < 58) {
        wolf.stunTimer = 2.6;
        wolf.lungeTimer = 0;
        wolf.carryingId && dropCarriedSurvivor(wolf);
        p.score += 500;
        stunned = true;
      } else {
        // Push entities slightly out of dropped pallet center
        const pushEntity = (ent) => {
          const d = dist(ent.x, ent.y, pal.x, pal.y);
          if (d < 34) {
            if (pal.dir === "h") ent.y += ent.y >= pal.y ? 28 : -28;
            else ent.x += ent.x >= pal.x ? 28 : -28;
          }
        };
        pushEntity(p);
        if (wolf) pushEntity(wolf);
      }
      broadcastEvent({ ev: "pallet", stun: stunned, msg: stunned ? `🪵 ${p.name} KURTU SERSEMLETTİ! (+500)` : "" });
      return;
    }
    if (act.type === "vault_pallet") {
      const pal = act.target;
      p.vaultDur = 0.48;
      p.vaultTimer = 0.48;
      p.vaultFromX = p.x;
      p.vaultFromY = p.y;
      if (pal.dir === "h") {
        p.vaultToX = pal.x;
        p.vaultToY = p.y < pal.y ? pal.y + 36 : pal.y - 36;
      } else {
        p.vaultToX = p.x < pal.x ? pal.x + 36 : pal.x - 36;
        p.vaultToY = pal.y;
      }
      return;
    }
    if (act.type === "vault_obstacle") {
      const vlt = act.target;
      p.vaultDur = 0.45;
      p.vaultTimer = 0.45;
      p.vaultFromX = p.x;
      p.vaultFromY = p.y;
      if (vlt.dir === "h") {
        p.vaultToX = vlt.x;
        p.vaultToY = p.y < vlt.y ? vlt.y + 36 : vlt.y - 36;
      } else {
        p.vaultToX = p.x < vlt.x ? vlt.x + 36 : vlt.x - 36;
        p.vaultToY = vlt.y;
      }
      return;
    }
    if (act.type === "repair") {
      p.channel = { type: "repair", targetId: act.target.id, duration: 22 };
      return;
    }
    if (act.type === "rescue") {
      p.channel = { type: "rescue", targetId: act.target.id, progress: 0, duration: 1.5 };
      return;
    }
    if (act.type === "heal") {
      p.channel = { type: "heal", targetId: act.target.id, duration: 6.0 };
      return;
    }
    if (act.type === "gate") {
      p.channel = { type: "gate", targetId: act.target.id, duration: 8.0 };
      return;
    }
  }

  function dropCarriedSurvivor(wolf) {
    const v = world.players[wolf.carryingId];
    if (v) {
      v.state = "active";
      v.hp = 1;
      v.hitBurstTimer = 1.6;
      v.invulTimer = 1.6;
      v.x = wolf.x;
      v.y = wolf.y;
      resolveCircleCollisions(v, v.r);
    }
    wolf.carryingId = null;
  }

  function triggerWolfAttack(wolf) {
    if (
      !wolf ||
      wolf.role !== "werewolf" ||
      wolf.attackCd > 0 ||
      wolf.lungeTimer > 0 ||
      wolf.wipeTimer > 0 ||
      wolf.stunTimer > 0 ||
      wolf.vaultTimer > 0 ||
      wolf.carryingId
    ) {
      return;
    }
    wolf.lungeTimer = 0.22;
    wolf.lungeDidHit = false;
    wolf.attackCd = 1.75;
    wolf.lungeHitSet = new Set();
    broadcastEvent({ ev: "slash" });
  }

  function triggerSpecialQ(p) {
    if (!p || world.matchOver) return;
    if (p.role === "werewolf") {
      if (p.howlCd > 0 || p.stunTimer > 0) return;
      p.howlActiveTimer = 5.0;
      p.howlCd = 15.0;
      broadcastEvent({ ev: "howl", msg: "🐺 KANLI ULUMA! Kurt öfkeyle hızlandı!" });
    } else if (p.state === "active" && p.hp > 0 && !p.inLockerId) {
      if (p.flashlightCd > 0) return;
      p.flashlightCd = 18.0;
      p.flashlightBurstTimer = 0.45;
      const wolf = Object.values(world.players).find((pl) => pl.role === "werewolf");
      let blinded = false;
      if (wolf && dist(p.x, p.y, wolf.x, wolf.y) < 260 && hasLineOfSight(p.x, p.y, wolf.x, wolf.y, 270)) {
        const aToWolf = angleTo(p.x, p.y, wolf.x, wolf.y);
        let diff = Math.abs(((aToWolf - p.angle + Math.PI) % (Math.PI * 2)) - Math.PI);
        if (diff < 0.72) {
          wolf.blindTimer = 2.1;
          wolf.stunTimer = Math.max(wolf.stunTimer, 1.4);
          if (wolf.carryingId) dropCarriedSurvivor(wolf);
          p.hitBurstTimer = Math.max(p.hitBurstTimer, 1.1);
          p.score += 350;
          blinded = true;
        }
      }
      broadcastEvent({ ev: "flash", x: p.x + Math.cos(p.angle) * 40, y: p.y + Math.sin(p.angle) * 40, blinded });
    }
  }

  function triggerSpecialR(p) {
    if (!p || p.role !== "werewolf" || p.instinctCd > 0 || world.matchOver) return;
    p.instinctActiveTimer = 6.0;
    p.instinctCd = 16.0;
    if (p.id === myId) showToast("👁️ Avcı İçgüdüsü aktif: Tılsımlar & İzler parlıyor!", "normal");
  }

  // ===================== SIMULATION UPDATE (HOST / SOLO) =====================
  function getLocalInputVector() {
    let mx = 0, my = 0;
    if (keys["KeyW"] || keys["ArrowUp"]) my -= 1;
    if (keys["KeyS"] || keys["ArrowDown"]) my += 1;
    if (keys["KeyA"] || keys["ArrowLeft"]) mx -= 1;
    if (keys["KeyD"] || keys["ArrowRight"]) mx += 1;
    const len = Math.hypot(mx, my);
    if (len > 0) {
      mx /= len;
      my /= len;
    }
    return {
      mx,
      my,
      angle: world && world.players[myId] ? angleTo(world.players[myId].x, world.players[myId].y, mouse.worldX, mouse.worldY) : 0,
      sprint: !!(keys["ShiftLeft"] || keys["ShiftRight"]),
      interactHold: !!keys["KeyE"],
    };
  }

  function applyGuestInput(gid, pkt) {
    const p = world.players[gid];
    if (!p) return;
    guestInputs[gid] = pkt;
    if (pkt.atk) triggerWolfAttack(p);
    if (pkt.q) triggerSpecialQ(p);
    if (pkt.r) triggerSpecialR(p);
    if (pkt.tapE) {
      const act = findNearestInteraction(p);
      if (act) performInstantOrStartChannel(p, act);
    }
  }

  function updateEffects(dt) {
    for (let i = world.scratches.length - 1; i >= 0; i--) {
      world.scratches[i].life -= dt;
      if (world.scratches[i].life <= 0) world.scratches.splice(i, 1);
    }
    for (let i = world.bloodPools.length - 1; i >= 0; i--) {
      world.bloodPools[i].life -= dt;
      if (world.bloodPools[i].life <= 0) world.bloodPools.splice(i, 1);
    }
    for (let i = world.noisePings.length - 1; i >= 0; i--) {
      world.noisePings[i].life -= dt;
      if (world.noisePings[i].life <= 0) world.noisePings.splice(i, 1);
    }
    for (let i = world.particles.length - 1; i >= 0; i--) {
      const pt = world.particles[i];
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 0.92;
      pt.vy *= 0.92;
      pt.life -= dt;
      if (pt.life <= 0) world.particles.splice(i, 1);
    }
  }

  function updateSimulation(dt) {
    world.time += dt;

    // Reset totem repairer count
    for (const tot of world.totems) tot.repairers = 0;

    updateEffects(dt);

    const wolf = Object.values(world.players).find((p) => p.role === "werewolf");

    // Update each player
    for (const p of Object.values(world.players)) {
      if (p.role === "werewolf") {
        updateWerewolf(p, dt);
      } else {
        updateVillager(p, wolf, dt);
      }
    }

    // Check completed totems & powered gates
    const reqTotems = world.totemsRequired || TOTEMS_REQUIRED;
    let doneCount = 0;
    for (const tot of world.totems) {
      if (!tot.done && tot.progress >= 1) {
        tot.progress = 1;
        tot.done = true;
        doneCount++;
        broadcastEvent({ ev: "totem_done", x: tot.x, y: tot.y, msg: `🔮 Kutsal Tılsım Onarıldı! (${Math.min(reqTotems, doneCount)}/${reqTotems})` });
      } else if (tot.done) {
        doneCount++;
      }
    }
    world.repairedCount = doneCount;
    if (!world.powered && doneCount >= reqTotems) {
      world.powered = true;
      broadcastEvent({ ev: "powered" });
    }

    // Check Match Over conditions
    if (!world.matchOver) {
      const villagers = Object.values(world.players).filter((pl) => pl.role === "villager");
      const activeOrCaged = villagers.filter((v) => v.state === "active" || v.state === "carried" || v.state === "caged");
      const escapedCount = villagers.filter((v) => v.state === "escaped").length;
      const deadCount = villagers.filter((v) => v.state === "dead").length;

      if (activeOrCaged.length === 0) {
        world.matchOver = true;
        if (escapedCount === 0) {
          world.winnerText = "🐺 KANLI AY ZAFERİ!";
          world.winnerSub = "Kurt tüm köylüleri avladı ve kurban etti.";
        } else if (escapedCount >= 3) {
          world.winnerText = "🏮 KÖYLÜLER KURTULDU!";
          world.winnerSub = `${escapedCount} köylü lanetli ormandan kaçmayı başardı.`;
        } else {
          world.winnerText = "🌑 DENGE SAĞLANDI";
          world.winnerSub = `${escapedCount} köylü kaçtı, ${deadCount} köylü kurban edildi.`;
        }
        broadcastEvent({ ev: "gameover", title: world.winnerText, sub: world.winnerSub });
        openGameOverScreen();
      }
    }
  }

  function updateWerewolf(w, dt) {
    w.attackCd = Math.max(0, (w.attackCd || 0) - dt);
    w.howlCd = Math.max(0, w.howlCd - dt);
    w.howlActiveTimer = Math.max(0, w.howlActiveTimer - dt);
    w.instinctCd = Math.max(0, w.instinctCd - dt);
    w.instinctActiveTimer = Math.max(0, w.instinctActiveTimer - dt);
    w.wipeTimer = Math.max(0, w.wipeTimer - dt);
    w.stunTimer = Math.max(0, w.stunTimer - dt);
    w.blindTimer = Math.max(0, w.blindTimer - dt);

    if (w.stunTimer > 0) return;

    // Vaulting over a low obstacle slowly
    if (w.vaultTimer > 0) {
      w.vaultTimer -= dt;
      const t = 1 - Math.max(0, w.vaultTimer) / (w.vaultDur || 0.95);
      w.x = w.vaultFromX + (w.vaultToX - w.vaultFromX) * t;
      w.y = w.vaultFromY + (w.vaultToY - w.vaultFromY) * t;
      return;
    }

    // Channeling (smashing dropped pallet — runs to completion without WASD interruption)
    if (w.channel) {
      w.channel.progress += dt / w.channel.duration;
      if (w.channel.progress >= 1) {
        if (w.channel.type === "break_pallet") {
          const pal = world.pallets.find((pl) => pl.id === w.channel.targetId);
          if (pal) {
            pal.state = "broken";
            spawnParticles(pal.x, pal.y, "#92400e", 14, 180);
          }
        }
        w.channel = null;
      }
      return;
    }

    // Lunge strike active (capped speed + missed-swing slowdown to prevent lunge-spam speedups)
    if (w.lungeTimer > 0) {
      w.lungeTimer -= dt;
      const lungeSpd = 245;
      w.x += Math.cos(w.angle) * lungeSpd * dt;
      w.y += Math.sin(w.angle) * lungeSpd * dt;
      resolveCircleCollisions(w, w.r);

      // Check hit against villagers
      for (const v of Object.values(world.players)) {
        if (
          v.role === "villager" &&
          v.state === "active" &&
          v.hp > 0 &&
          !v.inLockerId &&
          v.invulTimer <= 0 &&
          !w.lungeHitSet.has(v.id)
        ) {
          const d = dist(w.x, w.y, v.x, v.y);
          if (d < 74) {
            const aToV = angleTo(w.x, w.y, v.x, v.y);
            const diff = Math.abs(((aToV - w.angle + Math.PI) % (Math.PI * 2)) - Math.PI);
            if (diff < 1.1) {
              w.lungeHitSet.add(v.id);
              w.lungeDidHit = true;
              v.hp = Math.max(0, v.hp - 1);
              v.channel = null;
              v.invulTimer = 1.5;
              v.hitBurstTimer = v.hp === 1 ? 1.65 : 0;
              w.lungeTimer = 0;
              w.wipeTimer = 1.65;
              w.score += v.hp === 0 ? 350 : 200;
              broadcastEvent({ ev: "hit", targetId: v.id, x: v.x, y: v.y });
              if (v.hp === 0) {
                showToast(`🩸 ${v.name} yere düştü! Kafese taşı [E]`, "danger");
              }
              break;
            }
          }
        }
      }
      if (w.lungeTimer <= 0 && !w.lungeDidHit) {
        // Missed-attack recovery slowdown prevents using lunge spam to travel faster
        w.wipeTimer = 1.25;
      }
      return;
    }

    // Normal movement (Human or AI Bot)
    let mx = 0, my = 0;
    if (w.isBot) {
      const botOut = runWolfBotAI(w, dt);
      mx = botOut.mx;
      my = botOut.my;
    } else if (w.id === myId) {
      const inp = getLocalInputVector();
      mx = inp.mx;
      my = inp.my;
      w.angle = inp.angle;
      if (inp.interactHold && !w.channel) {
        const act = findNearestInteraction(w);
        if (act && act.type === "break_pallet") performInstantOrStartChannel(w, act);
      }
    } else {
      const inp = guestInputs[w.id];
      if (inp) {
        mx = inp.mx || 0;
        my = inp.my || 0;
        if (typeof inp.angle === "number") w.angle = inp.angle;
      }
    }

    let spd = WOLF_SPEED;
    if (w.wipeTimer > 0) spd = WOLF_WIPE_SPEED;
    else if (w.carryingId) spd = WOLF_CARRY_SPEED;
    else if (w.howlActiveTimer > 0) spd = WOLF_HOWL_SPEED;
    if (w.blindTimer > 0) spd *= 0.6;

    w.x += mx * spd * dt;
    w.y += my * spd * dt;
    w.vx = mx * spd;
    w.vy = my * spd;
    resolveCircleCollisions(w, w.r);

    // Update carried survivor position & fixed-duration auto escape (no A/D mash shortcut)
    if (w.carryingId) {
      const v = world.players[w.carryingId];
      if (!v || v.state !== "carried") {
        w.carryingId = null;
      } else {
        v.x = w.x - Math.cos(w.angle) * 16;
        v.y = w.y - Math.sin(w.angle) * 16;
        v.wiggleProgress = Math.min(1, v.wiggleProgress + dt / CARRY_ESCAPE_DURATION);
        if (v.wiggleProgress >= 1) {
          dropCarriedSurvivor(w);
          w.stunTimer = 2.2;
          broadcastEvent({ ev: "pallet", stun: true, msg: `💪 ${v.name} Süre Doldu ve Kurtun Elinden Kurtuldu!` });
        }
      }
    }
  }

  function updateVillager(v, wolf, dt) {
    v.invulTimer = Math.max(0, v.invulTimer - dt);
    v.hitBurstTimer = Math.max(0, v.hitBurstTimer - dt);
    v.flashlightCd = Math.max(0, v.flashlightCd - dt);
    v.flashlightBurstTimer = Math.max(0, v.flashlightBurstTimer - dt);

    if (v.state === "escaped" || v.state === "dead" || v.state === "carried") return;

    if (v.state === "caged") {
      // Anti-Camp Protection: If Werewolf camps within 250px without chasing another villager nearby, freeze timer!
      const dWolfToCage = wolf ? dist(v.x, v.y, wolf.x, wolf.y) : 9999;
      const otherVillagerChasedNear = Object.values(world.players).some(
        (o) =>
          o.id !== v.id &&
          o.role === "villager" &&
          o.state === "active" &&
          !o.inLockerId &&
          wolf &&
          dist(o.x, o.y, wolf.x, wolf.y) < 155
      );
      v.campProtected = dWolfToCage < 250 && !otherVillagerChasedNear;
      if (!v.campProtected) {
        v.cageTimer -= dt;
      }
      if (v.cageTimer <= 0) {
        v.state = "dead";
        for (const c of world.cages) {
          if (c.prisonerId === v.id) c.prisonerId = null;
        }
        broadcastEvent({ ev: "toast", msg: `☠️ ${v.name} Kafeste Kurban Edildi!`, kind: "danger" });
      }
      return;
    }
    v.campProtected = false;

    if (v.inLockerId) return;

    // Vaulting over dropped pallet or obstacle
    if (v.vaultTimer > 0) {
      v.vaultTimer -= dt;
      const t = 1 - Math.max(0, v.vaultTimer) / (v.vaultDur || 0.48);
      v.x = v.vaultFromX + (v.vaultToX - v.vaultFromX) * t;
      v.y = v.vaultFromY + (v.vaultToY - v.vaultFromY) * t;
      return;
    }

    // Bleedout if downed (hp === 0)
    if (v.hp === 0) {
      v.bleedTimer -= dt;
      if (v.bleedTimer <= 0) {
        v.state = "dead";
        broadcastEvent({ ev: "toast", msg: `☠️ ${v.name} kan kaybından öldü!`, kind: "danger" });
        return;
      }
    }

    // Movement input
    let mx = 0, my = 0, sprinting = false, wantHoldE = false;
    if (v.isBot) {
      const out = runVillagerBotAI(v, wolf, dt);
      mx = out.mx;
      my = out.my;
      sprinting = out.sprint;
      wantHoldE = out.holdE;
    } else if (v.id === myId) {
      const inp = getLocalInputVector();
      mx = inp.mx;
      my = inp.my;
      v.angle = inp.angle;
      sprinting = inp.sprint;
      wantHoldE = inp.interactHold;
    } else {
      const inp = guestInputs[v.id];
      if (inp) {
        mx = inp.mx || 0;
        my = inp.my || 0;
        if (typeof inp.angle === "number") v.angle = inp.angle;
        sprinting = !!inp.sprint;
        wantHoldE = !!inp.interactHold;
      }
    }

    const moving = Math.abs(mx) > 0.05 || Math.abs(my) > 0.05;

    // Channeling logic (Repair, Rescue, Heal, Gate)
    if (wantHoldE && !moving && v.hp > 0) {
      if (!v.channel) {
        const act = findNearestInteraction(v);
        if (act && ["repair", "rescue", "heal", "gate"].includes(act.type)) {
          performInstantOrStartChannel(v, act);
        }
      }
      if (v.channel) {
        if (v.channel.type === "repair") {
          const tot = world.totems.find((t) => t.id === v.channel.targetId);
          if (!tot || tot.done || dist(v.x, v.y, tot.x, tot.y) > 84) {
            v.channel = null;
          } else {
            tot.repairers += 1;
            const coopBonus = tot.repairers > 1 ? 0.85 : 1.0;
            tot.progress = Math.min(1, tot.progress + (dt / 22.0) * coopBonus);
            v.score += dt * 20;
            if (v.isBot) {
              v.botState.scTimer -= dt;
              if (v.botState.scTimer <= 0) {
                v.botState.scTimer = 5.5 + Math.random() * 5;
                if (Math.random() < (world.difficulty === "hard" ? 0.08 : 0.16)) {
                  tot.progress = Math.max(0, tot.progress - 0.08);
                  tot.lastFailTime = world.time;
                  broadcastEvent({ ev: "explode", x: tot.x, y: tot.y, msg: `💥 ${v.name} tılsımda hata yaptı!` });
                } else {
                  tot.progress = Math.min(1, tot.progress + 0.02);
                }
              }
            }
          }
        } else if (v.channel.type === "rescue") {
          const c = world.cages.find((cg) => cg.id === v.channel.targetId);
          if (!c || !c.prisonerId || dist(v.x, v.y, c.x, c.y) > 84) {
            v.channel = null;
          } else {
            v.channel.progress += dt / v.channel.duration;
            if (v.channel.progress >= 1) {
              const pris = world.players[c.prisonerId];
              c.prisonerId = null;
              if (pris) {
                pris.state = "active";
                pris.hp = 1;
                pris.invulTimer = 1.6;
                pris.x = c.x;
                pris.y = c.y + 30;
                resolveCircleCollisions(pris, pris.r);
              }
              v.score += 400;
              v.channel = null;
              broadcastEvent({ ev: "rescue", msg: `🔓 ${v.name}, ${pris ? pris.name : "arkadaşını"} kafesten kurtardı!` });
            }
          }
        } else if (v.channel.type === "heal") {
          const target = world.players[v.channel.targetId];
          if (!target || target.state !== "active" || target.hp >= 2 || dist(v.x, v.y, target.x, target.y) > 74) {
            v.channel = null;
          } else {
            target.healProgress += dt / 6.0;
            if (target.healProgress >= 1) {
              target.hp = Math.min(2, target.hp + 1);
              target.healProgress = 0;
              v.score += 250;
              if (target.hp >= 2) v.channel = null;
            }
          }
        } else if (v.channel.type === "gate") {
          const g = world.gates.find((gt) => gt.id === v.channel.targetId);
          if (!g || g.open || dist(v.x, v.y, g.switchX, g.switchY) > 84) {
            v.channel = null;
          } else {
            g.progress = Math.min(1, g.progress + dt / 8.0);
            if (g.progress >= 1) {
              g.open = true;
              v.score += 500;
              v.channel = null;
              broadcastEvent({ ev: "totem_done", x: g.x + g.w / 2, y: g.y + g.h / 2, msg: `🚪 ${g.name} AÇILDI! Kaçın!` });
            }
          }
        }
      }
    } else {
      v.channel = null;
    }

    if (v.channel) {
      v.vx = 0;
      v.vy = 0;
      return;
    }

    v.sprinting = sprinting && moving && v.hp > 0;
    let spd = VILLAGER_WALK;
    if (v.hp === 0) spd = VILLAGER_CRAWL;
    else if (v.hitBurstTimer > 0) spd = VILLAGER_HIT_BURST;
    else if (v.sprinting) spd = VILLAGER_SPRINT;

    v.x += mx * spd * dt;
    v.y += my * spd * dt;
    v.vx = mx * spd;
    v.vy = my * spd;
    resolveCircleCollisions(v, v.r);

    // Check if villager walked into an open Exit Gate escape zone!
    if (world.powered) {
      for (const g of world.gates) {
        if (g.open && v.x >= g.x && v.x <= g.x + g.w) {
          if ((g.id === "g_north" && v.y <= 78) || (g.id === "g_south" && v.y >= WORLD_H - 78)) {
            v.state = "escaped";
            v.score += 1000;
            broadcastEvent({ ev: "rescue", msg: `🏃 ${v.name} ormandan kaçtı! (+1000)` });
            return;
          }
        }
      }
    }

    // Scratch marks when sprinting
    if (v.sprinting) {
      v.scratchTimer -= dt;
      if (v.scratchTimer <= 0) {
        v.scratchTimer = 0.16;
        world.scratches.push({
          x: v.x + (Math.random() - 0.5) * 18,
          y: v.y + (Math.random() - 0.5) * 18,
          life: 6.5,
          maxLife: 6.5,
        });
      }
    }

    // Blood pools when injured or downed
    if (v.hp <= 1) {
      v.bloodTimer -= dt;
      if (v.bloodTimer <= 0) {
        v.bloodTimer = v.hp === 0 ? 0.35 : 0.75;
        world.bloodPools.push({
          x: v.x + (Math.random() - 0.5) * 10,
          y: v.y + (Math.random() - 0.5) * 10,
          r: 4 + Math.random() * 5,
          life: 9.0,
        });
      }
    }
  }

  // ===================== SMART AI BOTS =====================
  function steerAroundObstacles(ent, tx, ty, dt, stateObj) {
    const baseAngle = angleTo(ent.x, ent.y, tx, ty);
    // Stuck detector: if moved very little, add detour offset
    stateObj.repath -= dt;
    if (stateObj.repath <= 0) {
      stateObj.repath = 0.45;
      const moved = dist(ent.x, ent.y, stateObj.prevX, stateObj.prevY);
      stateObj.prevX = ent.x;
      stateObj.prevY = ent.y;
      if (moved < 12) {
        stateObj.stuckTimer += 0.45;
      } else {
        stateObj.stuckTimer = 0;
      }
    }

    // Probe 5 forward rays to pick clearest obstacle-free angle
    const offsets = [0, 0.45, -0.45, 0.95, -0.95, 1.5, -1.5];
    let bestAngle = baseAngle;
    if (stateObj.stuckTimer > 0.4) {
      bestAngle = baseAngle + (Math.floor(world.time * 2) % 2 === 0 ? 1.35 : -1.35);
    } else {
      for (const off of offsets) {
        const a = baseAngle + off;
        const probeX = ent.x + Math.cos(a) * 52;
        const probeY = ent.y + Math.sin(a) * 52;
        if (!pointInsideWallOrTree(probeX, probeY, ent.r + 4)) {
          bestAngle = a;
          break;
        }
      }
    }

    ent.angle = lerpAngle(ent.angle, bestAngle, 0.25);
    return { mx: Math.cos(bestAngle), my: Math.sin(bestAngle) };
  }

  function pointInsideWallOrTree(x, y, pad) {
    if (x < 46 + pad || x > WORLD_W - 46 - pad || y < 46 + pad || y > WORLD_H - 46 - pad) return true;
    for (const w of world.walls) {
      if (x > w.x - pad && x < w.x + w.w + pad && y > w.y - pad && y < w.y + w.h + pad) return true;
    }
    for (const tr of world.trees) {
      if (dist2(x, y, tr.x, tr.y) < (tr.r * 0.78 + pad) ** 2) return true;
    }
    for (const p of world.pallets) {
      if (p.state === "dropped") {
        const pw = p.dir === "h" ? 76 : 24;
        const ph = p.dir === "h" ? 24 : 76;
        if (x > p.x - pw / 2 - pad && x < p.x + pw / 2 + pad && y > p.y - ph / 2 - pad && y < p.y + ph / 2 + pad) {
          return true;
        }
      }
    }
    if (world.vaults) {
      for (const vlt of world.vaults) {
        const vw = vlt.dir === "h" ? 76 : 20;
        const vh = vlt.dir === "h" ? 20 : 76;
        if (x > vlt.x - vw / 2 - pad && x < vlt.x + vw / 2 + pad && y > vlt.y - vh / 2 - pad && y < vlt.y + vh / 2 + pad) {
          return true;
        }
      }
    }
    return false;
  }

  function runVillagerBotAI(v, wolf, dt) {
    const out = { mx: 0, my: 0, sprint: false, holdE: false };
    const hard = world.difficulty === "hard";

    // Crawling away if downed
    if (v.hp === 0) {
      if (wolf) {
        const awayA = angleTo(wolf.x, wolf.y, v.x, v.y);
        return { mx: Math.cos(awayA), my: Math.sin(awayA), sprint: false, holdE: false };
      }
      return out;
    }

    const dWolf = wolf ? dist(v.x, v.y, wolf.x, wolf.y) : 9999;

    // 1. Flee if Werewolf is close
    if (wolf && dWolf < (hard ? 380 : 320) && (hasLineOfSight(v.x, v.y, wolf.x, wolf.y, 420) || dWolf < 220)) {
      // Drop nearby upright pallet if Werewolf is close behind!
      for (const pal of world.pallets) {
        if (pal.state === "upright" && dist(v.x, v.y, pal.x, pal.y) < 52 && dist(wolf.x, wolf.y, pal.x, pal.y) < 95) {
          performInstantOrStartChannel(v, { type: "drop_pallet", target: pal });
        }
      }
      // Silver Lantern flash if facing wolf and off cooldown
      if (v.flashlightCd <= 0 && dWolf < 210 && Math.random() < 0.08) {
        v.angle = angleTo(v.x, v.y, wolf.x, wolf.y);
        triggerSpecialQ(v);
      }
      const awayX = clamp(v.x + (v.x - wolf.x), 120, WORLD_W - 120);
      const awayY = clamp(v.y + (v.y - wolf.y), 120, WORLD_H - 120);
      const mv = steerAroundObstacles(v, awayX, awayY, dt, v.botState);
      return { mx: mv.mx, my: mv.my, sprint: true, holdE: false };
    }

    // 2. Exit if powered
    if (world.powered) {
      const openGate = world.gates.find((g) => g.open);
      if (openGate) {
        const mv = steerAroundObstacles(v, openGate.x + openGate.w / 2, openGate.exitY, dt, v.botState);
        return { mx: mv.mx, my: mv.my, sprint: true, holdE: false };
      }
      // Go open nearest gate
      let bestG = world.gates[0];
      if (dist(v.x, v.y, world.gates[1].switchX, world.gates[1].switchY) < dist(v.x, v.y, bestG.switchX, bestG.switchY)) {
        bestG = world.gates[1];
      }
      if (dist(v.x, v.y, bestG.switchX, bestG.switchY) < 60) {
        return { mx: 0, my: 0, sprint: false, holdE: true };
      }
      const mv = steerAroundObstacles(v, bestG.switchX, bestG.switchY, dt, v.botState);
      return { mx: mv.mx, my: mv.my, sprint: true, holdE: false };
    }

    // 3. Rescue caged teammate if safe
    const caged = Object.values(world.players).find((pl) => pl.role === "villager" && pl.state === "caged");
    if (caged && (!wolf || dist(wolf.x, wolf.y, caged.x, caged.y) > 210)) {
      if (dist(v.x, v.y, caged.x, caged.y) < 62) {
        return { mx: 0, my: 0, sprint: false, holdE: true };
      }
      const mv = steerAroundObstacles(v, caged.x, caged.y, dt, v.botState);
      return { mx: mv.mx, my: mv.my, sprint: true, holdE: false };
    }

    // 4. Heal downed or injured nearby ally
    const hurtAlly = Object.values(world.players).find(
      (pl) => pl.id !== v.id && pl.role === "villager" && pl.state === "active" && pl.hp < 2 && dist(v.x, v.y, pl.x, pl.y) < 420
    );
    if (hurtAlly && dWolf > 380) {
      if (dist(v.x, v.y, hurtAlly.x, hurtAlly.y) < 54) {
        return { mx: 0, my: 0, sprint: false, holdE: true };
      }
      const mv = steerAroundObstacles(v, hurtAlly.x, hurtAlly.y, dt, v.botState);
      return { mx: mv.mx, my: mv.my, sprint: false, holdE: false };
    }

    // 5. Repair nearest incomplete totem
    let nearestTot = null;
    let bestD = Infinity;
    for (const tot of world.totems) {
      if (!tot.done) {
        const d = dist(v.x, v.y, tot.x, tot.y);
        if (d < bestD) {
          bestD = d;
          nearestTot = tot;
        }
      }
    }
    if (nearestTot) {
      if (bestD < 64) {
        return { mx: 0, my: 0, sprint: false, holdE: true };
      }
      const mv = steerAroundObstacles(v, nearestTot.x, nearestTot.y, dt, v.botState);
      return { mx: mv.mx, my: mv.my, sprint: bestD > 350, holdE: false };
    }

    return out;
  }

  function runWolfBotAI(w, dt) {
    const hard = world.difficulty === "hard";

    // 1. If carrying someone, go straight to nearest empty cage!
    if (w.carryingId) {
      let nearestCage = null;
      let bestD = Infinity;
      for (const c of world.cages) {
        if (!c.prisonerId) {
          const d = dist(w.x, w.y, c.x, c.y);
          if (d < bestD) {
            bestD = d;
            nearestCage = c;
          }
        }
      }
      if (nearestCage) {
        if (bestD < 68) {
          performInstantOrStartChannel(w, { type: "cage_drop", target: nearestCage });
          return { mx: 0, my: 0 };
        }
        return steerAroundObstacles(w, nearestCage.x, nearestCage.y, dt, w.botState);
      }
    }

    // 2. If a downed villager is nearby, pick them up!
    for (const v of Object.values(world.players)) {
      if (v.role === "villager" && v.state === "active" && v.hp === 0 && dist(w.x, w.y, v.x, v.y) < 380) {
        if (dist(w.x, w.y, v.x, v.y) < 56) {
          performInstantOrStartChannel(w, { type: "pickup", target: v });
          return { mx: 0, my: 0 };
        }
        return steerAroundObstacles(w, v.x, v.y, dt, w.botState);
      }
    }

    // 3. Smash dropped pallet if right in front of us
    for (const pal of world.pallets) {
      if (pal.state === "dropped" && dist(w.x, w.y, pal.x, pal.y) < 58) {
        performInstantOrStartChannel(w, { type: "break_pallet", target: pal });
        return { mx: 0, my: 0 };
      }
    }

    // 4. Find visible villager to chase
    let chaseTarget = null;
    let chaseDist = Infinity;
    for (const v of Object.values(world.players)) {
      if (v.role === "villager" && v.state === "active" && v.hp > 0 && !v.inLockerId) {
        const d = dist(w.x, w.y, v.x, v.y);
        const visRange = hard ? 640 : 520;
        if (d < visRange && hasLineOfSight(w.x, w.y, v.x, v.y, visRange)) {
          if (d < chaseDist) {
            chaseDist = d;
            chaseTarget = v;
          }
        }
      }
    }

    if (chaseTarget) {
      w.botState.targetX = chaseTarget.x;
      w.botState.targetY = chaseTarget.y;
      if (w.howlCd <= 0 && chaseDist > 120 && chaseDist < 480) {
        triggerSpecialQ(w);
      }
      if (chaseDist < 68) {
        w.angle = angleTo(w.x, w.y, chaseTarget.x, chaseTarget.y);
        triggerWolfAttack(w);
      }
      return steerAroundObstacles(w, chaseTarget.x, chaseTarget.y, dt, w.botState);
    }

    // 5. Investigate latest loud noise ping or fresh scratch marks
    if (world.noisePings.length > 0) {
      const latest = world.noisePings[world.noisePings.length - 1];
      if (latest.life > 1.2) {
        w.botState.targetX = latest.x;
        w.botState.targetY = latest.y;
      }
    } else if (world.scratches.length > 0) {
      const lastScr = world.scratches[world.scratches.length - 1];
      if (dist(w.x, w.y, lastScr.x, lastScr.y) < 420) {
        w.botState.targetX = lastScr.x;
        w.botState.targetY = lastScr.y;
      }
    }

    // 6. Patrol totems or gates when target reached
    if (dist(w.x, w.y, w.botState.targetX, w.botState.targetY) < 75) {
      if (world.powered) {
        const g = world.gates[Math.floor(Math.random() * world.gates.length)];
        w.botState.targetX = g.switchX;
        w.botState.targetY = g.switchY;
      } else {
        const incomplete = world.totems.filter((t) => !t.done);
        const pick = incomplete[Math.floor(Math.random() * incomplete.length)] || world.totems[0];
        w.botState.targetX = pick.x;
        w.botState.targetY = pick.y;
      }
    }

    return steerAroundObstacles(w, w.botState.targetX, w.botState.targetY, dt, w.botState);
  }

  // ===================== NETWORK SNAPSHOTS (50Hz) =====================
  function sendSnapshot() {
    if (!wsConnected || !isHost() || !world) return;
    const snapPlayers = {};
    for (const [id, p] of Object.entries(world.players)) {
      if (p.role === "werewolf") {
        snapPlayers[id] = {
          x: Math.round(p.x),
          y: Math.round(p.y),
          vx: Math.round(p.vx || 0),
          vy: Math.round(p.vy || 0),
          a: +p.angle.toFixed(2),
          lt: +p.lungeTimer.toFixed(2),
          ac: +(p.attackCd || 0).toFixed(1),
          wt: +p.wipeTimer.toFixed(2),
          st: +p.stunTimer.toFixed(2),
          vt: +(p.vaultTimer || 0).toFixed(2),
          vd: p.vaultDur || 0.95,
          bt: +p.blindTimer.toFixed(2),
          ht: +p.howlActiveTimer.toFixed(2),
          hc: +p.howlCd.toFixed(1),
          it: +p.instinctActiveTimer.toFixed(2),
          ic: +p.instinctCd.toFixed(1),
          cid: p.carryingId,
          ch: p.channel ? { t: p.channel.type, id: p.channel.targetId, p: +(p.channel.progress || 0).toFixed(2) } : null,
          sc: Math.round(p.score),
        };
      } else {
        snapPlayers[id] = {
          x: Math.round(p.x),
          y: Math.round(p.y),
          vx: Math.round(p.vx || 0),
          vy: Math.round(p.vy || 0),
          a: +p.angle.toFixed(2),
          hp: p.hp,
          s: p.state,
          cs: p.cageStages,
          ct: +p.cageTimer.toFixed(1),
          cp: p.campProtected ? 1 : 0,
          wp: +p.wiggleProgress.toFixed(2),
          vt: +(p.vaultTimer || 0).toFixed(2),
          vd: p.vaultDur || 0.48,
          loc: p.inLockerId,
          fc: +p.flashlightCd.toFixed(1),
          fb: +p.flashlightBurstTimer.toFixed(2),
          spr: p.sprinting ? 1 : 0,
          hl: +p.healProgress.toFixed(2),
          ch: p.channel ? { t: p.channel.type, id: p.channel.targetId, p: +(p.channel.progress || 0).toFixed(2) } : null,
          sc: Math.round(p.score),
        };
      }
    }

    sendWS({
      t: "s",
      tm: +world.time.toFixed(2),
      pw: world.powered ? 1 : 0,
      rc: world.repairedCount,
      pl: snapPlayers,
      tot: world.totems.map((t) => [+t.progress.toFixed(3), t.done ? 1 : 0]),
      pal: world.pallets.map((p) => p.state),
      cag: world.cages.map((c) => c.prisonerId),
      gat: world.gates.map((g) => [+g.progress.toFixed(3), g.open ? 1 : 0]),
    });
  }

  function applyNetworkSnapshot(snap) {
    if (!world) return;
    world.time = snap.tm;
    world.powered = !!snap.pw;
    world.repairedCount = snap.rc;

    if (snap.tot) {
      snap.tot.forEach((arr, i) => {
        if (world.totems[i]) {
          world.totems[i].progress = arr[0];
          world.totems[i].done = !!arr[1];
        }
      });
    }
    if (snap.pal) {
      snap.pal.forEach((st, i) => {
        if (world.pallets[i]) world.pallets[i].state = st;
      });
    }
    if (snap.cag) {
      snap.cag.forEach((pid, i) => {
        if (world.cages[i]) world.cages[i].prisonerId = pid;
      });
    }
    if (snap.gat) {
      snap.gat.forEach((arr, i) => {
        if (world.gates[i]) {
          world.gates[i].progress = arr[0];
          world.gates[i].open = !!arr[1];
        }
      });
    }
    if (snap.pl) {
      for (const [id, sp] of Object.entries(snap.pl)) {
        const p = world.players[id];
        if (!p) continue;
        // Soft reconcile local player, smooth lerp remote players
        if (id === myId) {
          if (dist(p.x, p.y, sp.x, sp.y) > 45) {
            p.x = sp.x;
            p.y = sp.y;
          } else {
            p.x += (sp.x - p.x) * 0.28;
            p.y += (sp.y - p.y) * 0.28;
          }
        } else {
          p.vx = sp.vx || 0;
          p.vy = sp.vy || 0;
          p.x += (sp.x - p.x) * 0.55;
          p.y += (sp.y - p.y) * 0.55;
          p.angle = sp.a;
        }
        p.score = sp.sc;
        if (p.role === "werewolf") {
          p.lungeTimer = sp.lt;
          p.attackCd = sp.ac || 0;
          p.wipeTimer = sp.wt;
          p.stunTimer = sp.st;
          p.vaultTimer = sp.vt || 0;
          p.vaultDur = sp.vd || 0.95;
          p.blindTimer = sp.bt;
          p.howlActiveTimer = sp.ht;
          p.howlCd = sp.hc;
          p.instinctActiveTimer = sp.it;
          p.instinctCd = sp.ic;
          p.carryingId = sp.cid;
          p.channel = sp.ch ? { type: sp.ch.t, targetId: sp.ch.id, progress: sp.ch.p } : null;
        } else {
          p.hp = sp.hp;
          p.state = sp.s;
          p.cageStages = sp.cs;
          p.cageTimer = sp.ct;
          p.campProtected = !!sp.cp;
          p.wiggleProgress = sp.wp;
          p.vaultTimer = sp.vt || 0;
          p.vaultDur = sp.vd || 0.48;
          p.inLockerId = sp.loc;
          p.flashlightCd = sp.fc;
          p.flashlightBurstTimer = sp.fb;
          p.sprinting = !!sp.spr;
          p.healProgress = sp.hl || 0;
          p.channel = sp.ch ? { type: sp.ch.t, targetId: sp.ch.id, progress: sp.ch.p } : null;
          if (p.sprinting && Math.random() < 0.35) {
            world.scratches.push({
              x: p.x + (Math.random() - 0.5) * 18,
              y: p.y + (Math.random() - 0.5) * 18,
              life: 6.5,
              maxLife: 6.5,
            });
          }
          if (p.hp <= 1 && p.state === "active" && Math.random() < 0.08) {
            world.bloodPools.push({
              x: p.x + (Math.random() - 0.5) * 10,
              y: p.y + (Math.random() - 0.5) * 10,
              r: 4 + Math.random() * 4,
              life: 8.5,
            });
          }
        }
      }
    }
  }

  // ===================== RENDERING (3D WEBGL + RAYCAST FOV OVERLAY) =====================
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    fogCanvas.width = window.innerWidth;
    fogCanvas.height = window.innerHeight;
    if (renderer3d) renderer3d.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", resizeCanvas);

  function projectWorld(wx, wy, height = 0, camX = 0, camY = 0) {
    if (renderer3d) {
      return renderer3d.worldToScreen(wx, wy, height);
    }
    return { x: wx - camX, y: wy - camY, visible: true };
  }

  function renderWorld() {
    if (!world) return;
    const me = world.players[myId] || Object.values(world.players)[0];
    if (!me) return;

    const vw = canvas.width;
    const vh = canvas.height;

    // Camera follow with subtle screen shake
    world.camera.x += (me.x - world.camera.x) * 0.16;
    world.camera.y += (me.y - world.camera.y) * 0.16;
    world.camera.shake = Math.max(0, world.camera.shake - 0.6);

    const shakeX = (Math.random() - 0.5) * world.camera.shake;
    const shakeY = (Math.random() - 0.5) * world.camera.shake;
    const camX = Math.round(world.camera.x - vw / 2 + shakeX);
    const camY = Math.round(world.camera.y - vh / 2 + shakeY);

    ctx.clearRect(0, 0, vw, vh);

    const sightMax = me.role === "werewolf" ? SIGHT_WOLF : SIGHT_VILLAGER;
    const poly = computeVisibilityPolygon(me.x, me.y, sightMax);

    if (renderer3d) {
      renderer3d.updateAndRender(world, me, poly, sightMax);
    } else {
      // Fallback 2D rendering if WebGL unavailable
      ctx.fillStyle = "#050608";
      ctx.fillRect(0, 0, vw, vh);
      ctx.save();
      ctx.translate(-camX, -camY);
      if (!staticMapCanvas) rebuildStaticMapCache();
      ctx.drawImage(staticMapCanvas, 0, 0);
      ctx.restore();
    }

    const meScr = projectWorld(me.x, me.y, 16, camX, camY);

    // 1. 2D Fallback Fog of War Overlay (in 3D mode, fog renders natively on the 3D ground plane)
    if (!renderer3d) {
      fogCtx.globalCompositeOperation = "source-over";
      fogCtx.clearRect(0, 0, vw, vh);
      fogCtx.fillStyle = "rgba(4, 5, 10, 0.72)";
      fogCtx.fillRect(0, 0, vw, vh);

      fogCtx.globalCompositeOperation = "destination-out";
      if (poly.length > 2) {
        let maxScrR = 260;
        const scrPts = [];
        for (let i = 0; i < poly.length; i++) {
          const sp = projectWorld(poly[i].x, poly[i].y, 14, camX, camY);
          scrPts.push(sp);
          const d = Math.hypot(sp.x - meScr.x, sp.y - meScr.y);
          if (d > maxScrR) maxScrR = d;
        }
        const visGrad = fogCtx.createRadialGradient(
          meScr.x,
          meScr.y,
          45,
          meScr.x,
          meScr.y,
          Math.min(Math.max(vw, vh) * 0.85, maxScrR * 1.05)
        );
        visGrad.addColorStop(0, "rgba(0,0,0,1)");
        visGrad.addColorStop(0.76, "rgba(0,0,0,0.92)");
        visGrad.addColorStop(1, "rgba(0,0,0,0)");
        fogCtx.fillStyle = visGrad;
        fogCtx.beginPath();
        fogCtx.moveTo(scrPts[0].x, scrPts[0].y);
        for (let i = 1; i < scrPts.length; i++) {
          fogCtx.lineTo(scrPts[i].x, scrPts[i].y);
        }
        fogCtx.closePath();
        fogCtx.fill();
      }
      ctx.drawImage(fogCanvas, 0, 0);
    }

    // 2. 3D-Projected Visible Nameplates, Totem Progress Rings & Particles
    for (const tot of world.totems) {
      if (tot.progress > 0 && !tot.done) {
        const sp = projectWorld(tot.x, tot.y, 44, camX, camY);
        if (sp.visible && sp.x > -40 && sp.x < vw + 40 && sp.y > -40 && sp.y < vh + 40) {
          ctx.save();
          ctx.strokeStyle = "#38bdf8";
          ctx.lineWidth = 3.5;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, 22, -Math.PI / 2, -Math.PI / 2 + tot.progress * Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = "#e0f2fe";
          ctx.font = "bold 11px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(`%${Math.floor(tot.progress * 100)}`, sp.x, sp.y - 26);
          ctx.restore();
        }
      }
    }

    for (const p of Object.values(world.players)) {
      if (p.state === "escaped" || p.state === "dead" || p.state === "caged" || p.inLockerId) continue;
      const isSelf = p.id === me.id;
      const canSee =
        isSelf ||
        (me.role === "villager" && p.role === "villager") ||
        hasLineOfSight(me.x, me.y, p.x, p.y, sightMax);
      if (!canSee) continue;

      const sp = projectWorld(p.x, p.y, p.role === "werewolf" ? 58 : 54, camX, camY);
      if (sp.visible) {
        ctx.fillStyle = p.role === "werewolf" ? "#fca5a5" : p.color || "#e2e8f0";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        const statusTag = p.stunTimer > 0 ? " (SERSEMLEDİ!)" : p.hp === 1 ? " 🩸" : p.hp === 0 ? " 💀" : "";
        ctx.fillText(`${p.name}${statusTag}`, sp.x, sp.y - 8);
      }
    }

    for (const pt of world.particles) {
      const sp = projectWorld(pt.x, pt.y, 22, camX, camY);
      if (sp.visible) {
        ctx.fillStyle = pt.color;
        ctx.globalAlpha = clamp(pt.life / pt.maxLife, 0, 1);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, pt.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // 3. World Auras, Carry Cage Glow Beacons & Loud Noise Pings (above Fog of War!)
    const wolf = Object.values(world.players).find((pl) => pl.role === "werewolf");

    // Caged prisoners visible across map
    for (const c of world.cages) {
      if (c.prisonerId) {
        const pris = world.players[c.prisonerId];
        const sp = projectWorld(c.x, c.y, 64, camX, camY);
        const timerTxt = pris ? (pris.campProtected ? " 🛡️ DURDU" : ` (${Math.ceil(pris.cageTimer)}s)`) : "";
        const label = me.role === "villager" ? `⛓️ KURTAR!${timerTxt}` : `⛓️ ${pris ? pris.name : "TUTSAK"}${timerTxt}`;
        drawScreenAuraBeacon(sp, c.x, c.y, me, pris && pris.campProtected ? "#38bdf8" : "#ef4444", label, vw, vh);
      }
    }

    // WEREWOLF CARRYING A PLAYER: Bright pulsing Crimson-Gold beacons on ALL empty cages + nearest pointer arrow!
    if (me.role === "werewolf" && me.carryingId) {
      let bestCage = null;
      let bestDist = Infinity;
      for (const c of world.cages) {
        if (!c.prisonerId) {
          const d = dist(me.x, me.y, c.x, c.y);
          if (d < bestDist) {
            bestDist = d;
            bestCage = c;
          }
        }
      }

      const pulseColor = Math.sin(world.time * 9) > 0 ? "#fbbf24" : "#ff3b30";
      for (const c of world.cages) {
        if (c.prisonerId) continue;
        const meters = Math.round(dist(me.x, me.y, c.x, c.y) / 20);
        const isBest = c === bestCage;
        const label = isBest ? `🎯 EN YAKIN KAFES • ${meters}m` : `⛓️ KAFES • ${meters}m`;
        const sp = projectWorld(c.x, c.y, 68, camX, camY);
        drawScreenAuraBeacon(sp, c.x, c.y, me, isBest ? "#fde047" : pulseColor, label, vw, vh, isBest);
      }

      // Directional guide arrow orbiting the Werewolf toward the closest empty cage
      if (bestCage) {
        const guideA = angleTo(me.x, me.y, bestCage.x, bestCage.y);
        const gx = meScr.x + Math.cos(guideA) * 58;
        const gy = meScr.y + Math.sin(guideA) * 58;
        ctx.save();
        ctx.translate(gx, gy);
        ctx.rotate(guideA);
        ctx.fillStyle = "#fbbf24";
        ctx.strokeStyle = "#dc2626";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(14, 0);
        ctx.lineTo(-8, -9);
        ctx.lineTo(-4, 0);
        ctx.lineTo(-8, 9);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    if (me.role === "villager") {
      if (world.powered) {
        for (const g of world.gates) {
          const sp = projectWorld(g.switchX, g.switchY, 45, camX, camY);
          drawScreenAuraBeacon(sp, g.switchX, g.switchY, me, g.open ? "#4ade80" : "#fbbf24", g.open ? "🚪 KAÇ!" : "🔌 KAPI", vw, vh);
        }
      }
    } else {
      if (me.instinctActiveTimer > 0) {
        for (const tot of world.totems) {
          if (!tot.done) {
            const sp = projectWorld(tot.x, tot.y, 56, camX, camY);
            drawScreenAuraBeacon(sp, tot.x, tot.y, me, "#38bdf8", `🔮 %${Math.floor(tot.progress * 100)}`, vw, vh);
          }
        }
      }
      if (me.howlActiveTimer > 0) {
        for (const v of Object.values(world.players)) {
          if (v.role === "villager" && v.state === "active" && !v.inLockerId && (v.hp < 2 || v.sprinting) && dist(me.x, me.y, v.x, v.y) < 780) {
            const sp = projectWorld(v.x, v.y, 50, camX, camY);
            drawScreenAuraBeacon(sp, v.x, v.y, me, "#ef4444", "💓 KALP ATIŞI", vw, vh);
          }
        }
      }
    }

    // Loud noise alerts (Exploded Totems, Cage Locks)
    for (const np of world.noisePings) {
      const sp = projectWorld(np.x, np.y, 46, camX, camY);
      if (sp.visible) {
        const pulse = (1 - np.life / np.maxLife) * 85;
        ctx.strokeStyle = np.color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = clamp(np.life / np.maxLife, 0, 1);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 16 + (pulse % 68), 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(np.label, sp.x, sp.y - 24);
      }
    }
    ctx.globalAlpha = 1;

    // 4. Terror Radius Heartbeat & Vignette
    if (me.role === "villager" && wolf && me.state === "active") {
      const d = dist(me.x, me.y, wolf.x, wolf.y);
      const intensity = audio.updateHeartbeat(d, TERROR_RADIUS);
      if (intensity > 0) {
        const beat = 0.5 + 0.5 * Math.sin(world.time * (8 + intensity * 12));
        const alpha = (0.14 + intensity * 0.42) * (0.65 + 0.35 * beat);
        terrorVignette.style.boxShadow = `inset 0 0 ${90 + intensity * 90}px rgba(195, 14, 24, ${alpha.toFixed(2)})`;
      } else {
        terrorVignette.style.boxShadow = "inset 0 0 120px rgba(180, 12, 24, 0)";
      }
    } else {
      terrorVignette.style.boxShadow = "inset 0 0 120px rgba(180, 12, 24, 0)";
    }

    // 5. Skill Check canvas & Minimap
    if (world.skillCheck) drawSkillCheck();
    renderMinimap(me);
  }

  function drawScreenAuraBeacon(sp, wx, wy, me, color, label, vw, vh, emphasize = false) {
    let bx = sp.x;
    let by = sp.y;
    const margin = 66;
    const onScreen = sp.visible && bx >= margin && bx <= vw - margin && by >= margin && by <= vh - margin;

    if (!onScreen) {
      // Clamp cleanly along world direction from local player so off-screen cages are still guided!
      const a = angleTo(me.x, me.y, wx, wy);
      const cx = vw * 0.5;
      const cy = vh * 0.5;
      const rx = vw * 0.5 - margin;
      const ry = vh * 0.5 - margin;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const scale = Math.min(
        Math.abs(cos) > 0.001 ? rx / Math.abs(cos) : Infinity,
        Math.abs(sin) > 0.001 ? ry / Math.abs(sin) : Infinity
      );
      bx = cx + cos * scale;
      by = cy + sin * scale;
    }

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = emphasize ? 3.5 : 2.2;
    const rad = (emphasize ? 26 : 19) + Math.sin(world.time * 7) * 5;
    ctx.beginPath();
    ctx.arc(bx, by, rad, 0, Math.PI * 2);
    ctx.stroke();

    if (emphasize) {
      ctx.fillStyle = "rgba(251, 191, 36, 0.16)";
      ctx.fill();
    }

    ctx.font = emphasize ? "bold 12px sans-serif" : "bold 11px sans-serif";
    ctx.textAlign = "center";
    const textW = ctx.measureText(label).width + 14;
    ctx.fillStyle = "rgba(8, 10, 16, 0.85)";
    ctx.fillRect(bx - textW / 2, by - rad - 22, textW, 18);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - textW / 2, by - rad - 22, textW, 18);
    ctx.fillStyle = color;
    ctx.fillText(label, bx, by - rad - 9);
    ctx.restore();
  }

  function renderMinimap(me) {
    const mw = minimapCanvas.width;
    const mh = minimapCanvas.height;
    const sx = mw / WORLD_W;
    const sy = mh / WORLD_H;

    mctx.fillStyle = "rgba(8, 10, 16, 0.95)";
    mctx.fillRect(0, 0, mw, mh);

    // Walls
    mctx.fillStyle = "rgba(120, 130, 150, 0.45)";
    for (const w of world.walls) {
      mctx.fillRect(w.x * sx, w.y * sy, Math.max(1, w.w * sx), Math.max(1, w.h * sy));
    }

    // Totems
    for (const tot of world.totems) {
      mctx.fillStyle = tot.done ? "#38bdf8" : "#d4a353";
      mctx.beginPath();
      mctx.arc(tot.x * sx, tot.y * sy, 3.2, 0, Math.PI * 2);
      mctx.fill();
    }

    // Cages (Always visible on minimap; pulse bright Crimson-Gold when Werewolf carries a player!)
    const wolf = Object.values(world.players).find((pl) => pl.role === "werewolf");
    const wolfCarrying = !!(wolf && wolf.carryingId);
    const carryPulse = Math.sin(world.time * 9) > 0;
    for (const c of world.cages) {
      if (c.prisonerId) {
        mctx.fillStyle = "#ef4444";
        mctx.fillRect(c.x * sx - 3.5, c.y * sy - 3.5, 7, 7);
      } else if (me.role === "werewolf") {
        if (wolfCarrying) {
          mctx.strokeStyle = carryPulse ? "#fde047" : "#ef4444";
          mctx.lineWidth = 1.5;
          mctx.beginPath();
          mctx.arc(c.x * sx, c.y * sy, carryPulse ? 6.5 : 4.5, 0, Math.PI * 2);
          mctx.stroke();
          mctx.fillStyle = carryPulse ? "#fde047" : "#ef4444";
          mctx.fillRect(c.x * sx - 3, c.y * sy - 3, 6, 6);
        } else {
          mctx.fillStyle = "#f97316";
          mctx.fillRect(c.x * sx - 2.2, c.y * sy - 2.2, 4.4, 4.4);
        }
      }
    }

    // Gates when powered
    if (world.powered) {
      for (const g of world.gates) {
        mctx.fillStyle = g.open ? "#4ade80" : "#fbbf24";
        mctx.fillRect(g.x * sx, g.y * sy, g.w * sx, Math.max(3, g.h * sy));
      }
    }

    // Noise pings
    for (const np of world.noisePings) {
      mctx.strokeStyle = np.color;
      mctx.lineWidth = 1.5;
      mctx.beginPath();
      mctx.arc(np.x * sx, np.y * sy, 6, 0, Math.PI * 2);
      mctx.stroke();
    }

    // Allies (for villagers) & Self
    for (const p of Object.values(world.players)) {
      if (p.state === "escaped" || p.state === "dead") continue;
      if (p.id === me.id || (me.role === "villager" && p.role === "villager")) {
        mctx.fillStyle = p.id === me.id ? "#ffffff" : p.color || "#38bdf8";
        mctx.beginPath();
        mctx.arc(p.x * sx, p.y * sy, p.id === me.id ? 3.8 : 2.8, 0, Math.PI * 2);
        mctx.fill();
      }
    }
  }

  // ===================== HUD & SCOREBOARD UPDATES =====================
  function updateHUD() {
    if (!world) return;
    const me = world.players[myId] || Object.values(world.players)[0];
    if (!me) return;

    const reqTotems = world.totemsRequired || TOTEMS_REQUIRED;
    const rem = Math.max(0, reqTotems - world.repairedCount);
    if (world.powered) {
      objTitleEl.textContent = "⚡ ÇIKIŞ KAPILARI AKTİF!";
      objTitleEl.classList.add("powered");
      objSubEl.textContent =
        me.role === "villager"
          ? "Kuzey veya Güney çıkış kapısını [E] ile aç ve ormandan kaç!"
          : "Köylüler çıkış kapılarına yöneliyor! Onları yakala!";
    } else {
      objTitleEl.textContent = `🔮 Onarılacak Tılsım: ${rem}`;
      objTitleEl.classList.remove("powered");
      objSubEl.textContent =
        me.role === "villager"
          ? "Tılsımları [E] ile onar, Kurt yaklaşınca saklan veya barikat devir."
          : "Köylüleri avla! Koşarken bıraktıkları kırmızı izleri ve patlama seslerini takip et.";
    }

    const pingText = wsConnected ? `${rttMs} ms` : "Yerel";
    perfPill.textContent = `${Math.round(fpsCounter)} FPS • ${pingText}`;

    // Survivor Status Cards
    const villagers = Object.values(world.players).filter((p) => p.role === "villager");
    hudSurvivorsEl.innerHTML = villagers
      .map((v) => {
        let cls = "";
        let icon = "❤️";
        let sub = "Sağlıklı";
        let bar = "";
        if (v.state === "escaped") {
          cls = "escaped";
          icon = "🚪";
          sub = "Kaçtı!";
        } else if (v.state === "dead") {
          cls = "dead";
          icon = "☠️";
          sub = "Kurban Edildi";
        } else if (v.state === "caged") {
          cls = "caged";
          icon = v.campProtected ? "🛡️" : "⛓️";
          const pct = clamp((v.cageTimer / 60) * 100, 0, 100);
          sub = v.campProtected
            ? `Anti-Camp Koruması (${Math.ceil(v.cageTimer)}s)`
            : `Kafeste (${Math.ceil(v.cageTimer)}s)`;
          bar = `<div class="cage-mini-bar"><div class="cage-mini-fill" style="width:${pct}%"></div></div>`;
        } else if (v.state === "carried") {
          cls = "caged";
          icon = "🐺";
          sub = "Kurt Sırtında";
        } else if (v.hp === 0) {
          cls = "downed";
          icon = "💀";
          sub = "Yerde (Sürünüyor)";
        } else if (v.hp === 1) {
          cls = "injured";
          icon = "🩸";
          sub = "Yaralı";
        }
        const meCls = v.id === me.id ? "me" : "";
        return `
          <div class="status-card ${cls} ${meCls}">
            <div class="status-icon">${icon}</div>
            <div class="status-info">
              <div class="status-name">${escapeHtml(v.name)}${v.id === me.id ? " (Sen)" : ""}</div>
              <div class="status-sub">${sub}</div>
              ${bar}
            </div>
          </div>
        `;
      })
      .join("");

    // Action prompt & Channel bar
    if (me.state === "carried") {
      const remCarry = Math.max(0, (1 - me.wiggleProgress) * CARRY_ESCAPE_DURATION);
      actionPromptEl.textContent = `⏳ Kurt Sırtındasın — Otomatik Kurtulmaya Kalan: ${remCarry.toFixed(1)} sn`;
      actionPromptEl.classList.remove("hidden");
    } else if (!me.channel) {
      const act = findNearestInteraction(me);
      if (act) {
        actionPromptEl.textContent = act.label;
        actionPromptEl.classList.remove("hidden");
      } else {
        actionPromptEl.classList.add("hidden");
      }
    } else {
      actionPromptEl.classList.add("hidden");
    }

    if (me.role === "werewolf" && me.carryingId && !me.channel) {
      const carried = world.players[me.carryingId];
      if (carried) {
        const remCarry = Math.max(0, (1 - carried.wiggleProgress) * CARRY_ESCAPE_DURATION);
        channelWrapEl.classList.remove("hidden");
        channelNameEl.textContent = `⏳ ${carried.name} Kurtulmadan Kafese Götür!`;
        channelPctEl.textContent = `${remCarry.toFixed(1)} sn`;
        channelFillEl.style.width = `${clamp(carried.wiggleProgress * 100, 0, 100)}%`;
      } else {
        channelWrapEl.classList.add("hidden");
      }
    } else if (me.channel) {
      let pct = 0;
      let label = "İşlem...";
      if (me.channel.type === "repair") {
        const t = world.totems.find((x) => x.id === me.channel.targetId);
        pct = t ? t.progress * 100 : 0;
        label = "🔮 Kutsal Tılsım Onarılıyor...";
      } else if (me.channel.type === "rescue") {
        pct = me.channel.progress * 100;
        label = "🔓 Kafes Kilidi Açılıyor...";
      } else if (me.channel.type === "heal") {
        const t = world.players[me.channel.targetId];
        pct = t ? t.healProgress * 100 : 0;
        label = "🩹 Yaralar Sarılıyor...";
      } else if (me.channel.type === "gate") {
        const g = world.gates.find((x) => x.id === me.channel.targetId);
        pct = g ? g.progress * 100 : 0;
        label = "🚪 Çıkış Kapısı Açılıyor...";
      } else if (me.channel.type === "break_pallet") {
        pct = me.channel.progress * 100;
        label = "🪵 Barikat Parçalanıyor...";
      }
      channelWrapEl.classList.remove("hidden");
      channelNameEl.textContent = label;
      channelPctEl.textContent = `${Math.floor(pct)}%`;
      channelFillEl.style.width = `${clamp(pct, 0, 100)}%`;
    } else {
      channelWrapEl.classList.add("hidden");
    }

    // Perk Diamond Slots
    if (me.role === "werewolf") {
      perkRowEl.innerHTML = `
        ${renderPerkHtml("🐾", "SOL TIK", Math.ceil(me.attackCd || 0), me.lungeTimer > 0)}
        ${renderPerkHtml("🐺", "Q", Math.ceil(me.howlCd), me.howlActiveTimer > 0)}
        ${renderPerkHtml("👁️", "R", Math.ceil(me.instinctCd), me.instinctActiveTimer > 0)}
      `;
    } else {
      perkRowEl.innerHTML = `
        ${renderPerkHtml("🔦", "Q", Math.ceil(me.flashlightCd), me.flashlightBurstTimer > 0)}
        ${renderPerkHtml("🏃", "SHIFT", 0, me.sprinting)}
      `;
    }
  }

  function renderPerkHtml(emoji, keyLabel, cdSec, active) {
    const cls = active ? "active-buff" : cdSec <= 0 ? "ready" : "";
    const cdHtml = cdSec > 0 ? `<div class="perk-cd">${cdSec}</div>` : "";
    return `
      <div class="perk-slot ${cls}">
        <div class="perk-inner">
          <div class="perk-emoji">${emoji}</div>
          <div class="perk-key">${keyLabel}</div>
        </div>
        ${cdHtml}
      </div>
    `;
  }

  function openGameOverScreen() {
    if (!world) return;
    skillCheckOverlay.classList.add("hidden");
    gameoverScreen.classList.remove("hidden");
    document.getElementById("gameover-title").textContent = world.winnerText;
    document.getElementById("gameover-subtitle").textContent = world.winnerSub;

    const rows = Object.values(world.players)
      .sort((a, b) => b.score - a.score)
      .map((p) => {
        const roleTxt = p.role === "werewolf" ? "🐺 Kurt" : "🏮 Köylü";
        const stTxt =
          p.role === "werewolf"
            ? "Avcı"
            : p.state === "escaped"
            ? "Kaçtı 🏃"
            : p.state === "dead"
            ? "Kurban Edildi ☠️"
            : "Hayatta";
        return `<tr><td>${escapeHtml(p.name)}</td><td>${roleTxt}</td><td>${stTxt}</td><td><strong>${Math.round(
          p.score
        )}</strong></td></tr>`;
      })
      .join("");
    document.getElementById("gameover-tbody").innerHTML = rows;
  }

  // ===================== MAIN GAME LOOP =====================
  function gameLoop(now) {
    if (!running || !world) return;
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    if (dt > 0) fpsCounter = fpsCounter * 0.9 + (1 / dt) * 0.1;

    // Update mouse world position (3D raycast to ground plane Y=0)
    const vw = canvas.width;
    const vh = canvas.height;
    if (renderer3d) {
      const hit = renderer3d.screenToWorld(mouse.x, mouse.y);
      mouse.worldX = hit.x;
      mouse.worldY = hit.y;
    } else {
      mouse.worldX = mouse.x + (world.camera.x - vw / 2);
      mouse.worldY = mouse.y + (world.camera.y - vh / 2);
    }

    const me = world.players[myId];

    // Local Skill Check updates (for local villager)
    if (me && me.role === "villager" && !me.isBot) {
      if (world.skillCheck) {
        if (world.skillCheck.warnDelay > 0) {
          world.skillCheck.warnDelay -= dt;
        } else {
          world.skillCheck.needle += world.skillCheck.speed * dt;
          if (world.skillCheck.needle >= 1.0) {
            resolveSkillCheck(false);
          }
        }
      } else if (me.channel && me.channel.type === "repair") {
        world.nextSkillCheckIn -= dt;
        if (world.nextSkillCheckIn <= 0) {
          world.nextSkillCheckIn = 4.8 + Math.random() * 4.5;
          triggerSkillCheck();
        }
      } else {
        world.nextSkillCheckIn = 4.0;
      }
    }

    if (isHost()) {
      updateSimulation(dt);
      if (wsConnected && now - lastSnapshotSent >= 20) {
        lastSnapshotSent = now;
        sendSnapshot();
      }
    } else if (me) {
      updateEffects(dt);
      // Smooth velocity extrapolation on remote players between 20ms snapshots
      for (const p of Object.values(world.players)) {
        if (p.id !== myId && p.state === "active" && !p.inLockerId) {
          p.x += (p.vx || 0) * dt * 0.55;
          p.y += (p.vy || 0) * dt * 0.55;
        }
      }
      // Guest client-side prediction & 50Hz input upload
      const inp = getLocalInputVector();
      if (me.state === "active" && !me.inLockerId && !me.channel && me.vaultTimer <= 0) {
        let spd = me.role === "werewolf" ? WOLF_SPEED : inp.sprint ? VILLAGER_SPRINT : VILLAGER_WALK;
        if (me.role === "villager" && me.hp === 0) spd = VILLAGER_CRAWL;
        me.x += inp.mx * spd * dt;
        me.y += inp.my * spd * dt;
        me.angle = inp.angle;
        resolveCircleCollisions(me, me.r);
      }
      if (now - lastInputSent >= 20) {
        lastInputSent = now;
        sendWS({ t: "i", ...inp });
      }
    }

    renderWorld();
    updateHUD();
    requestAnimationFrame(gameLoop);
  }

  function startMatchFromAssignments(seed, assignments, difficulty, fillBots = true) {
    audio.init();
    world = createWorld(seed, assignments, difficulty, fillBots);
    world._hasLOS = hasLineOfSight;
    rebuildStaticMapCache();
    if (renderer3d) renderer3d.buildWorld(world);

    lobbyScreen.classList.add("hidden");
    gameoverScreen.classList.add("hidden");
    gameHud.classList.remove("hidden");

    const me = world.players[myId] || Object.values(world.players)[0];
    if (me) {
      world.camera.x = me.x;
      world.camera.y = me.y;
      showToast(
        me.role === "werewolf"
          ? "🐺 Sen KURTSUN! Tüm köylüleri avla!"
          : `🏮 Sen KÖYLÜSÜN! ${world.totemsRequired || TOTEMS_REQUIRED} Tılsımı onar ve kaç!`,
        me.role === "werewolf" ? "danger" : "good"
      );
    }

    running = true;
    lastFrameTime = performance.now();
    requestAnimationFrame(gameLoop);
  }

  // ===================== INPUT BINDINGS =====================
  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  window.addEventListener("mousedown", (e) => {
    if (!running || !world || !aiModal.classList.contains("hidden")) return;
    if (e.button === 0) {
      audio.init();
      if (world.skillCheck) {
        resolveSkillCheck(true);
        return;
      }
      const me = world.players[myId];
      if (me && me.role === "werewolf") {
        if (isHost()) triggerWolfAttack(me);
        else sendWS({ t: "i", ...getLocalInputVector(), atk: 1 });
      }
    }
  });

  window.addEventListener("keydown", (e) => {
    if (document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      return;
    }
    const moveKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
    const wasDown = !!keys[e.code];
    keys[e.code] = true;
    if (!running || !world) return;

    const me = world.players[myId];
    if (!me) return;

    if (!wasDown && moveKeys.has(e.code) && !isHost() && wsConnected) {
      lastInputSent = performance.now();
      sendWS({ t: "i", ...getLocalInputVector() });
    }

    if (e.code === "Space") {
      e.preventDefault();
      if (world.skillCheck) {
        resolveSkillCheck(true);
        return;
      }
      if (me.role === "werewolf") {
        if (isHost()) triggerWolfAttack(me);
        else sendWS({ t: "i", ...getLocalInputVector(), atk: 1 });
      }
    }

    if (e.code === "KeyE" && !e.repeat) {
      const act = findNearestInteraction(me);
      if (act && !["repair", "heal", "rescue", "gate"].includes(act.type)) {
        if (isHost()) performInstantOrStartChannel(me, act);
        else sendWS({ t: "i", ...getLocalInputVector(), tapE: 1 });
      }
    }

    if (e.code === "KeyQ" && !e.repeat) {
      if (isHost()) triggerSpecialQ(me);
      else sendWS({ t: "i", ...getLocalInputVector(), q: 1 });
    }

    if (e.code === "KeyR" && !e.repeat) {
      if (isHost()) triggerSpecialR(me);
      else sendWS({ t: "i", ...getLocalInputVector(), r: 1 });
    }

    if (e.code === "KeyV" && !e.repeat) {
      toggleCameraModeUI();
    }
  });

  window.addEventListener("keyup", (e) => {
    keys[e.code] = false;
    if (
      running &&
      world &&
      !isHost() &&
      wsConnected &&
      ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"].includes(e.code)
    ) {
      lastInputSent = performance.now();
      sendWS({ t: "i", ...getLocalInputVector() });
    }
  });

  // ===================== LOBBY & MODAL UI EVENTS =====================
  document.querySelectorAll(".role-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".role-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      selectedPrefRole = card.dataset.role;
      if (wsConnected) sendWS({ t: "role", role: selectedPrefRole });
      renderLobbyRoster();
    });
  });

  playerNameInput.addEventListener("change", () => {
    if (wsConnected) sendWS({ t: "name", name: playerNameInput.value });
    renderLobbyRoster();
  });

  if (btnCreateRoom) {
    btnCreateRoom.addEventListener("click", () => {
      const fillBots = !roomModeSelect || roomModeSelect.value === "bots";
      const nm = playerNameInput.value || "Avcı";
      if (wsConnected) {
        sendWS({
          t: "create_room",
          name: nm,
          role: selectedPrefRole,
          fillBots,
        });
      } else {
        connectWebSocket();
      }
    });
  }

  btnJoinRoom.addEventListener("click", () => {
    if (wsConnected) {
      sendWS({
        t: "join",
        room: roomCodeInput.value || "KANLI-AY",
        name: playerNameInput.value || "Avcı",
        role: selectedPrefRole,
      });
    } else {
      connectWebSocket();
    }
  });

  if (btnCopyInvite) {
    btnCopyInvite.addEventListener("click", () => {
      const code = (roomCodeInput && roomCodeInput.value) || roomCode || "KANLI-AY";
      const inviteUrl = `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(inviteUrl).then(() => {
          const orig = btnCopyInvite.textContent;
          btnCopyInvite.textContent = "✅ Link Kopyalandı!";
          setTimeout(() => (btnCopyInvite.textContent = orig), 1600);
        });
      }
    });
  }

  if (roomModeSelect) {
    roomModeSelect.addEventListener("change", () => {
      roomFillBots = roomModeSelect.value === "bots";
      if (wsConnected && myId === hostId) {
        sendWS({ t: "room_settings", fillBots: roomFillBots });
      }
      renderLobbyRoster();
    });
  }

  if (botDifficultySelect) {
    botDifficultySelect.addEventListener("change", () => {
      if (wsConnected && myId === hostId) {
        sendWS({ t: "room_settings", difficulty: botDifficultySelect.value });
      }
    });
  }

  btnStartMatch.addEventListener("click", () => {
    audio.init();
    const diff = botDifficultySelect.value || "normal";
    const fillBots = !roomModeSelect || roomModeSelect.value === "bots";
    if (wsConnected) {
      sendWS({ t: "start", difficulty: diff, fillBots });
    } else {
      let role = selectedPrefRole;
      if (role === "random") role = Math.random() < 0.5 ? "werewolf" : "villager";
      const assignments = [{ id: myId, name: playerNameInput.value || "Avcı", role, isBot: false }];
      startMatchFromAssignments(Math.floor(Math.random() * 9999999), assignments, diff, true);
    }
  });

  function toggleCameraModeUI() {
    if (!renderer3d) return;
    const mode = renderer3d.toggleCameraMode();
    const btn = document.getElementById("btn-cam-mode");
    if (btn) {
      btn.textContent = mode === "angled" ? "🎥 Kamera: Açılı" : "🎥 Kamera: Tepe";
    }
  }

  const camModeBtn = document.getElementById("btn-cam-mode");
  if (camModeBtn) {
    camModeBtn.addEventListener("click", toggleCameraModeUI);
  }

  document.getElementById("btn-mute").addEventListener("click", (e) => {
    audio.init();
    audio.setMuted(!audio.muted);
    e.currentTarget.textContent = audio.muted ? "🔇 Sessiz" : "🔊 Ses";
  });

  function exitToLobby() {
    running = false;
    world = null;
    skillCheckOverlay.classList.add("hidden");
    gameHud.classList.add("hidden");
    gameoverScreen.classList.add("hidden");
    lobbyScreen.classList.remove("hidden");
    if (wsConnected && myId === hostId) sendWS({ t: "rematch" });
  }

  document.getElementById("btn-leave-match").addEventListener("click", exitToLobby);
  document.getElementById("btn-rematch").addEventListener("click", exitToLobby);

  // ===================== CUSTOM AI SPRITE UPLOAD & CHROMA KEY (ADMIN ONLY) =====================
  function setAdminState(unlocked) {
    isAdmin = !!unlocked;
    const lockArea = document.getElementById("admin-upload-area");
    const badge = document.getElementById("admin-status-badge");
    const loginControls = document.getElementById("admin-login-controls");
    const lobbyBtn = document.getElementById("btn-open-ai-lobby");
    const hudBtn = document.getElementById("btn-open-ai-hud");

    if (lockArea) lockArea.classList.toggle("admin-locked", !isAdmin);
    if (badge) {
      badge.textContent = isAdmin ? "🔓 Admin Yetkisi Aktif — Tüm oyuncular için görsel değiştirebilirsin" : "🔒 Görselleri yalnızca Admin değiştirebilir";
      badge.style.color = isAdmin ? "#86efac" : "#fca5a5";
    }
    if (loginControls) loginControls.classList.toggle("hidden", isAdmin);
    if (lobbyBtn) lobbyBtn.textContent = isAdmin ? "🎨 Admin: AI Görsel" : "🔒 Admin: AI Görsel";
    if (hudBtn) hudBtn.classList.toggle("hidden", !isAdmin);
  }

  function openAiModal() {
    setAdminState(isAdmin);
    aiModal.classList.remove("hidden");
  }
  function closeAiModal() {
    aiModal.classList.add("hidden");
  }

  document.getElementById("btn-open-ai-lobby").addEventListener("click", openAiModal);
  document.getElementById("btn-open-ai-hud").addEventListener("click", openAiModal);
  document.getElementById("btn-close-ai-modal").addEventListener("click", closeAiModal);

  const adminPassInput = document.getElementById("admin-pass-input");
  const btnAdminUnlock = document.getElementById("btn-admin-unlock");
  function submitAdminPassword() {
    const pass = adminPassInput ? adminPassInput.value : "";
    if (!pass) return;
    if (wsConnected) {
      sendWS({ t: "admin_auth", pass });
    } else if (pass === "admin123") {
      setAdminState(true);
      showToast("🔓 Admin yetkisi açıldı!", "good");
    } else {
      showToast("❌ Hatalı Admin şifresi!", "danger");
    }
  }
  if (btnAdminUnlock) btnAdminUnlock.addEventListener("click", submitAdminPassword);
  if (adminPassInput) {
    adminPassInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitAdminPassword();
    });
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.getElementById("tab-upload").classList.toggle("hidden", tab !== "upload");
      document.getElementById("tab-prompts").classList.toggle("hidden", tab !== "prompts");
    });
  });

  document.querySelectorAll(".copy-prompt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const codeEl = btn.closest(".prompt-card").querySelector(".prompt-code");
      if (codeEl && navigator.clipboard) {
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
          btn.textContent = "Kopyalandı!";
          setTimeout(() => (btn.textContent = "Kopyala"), 1400);
        });
      }
    });
  });

  function processUploadedSpriteFile(key, file) {
    if (!isAdmin) {
      showToast("🔒 Sadece Admin görsel değiştirebilir!", "danger");
      return;
    }
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = 256;
        c.height = 256;
        const cctx = c.getContext("2d");
        cctx.drawImage(img, 0, 0, 256, 256);

        const autoChroma = document.getElementById("auto-chroma-chk").checked;
        if (autoChroma && key !== "ground") {
          const imData = cctx.getImageData(0, 0, 256, 256);
          const d = imData.data;
          // Corner background sample
          const br = d[0], bg = d[1], bb = d[2];
          const isGreen = bg > 140 && bg > br * 1.35 && bg > bb * 1.35;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const distBg = Math.hypot(r - br, g - bg, b - bb);
            if ((isGreen && g - Math.max(r, b) > 36 && g > 95) || distBg < 48) {
              d[i + 3] = 0;
            }
          }
          cctx.putImageData(imData, 0, 0);
        }
        const dataUrl = c.toDataURL("image/png");
        loadSprite(key, dataUrl, true);
        if (wsConnected && isAdmin) {
          sendWS({ t: "admin_sprite", key, dataUrl });
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  document.querySelectorAll(".sprite-drop-card").forEach((card) => {
    const key = card.dataset.sprite;
    const fileInput = card.querySelector("input[type=file]");
    const triggerBtn = card.querySelector(".upload-trigger");

    triggerBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      if (fileInput.files[0]) processUploadedSpriteFile(key, fileInput.files[0]);
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      card.classList.add("dragover");
    });
    card.addEventListener("dragleave", () => card.classList.remove("dragover"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("dragover");
      if (e.dataTransfer.files[0]) processUploadedSpriteFile(key, e.dataTransfer.files[0]);
    });
  });

  document.getElementById("btn-reset-sprites").addEventListener("click", () => {
    if (!isAdmin) return;
    Object.entries(DEFAULT_SPRITE_URLS).forEach(([k, url]) => {
      try { localStorage.removeItem(`kanliay_sprite_${k}`); } catch (_) {}
      loadSprite(k, url, false);
    });
    if (wsConnected) sendWS({ t: "admin_sprite", reset: true });
  });

  // ===================== BOOTSTRAP =====================
  setAdminState(false);
  resizeCanvas();
  initSprites();
  renderLobbyRoster();
  connectWebSocket();
})();
