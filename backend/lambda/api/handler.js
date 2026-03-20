const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const LOCAL_DATA_DIR = path.join(__dirname, "data");
const MOCK_DIR = fs.existsSync(LOCAL_DATA_DIR) ? LOCAL_DATA_DIR : path.join(ROOT_DIR, "mock_api");
const ROOM_TTL_SECONDS = 60 * 60 * 24 * 3;
const STARTING_HAND_SIZE = 10;
const ADMIN_PASSCODE_HEADER = "X-Omojan-Admin-Passcode";
const DEVICE_ID_HEADER = "X-Omojan-Device-Id";
const MAX_ROOM_MEMBERS = 12;

const defaultDeck = readJson("deck_default.json").data;
const recentChampions = readJson("champions_recent.json").data.items;

let awsSdkModules = null;

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(MOCK_DIR, fileName), "utf8"));
}

function nowIso() {
  return new Date().toISOString();
}

function buildHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-omojan-player-token,x-omojan-admin-passcode,x-omojan-device-id"
  };
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: buildHeaders(),
    body: JSON.stringify(payload, null, 2)
  };
}

function ok(data) {
  return json(200, {
    ok: true,
    data,
    serverTime: nowIso()
  });
}

function fail(statusCode, code, message, retryable = false) {
  return json(statusCode, {
    ok: false,
    error: {
      code,
      message,
      retryable
    },
    serverTime: nowIso()
  });
}

function domainError(statusCode, code, message, retryable = false) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function parseBody(event) {
  if (!event.body) {
    return {};
  }
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function parseRoute(method, pathname) {
  const routes = [
    { method: "GET", pattern: /^\/v1\/health$/, route: "health" },
    { method: "GET", pattern: /^\/v1\/champions\/recent$/, route: "getChampionsRecent" },
    { method: "GET", pattern: /^\/v1\/champions\/history$/, route: "getChampionsHistory" },
    { method: "GET", pattern: /^\/v1\/champions\/ranking$/, route: "getChampionsRanking" },
    { method: "POST", pattern: /^\/v1\/champions\/([^/]+)\/like-toggle$/, route: "toggleChampionLike" },
    { method: "GET", pattern: /^\/v1\/admin\/champions$/, route: "getAdminChampions" },
    { method: "DELETE", pattern: /^\/v1\/admin\/champions\/([^/]+)$/, route: "deleteAdminChampion" },
    { method: "GET", pattern: /^\/v1\/admin\/decks\/([^/]+)$/, route: "getDeck" },
    { method: "PUT", pattern: /^\/v1\/admin\/decks\/([^/]+)$/, route: "putDeck" },
    { method: "POST", pattern: /^\/v1\/rooms$/, route: "createRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/join$/, route: "joinRoom" },
    { method: "GET", pattern: /^\/v1\/rooms\/([^/]+)$/, route: "getRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/reconnect$/, route: "reconnectRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/reveal-close$/, route: "closeReveal" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/start-player$/, route: "startPlayer" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/player-role$/, route: "setPlayerRole" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/host-transfer$/, route: "transferHost" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/start$/, route: "startGame" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/submit$/, route: "submitWord" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/vote$/, route: "submitVote" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/revote$/, route: "submitRevote" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/host-decision$/, route: "submitHostDecision" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/proceed$/, route: "proceedRound" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/final-vote$/, route: "submitFinalVote" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/final-revote$/, route: "submitFinalRevote" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/final-host-decision$/, route: "submitFinalHostDecision" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/restart$/, route: "restartGame" }
  ];

  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const match = pathname.match(route.pattern);
    if (match) {
      return { route: route.route, params: match.slice(1) };
    }
  }
  return null;
}

function normalizePathname(event) {
  const rawPath = event.rawPath || event.path || "/";
  const stage = String(event.requestContext?.stage || "").trim();
  if (!stage || stage === "$default") {
    return rawPath;
  }

  const stagePrefix = `/${stage}`;
  if (rawPath === stagePrefix) {
    return "/";
  }
  if (rawPath.startsWith(`${stagePrefix}/`)) {
    return rawPath.slice(stagePrefix.length);
  }
  return rawPath;
}

function handleHealth() {
  return ok({
    service: "omojan-api",
    mode: "lambda-scaffold",
    stage: process.env.APP_STAGE || "dev",
    tableName: process.env.APP_TABLE_NAME || "",
    region: process.env.AWS_REGION || "",
    implementedRoutes: [
      "admin:decks:get",
      "admin:decks:put",
      "admin:champions:get",
      "admin:champions:delete",
      "champions:history:get",
      "champions:ranking:get",
      "champions:like:toggle",
      "rooms:create",
      "rooms:join",
      "rooms:get",
      "rooms:reconnect",
      "rooms:reveal-close",
      "rooms:start-player",
      "rooms:player-role",
      "rooms:host-transfer",
      "rooms:start",
      "rounds:submit",
      "rounds:vote",
      "rounds:revote",
      "rounds:host-decision",
      "rounds:proceed",
      "final:vote",
      "final:revote",
      "final:host-decision",
      "rooms:restart"
    ]
  });
}

function handleGetChampionsRecent(event) {
  const requestedLimit = Number(event.queryStringParameters?.limit || "5");
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5;
  return ok({
    items: recentChampions.slice(0, limit)
  });
}

function handleGetChampionsHistory(event) {
  const requestedLimit = Number(event.queryStringParameters?.limit || "50");
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 50;
  return ok({
    items: recentChampions.slice(0, limit)
  });
}

function handleGetDeck(deckId) {
  if (deckId !== "default") {
    return fail(404, "DECK_NOT_FOUND", "指定されたデッキは存在しません。");
  }
  return ok(defaultDeck);
}

function handleNotImplemented(pathname) {
  return fail(
    501,
    "NOT_IMPLEMENTED",
    `${pathname} は Lambda 雛形のみ作成済みです。次に DynamoDB 実装を接続します。`
  );
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((headerName) => headerName.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : "";
}

function normalizeDisplayName(value) {
  return String(value || "").trim().slice(0, 20) || "あなた";
}

function normalizeDeckName(value, deckId) {
  return String(value || "").trim().slice(0, 40) || deckId;
}

function normalizePlayerCount(value) {
  const count = Number(value);
  return [2, 3, 4].includes(count) ? count : 4;
}

function normalizePlayerRole(value) {
  return value === "spectator" ? "spectator" : "player";
}

function normalizeSizePreset(value) {
  if (value === "small") {
    return "small";
  }
  return "large";
}

function normalizeLineGapPreset(value) {
  return ["none", "normal", "wide"].includes(value) ? value : "none";
}

function normalizeFontSizeHint(value) {
  const size = Number(value);
  return Number.isFinite(size) && size >= 8 ? Math.min(220, Math.round(size)) : 0;
}

function normalizeKnownRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 1 ? revision : null;
}

function normalizeDeviceId(value) {
  return String(value || "").trim().slice(0, 200);
}

function hashPlayerToken(playerToken) {
  return `sha256:${crypto.createHash("sha256").update(playerToken).digest("hex")}`;
}

function hashDeviceId(deviceId) {
  return `sha256:${crypto.createHash("sha256").update(String(deviceId || "")).digest("hex")}`;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function makeInviteCode() {
  return `OMO-${String(Math.floor(1000 + Math.random() * 9000))}`;
}

function makeTileId(index = 0) {
  const seed = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `tile_${String(index + 1).padStart(3, "0")}_${seed}`;
}

function getActivePlayers(room) {
  return (room.players || []).filter((player) => normalizePlayerRole(player.role) === "player");
}

function getSpectatorPlayers(room) {
  return (room.players || []).filter((player) => normalizePlayerRole(player.role) === "spectator");
}

function getGamePlayerCount(room) {
  return getActivePlayers(room).length;
}

function safeSecretEqual(expected, provided) {
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");
  const providedBuffer = Buffer.from(String(provided || ""), "utf8");
  if (expectedBuffer.length === 0 || expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireAdminPasscode(event, configuredPasscode) {
  if (!configuredPasscode) {
    throw domainError(503, "ADMIN_DISABLED", "管理用パスコードが未設定です。");
  }
  const providedPasscode = getHeader(event, ADMIN_PASSCODE_HEADER);
  if (!providedPasscode) {
    throw domainError(401, "ADMIN_PASSCODE_REQUIRED", "管理用パスコードが必要です。");
  }
  if (!safeSecretEqual(configuredPasscode, providedPasscode)) {
    throw domainError(403, "ADMIN_PASSCODE_INVALID", "管理用パスコードが正しくありません。");
  }
}

function buildDeckState(deckId, source = {}, version = 1) {
  return {
    deckId,
    deckName: normalizeDeckName(source.deckName || source.name, deckId),
    version: Number(source.version || version) || version,
    status: source.status === "archived" ? "archived" : "active",
    tiles: clone(source.tiles || []),
    createdAt: source.createdAt || nowIso(),
    updatedAt: source.updatedAt || nowIso()
  };
}

function normalizeDeckForStorage(deckId, payload = {}, existingDeck = null) {
  const sourceTiles = Array.isArray(payload.tiles) ? payload.tiles : [];
  const usedTileIds = new Set();
  const usedTexts = new Set();
  const normalizedTiles = sourceTiles.reduce((tiles, tile, index) => {
    const text = String(tile?.text || "").trim().slice(0, 40);
    if (!text) {
      throw domainError(400, "INVALID_TILE_TEXT", `牌 ${index + 1} のテキストが空です。`);
    }
    if (usedTexts.has(text)) {
      return tiles;
    }
    usedTexts.add(text);

    let tileId = String(tile?.tileId || "").trim().slice(0, 64).replace(/[^A-Za-z0-9_-]/g, "_");
    if (!tileId) {
      tileId = makeTileId(index);
    }
    while (usedTileIds.has(tileId)) {
      tileId = `${tileId}_${index + 1}`;
    }
    usedTileIds.add(tileId);

    tiles.push({
      tileId,
      text,
      enabled: tile?.enabled !== false
    });
    return tiles;
  }, []);

  if (!normalizedTiles.length) {
    throw domainError(400, "DECK_EMPTY", "デッキには1枚以上の牌が必要です。");
  }

  const previousDeck = existingDeck ? buildDeckState(deckId, existingDeck, 1) : buildDeckState(deckId, { deckId }, 1);
  return {
    deckId,
    deckName: normalizeDeckName(payload.deckName, deckId),
    version: previousDeck.version + 1,
    status: "active",
    tiles: normalizedTiles,
    createdAt: previousDeck.createdAt,
    updatedAt: nowIso()
  };
}

function createEmptyRounds(playerCount = 4) {
  return Array.from({ length: normalizePlayerCount(playerCount) }, (_, roundIndex) => ({
    roundIndex,
    label: `ラウンド${roundIndex + 1}`,
    wind: `ラウンド${roundIndex + 1}`,
    phaseStatus: "pending",
    submissions: [],
    votes: {},
    revotes: {},
    hostDecision: null,
    voteSummary: null,
    winner: null
  }));
}

function getPlayableDeck(deck) {
  if (!deck?.deckId) {
    throw domainError(404, "DECK_NOT_FOUND", "指定されたデッキは存在しません。");
  }

  const seenTexts = new Set();
  const enabledTiles = (deck.tiles || []).filter((tile) => {
    if (tile.enabled === false) {
      return false;
    }
    const text = String(tile.text || "").trim();
    if (!text || seenTexts.has(text)) {
      return false;
    }
    seenTexts.add(text);
    return true;
  });
  if (!enabledTiles.length) {
    throw domainError(409, "DECK_EMPTY", "使用可能な牌がデッキにありません。");
  }

  return {
    deckId: deck.deckId,
    version: deck.version || 1,
    tiles: enabledTiles
  };
}

function shuffleArray(items) {
  const shuffled = items.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function buildDrawPile(deck, totalCards) {
  if (deck.tiles.length < totalCards) {
    throw domainError(
      409,
      "DECK_TOO_SMALL",
      `このデッキは ${totalCards} 個の重複しないワードが必要です。管理画面で有効ワードを増やしてください。`
    );
  }
  return shuffleArray(deck.tiles).slice(0, totalCards);
}

function dealInitialHands(players, deck) {
  let cursor = 0;
  const hands = {};
  const totalCards = players.length * STARTING_HAND_SIZE;
  const drawPile = buildDrawPile(deck, totalCards);

  for (const player of players) {
    hands[player.playerId] = Array.from({ length: STARTING_HAND_SIZE }, (_, index) => {
      const sourceTile = drawPile[cursor];
      cursor += 1;
      return {
        tileId: `${sourceTile.tileId}__${player.playerId}_${index + 1}`,
        text: sourceTile.text,
        sourceTileId: sourceTile.tileId
      };
    });
  }

  return hands;
}

function buildStartedRoom(room, deck) {
  const playableDeck = getPlayableDeck(deck);
  const updatedRoom = clone(room);
  const playersInSeatOrder = getActivePlayers(updatedRoom).slice().sort((left, right) => left.seatOrder - right.seatOrder);
  if (playersInSeatOrder.length !== updatedRoom.playerCount) {
    throw domainError(409, "PLAYER_COUNT_NOT_READY", "参加人数がそろってから開始してください。");
  }
  const fallbackStartPlayerId = updatedRoom.hostPlayerId;
  const playerOrder =
    Array.isArray(updatedRoom.playerOrder) && updatedRoom.playerOrder.length
      ? updatedRoom.playerOrder
      : rotatePlayerOrder(
          playersInSeatOrder.map((player) => player.playerId),
          updatedRoom.startPlayerId || fallbackStartPlayerId
        );
  const startPlayerId = updatedRoom.startPlayerId || playerOrder[0] || fallbackStartPlayerId;

  updatedRoom.status = "playing";
  updatedRoom.startPlayerId = startPlayerId;
  updatedRoom.playerOrder = playerOrder;
  updatedRoom.game.deckId = playableDeck.deckId;
  updatedRoom.game.deckVersion = playableDeck.version;
  updatedRoom.game.initialHands = dealInitialHands(playersInSeatOrder, playableDeck);
  updatedRoom.game.rounds = createEmptyRounds(updatedRoom.playerCount);
  updatedRoom.game.finalVote = null;
  updatedRoom.game.champion = null;
  updatedRoom.game.reveal = null;

  updatedRoom.players = updatedRoom.players.map((player) => ({
    ...player,
    role: normalizePlayerRole(player.role),
    usedTileIds: [],
    handCount: normalizePlayerRole(player.role) === "player" ? STARTING_HAND_SIZE : 0
  }));
  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  startRound(updatedRoom, 0);

  return updatedRoom;
}

function getCurrentRound(room) {
  if (room.game?.roundIndex === null || room.game?.roundIndex === undefined) {
    return null;
  }
  return room.game.rounds?.[room.game.roundIndex] || null;
}

function getRoundPlayerOrder(room, roundIndex) {
  const baseOrder =
    Array.isArray(room.playerOrder) && room.playerOrder.length
      ? room.playerOrder
      : derivePlayerOrder(room);
  if (!baseOrder.length) {
    return [];
  }
  const offset = ((roundIndex % baseOrder.length) + baseOrder.length) % baseOrder.length;
  return [...baseOrder.slice(offset), ...baseOrder.slice(0, offset)];
}

function setReveal(updatedRoom, reveal) {
  updatedRoom.game.reveal = {
    revealId: makeId("reveal"),
    acknowledgedPlayerIds: [],
    createdAt: nowIso(),
    ...clone(reveal)
  };
}

function clearReveal(updatedRoom) {
  updatedRoom.game.reveal = null;
}

function requireNoActiveReveal(room) {
  if (room.game?.reveal) {
    throw domainError(409, "REVEAL_PENDING", "全員が公開ポップアップを閉じるまで待ってください。");
  }
}

function startRound(updatedRoom, roundIndex) {
  const roundOrder = getRoundPlayerOrder(updatedRoom, roundIndex);
  updatedRoom.game.roundIndex = roundIndex;
  updatedRoom.game.phase = "round_submit";
  updatedRoom.game.currentTurnPlayerId = roundOrder[0] || updatedRoom.startPlayerId || updatedRoom.hostPlayerId;
  updatedRoom.game.rounds[roundIndex].phaseStatus = "submit";
  updatedRoom.game.rounds[roundIndex].votes = {};
  updatedRoom.game.rounds[roundIndex].revotes = {};
  updatedRoom.game.rounds[roundIndex].hostDecision = null;
  updatedRoom.game.rounds[roundIndex].voteSummary = null;
  updatedRoom.game.rounds[roundIndex].winner = null;
  clearReveal(updatedRoom);
}

function buildPhraseFromTiles(payload, selectedTiles) {
  const tileOrder = Array.isArray(payload.tileOrder) && payload.tileOrder.length === 2 ? payload.tileOrder : [0, 1];
  const orderedTiles = tileOrder.map((index) => selectedTiles[index]).filter(Boolean);
  return orderedTiles.map((tile) => tile.text).join("");
}

function buildRenderedLines(payload, selectedTiles) {
  if (Array.isArray(payload.renderedLines) && payload.renderedLines.length) {
    return payload.renderedLines.map((line) => String(line));
  }

  const tileOrder = Array.isArray(payload.tileOrder) && payload.tileOrder.length === 2 ? payload.tileOrder : [0, 1];
  const orderedTiles = tileOrder.map((index) => selectedTiles[index]).filter(Boolean);

  if ((payload.lineMode || "boundary") === "single") {
    return [orderedTiles.map((tile) => tile.text).join("")];
  }

  return orderedTiles.map((tile) => tile.text);
}

function buildSubmittedRoom(room, mePlayer, roundIndex, payload) {
  requireNoActiveReveal(room);
  if (normalizePlayerRole(mePlayer.role) !== "player") {
    throw domainError(403, "SPECTATOR_FORBIDDEN", "観戦中は提出できません。");
  }
  if (room.game?.phase !== "round_submit") {
    throw domainError(409, "INVALID_PHASE", "round_submit ではないため実行できません。");
  }
  if (room.game?.roundIndex !== roundIndex) {
    throw domainError(409, "INVALID_PHASE", "ラウンドが一致しません。");
  }
  if (room.game?.currentTurnPlayerId !== mePlayer.playerId) {
    throw domainError(409, "NOT_YOUR_TURN", "あなたの手番ではありません。");
  }
  if (!Array.isArray(payload.tileIds) || payload.tileIds.length !== 2) {
    throw domainError(400, "INVALID_TARGET", "牌は 2 枚ちょうど選択してください。");
  }
  if (new Set(payload.tileIds).size !== 2) {
    throw domainError(400, "INVALID_TARGET", "同じ牌は 2 回選べません。");
  }

  const updatedRoom = clone(room);
  const round = getCurrentRound(updatedRoom);
  if (!round) {
    throw domainError(409, "INVALID_PHASE", "ラウンド状態が見つかりません。");
  }
  if (round.submissions.some((submission) => submission.playerId === mePlayer.playerId)) {
    throw domainError(409, "ALREADY_SUBMITTED", "すでに提出済みです。");
  }

  const updatedPlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
  const hand = updatedRoom.game?.initialHands?.[mePlayer.playerId] || [];
  const tileMap = new Map(hand.map((tile) => [tile.tileId, tile]));
  const usedTileIds = new Set(updatedPlayer.usedTileIds || []);
  const selectedTiles = payload.tileIds.map((tileId) => tileMap.get(tileId));

  if (selectedTiles.some((tile) => !tile)) {
    throw domainError(400, "INVALID_TARGET", "選択した牌は手札に存在しません。");
  }
  if (payload.tileIds.some((tileId) => usedTileIds.has(tileId))) {
    throw domainError(400, "INVALID_TARGET", "選択した牌はすでに使用済みです。");
  }

  const phrase = String(payload.phrase || buildPhraseFromTiles(payload, selectedTiles)).trim();
  if (!phrase) {
    throw domainError(400, "INVALID_TARGET", "提出ワードが空です。");
  }
  const renderedLines = buildRenderedLines(payload, selectedTiles);

  round.submissions.push({
    playerId: updatedPlayer.playerId,
    displayName: updatedPlayer.displayName,
    phrase,
    fontId: String(payload.fontId || "broadcast"),
    sizePreset: normalizeSizePreset(payload.sizePreset),
    lineGapPreset: normalizeLineGapPreset(payload.lineGapPreset),
    fontSizeHint: normalizeFontSizeHint(payload.fontSizeHint),
    renderedLines,
    submittedAt: nowIso()
  });

  updatedPlayer.usedTileIds = [...usedTileIds, ...payload.tileIds];
  updatedPlayer.handCount = Math.max(0, STARTING_HAND_SIZE - updatedPlayer.usedTileIds.length);

  const roundOrder = getRoundPlayerOrder(updatedRoom, roundIndex);
  const nextTurnPlayerId =
    roundOrder.find(
      (playerId) => !round.submissions.some((submission) => submission.playerId === playerId)
    ) || null;

  setReveal(updatedRoom, {
    kind: "submission",
    roundIndex,
    displayName: updatedPlayer.displayName,
    playerId: updatedPlayer.playerId,
    phrase,
    fontId: String(payload.fontId || "broadcast"),
    sizePreset: normalizeSizePreset(payload.sizePreset),
    lineGapPreset: normalizeLineGapPreset(payload.lineGapPreset),
    fontSizeHint: normalizeFontSizeHint(payload.fontSizeHint),
    renderedLines
  });

  if (nextTurnPlayerId) {
    updatedRoom.game.currentTurnPlayerId = nextTurnPlayerId;
    updatedRoom.game.phase = "round_submit";
    round.phaseStatus = "submit";
  } else {
    updatedRoom.game.currentTurnPlayerId = null;
    updatedRoom.game.phase = "round_vote";
    round.phaseStatus = "vote";
  }

  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;

  return updatedRoom;
}

function summarizeRoundVotes(round, validTargetIds, ballots) {
  const counts = validTargetIds.map((playerId) => {
    const submission = round.submissions.find((item) => item.playerId === playerId);
    return {
      playerId,
      displayName: submission?.displayName || playerId,
      phrase: submission?.phrase || playerId,
      count: Object.values(ballots).filter((value) => value === playerId).length
    };
  });

  const topCount = Math.max(...counts.map((item) => item.count));
  const tiedPlayerIds = counts.filter((item) => item.count === topCount).map((item) => item.playerId);
  return {
    counts,
    tiedPlayerIds,
    winnerPlayerId: tiedPlayerIds[0] || null
  };
}

function setRoundWinner(updatedRoom, round, winnerPlayerId, source, counts) {
  const submission = round.submissions.find((item) => item.playerId === winnerPlayerId);
  const countRow = counts.find((item) => item.playerId === winnerPlayerId);
  round.winner = {
    playerId: winnerPlayerId,
    displayName: submission.displayName,
    phrase: submission.phrase,
    fontId: submission.fontId,
    sizePreset: submission.sizePreset,
    lineGapPreset: submission.lineGapPreset,
    fontSizeHint: submission.fontSizeHint,
    renderedLines: submission.renderedLines,
    voteCount: countRow?.count || 0,
    source
  };
  round.phaseStatus = "finished";
  round.voteSummary = {
    counts,
    tiedPlayerIds: []
  };
  updatedRoom.game.phase = "round_result";
  updatedRoom.game.currentTurnPlayerId = null;
  setReveal(updatedRoom, {
    kind: "round_winner",
    roundIndex: round.roundIndex,
    displayName: submission.displayName,
    playerId: winnerPlayerId,
    phrase: submission.phrase,
    fontId: submission.fontId,
    sizePreset: submission.sizePreset,
    lineGapPreset: submission.lineGapPreset,
    fontSizeHint: submission.fontSizeHint,
    renderedLines: submission.renderedLines
  });
}

function summarizeFinalVotes(finalVote, validTargetIds, ballots) {
  const counts = validTargetIds.map((candidateId) => {
    const candidate = finalVote.candidates.find((item) => item.candidateId === candidateId);
    return {
      candidateId,
      displayName: candidate?.displayName || candidateId,
      phrase: candidate?.phrase || candidateId,
      count: Object.values(ballots).filter((value) => value === candidateId).length
    };
  });

  const topCount = Math.max(...counts.map((item) => item.count));
  const tiedCandidateIds = counts.filter((item) => item.count === topCount).map((item) => item.candidateId);
  return {
    counts,
    tiedCandidateIds,
    winnerCandidateId: tiedCandidateIds[0] || null
  };
}

function setFinalWinner(updatedRoom, finalVote, winnerCandidateId, source, counts) {
  const candidate = finalVote.candidates.find((item) => item.candidateId === winnerCandidateId);
  const countRow = counts.find((item) => item.candidateId === winnerCandidateId);
  finalVote.voteSummary = {
    counts,
    tiedCandidateIds: []
  };
  finalVote.winner = {
    playerId: candidate.playerId,
    displayName: candidate.displayName,
    phrase: candidate.phrase,
    fontId: candidate.fontId,
    sizePreset: candidate.sizePreset,
    lineGapPreset: candidate.lineGapPreset,
    fontSizeHint: candidate.fontSizeHint,
    renderedLines: candidate.renderedLines,
    voteCount: countRow?.count || 0,
    source
  };
  finalVote.phaseStatus = "finished";
  updatedRoom.game.champion = clone(finalVote.winner);
  updatedRoom.game.phase = "final_result";
  updatedRoom.game.currentTurnPlayerId = null;
  updatedRoom.status = "finished";
  setReveal(updatedRoom, {
    kind: "champion",
    roundIndex: null,
    displayName: candidate.displayName,
    playerId: candidate.playerId,
    phrase: candidate.phrase,
    fontId: candidate.fontId,
    sizePreset: candidate.sizePreset,
    lineGapPreset: candidate.lineGapPreset,
    fontSizeHint: candidate.fontSizeHint,
    renderedLines: candidate.renderedLines
  });
}

function buildChampionHistoryEntry(room) {
  const champion = room.game?.champion;
  if (!champion) {
    return null;
  }

  const wonAt = room.updatedAt || nowIso();
  const compactWonAt = wonAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  return {
    PK: "CHAMPIONS",
    SK: `TS#${wonAt}#ROOM#${room.roomId}`,
    entityType: "ChampionHistory",
    championId: `ch_${compactWonAt}_${room.roomId.slice(-8)}`,
    roomId: room.roomId,
    inviteCode: room.inviteCode,
    playerId: champion.playerId,
    displayName: champion.displayName,
    phrase: champion.phrase,
    fontId: champion.fontId,
    sizePreset: champion.sizePreset,
    lineGapPreset: champion.lineGapPreset,
    fontSizeHint: champion.fontSizeHint,
    renderedLines: clone(champion.renderedLines || []),
    likeCount: 0,
    wonAt,
    createdAt: wonAt
  };
}

function buildSeedChampionHistoryEntry(item) {
  return {
    PK: "CHAMPIONS",
    SK: `TS#${item.wonAt}#SEED#${item.championId}`,
    entityType: "ChampionHistory",
    championId: item.championId,
    roomId: "",
    inviteCode: "",
    playerId: "",
    displayName: item.displayName,
    phrase: item.phrase,
    fontId: item.fontId || "classic",
    sizePreset: normalizeSizePreset(item.sizePreset),
    lineGapPreset: normalizeLineGapPreset(item.lineGapPreset),
    fontSizeHint: normalizeFontSizeHint(item.fontSizeHint),
    renderedLines: clone(item.renderedLines || [item.phrase]),
    likeCount: Math.max(0, Number(item.likeCount || 0)),
    wonAt: item.wonAt,
    createdAt: item.wonAt
  };
}

function buildChampionLikeItem(championId, deviceIdHash, issuedAt = nowIso()) {
  return {
    PK: `CHAMPION#${championId}`,
    SK: `LIKE#${deviceIdHash}`,
    entityType: "ChampionLike",
    championId,
    deviceIdHash,
    createdAt: issuedAt
  };
}

function toChampionHistoryView(item, options = {}) {
  const likedChampionIds = options.likedChampionIds || null;
  return {
    championId: item.championId,
    phrase: item.phrase,
    displayName: item.displayName,
    wonAt: item.wonAt,
    fontId: item.fontId || "classic",
    sizePreset: normalizeSizePreset(item.sizePreset),
    lineGapPreset: normalizeLineGapPreset(item.lineGapPreset),
    fontSizeHint: normalizeFontSizeHint(item.fontSizeHint),
    renderedLines: clone(item.renderedLines || [item.phrase]),
    likeCount: Math.max(0, Number(item.likeCount || 0)),
    likedByMe: likedChampionIds ? likedChampionIds.has(item.championId) : Boolean(item.likedByMe),
    roomId: item.roomId || "",
    inviteCode: item.inviteCode || ""
  };
}

function getChampionWonAtRank(item) {
  const timestamp = Date.parse(item?.wonAt || "");
  return Number.isFinite(timestamp) ? timestamp : -1;
}

function compareChampionRank(left, right) {
  const likeDelta = Math.max(0, Number(right.likeCount || 0)) - Math.max(0, Number(left.likeCount || 0));
  if (likeDelta !== 0) {
    return likeDelta;
  }

  const wonAtDelta = getChampionWonAtRank(right) - getChampionWonAtRank(left);
  if (wonAtDelta !== 0) {
    return wonAtDelta;
  }

  return String(left.championId || "").localeCompare(String(right.championId || ""));
}

function buildRecentChampionItems(historyItems, limit, options = {}) {
  const merged = [];
  const seen = new Set();

  for (const item of historyItems) {
    const normalized = toChampionHistoryView(item, options);
    if (seen.has(normalized.championId)) {
      continue;
    }
    seen.add(normalized.championId);
    merged.push(normalized);
    if (merged.length >= limit) {
      return merged;
    }
  }

  for (const item of recentChampions) {
    if (seen.has(item.championId)) {
      continue;
    }
    seen.add(item.championId);
    merged.push(toChampionHistoryView(buildSeedChampionHistoryEntry(item), options));
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

function buildChampionHistoryViews(historyItems, limit, options = {}) {
  return historyItems.slice(0, Math.max(limit, 1)).map((item) => toChampionHistoryView(item, options));
}

function buildChampionRankingViews(historyItems, limit, options = {}) {
  return historyItems
    .slice()
    .sort(compareChampionRank)
    .slice(0, Math.max(limit, 1))
    .map((item) => toChampionHistoryView(item, options));
}

function createRoomMember(params) {
  return {
    playerId: params.playerId,
    displayName: params.displayName,
    isHost: Boolean(params.isHost),
    role: normalizePlayerRole(params.role),
    seatOrder: params.seatOrder,
    joinedAt: params.joinedAt,
    isConnected: true,
    playerTokenHash: params.playerTokenHash,
    lastSeenAt: params.joinedAt,
    usedTileIds: [],
    handCount: 0
  };
}

function buildVotedRoom(room, mePlayer, roundIndex, targetPlayerId, mode = "vote") {
  requireNoActiveReveal(room);
  const expectedPhase = mode === "revote" ? "round_revote" : "round_vote";
  if (room.game?.phase !== expectedPhase) {
    throw domainError(409, "INVALID_PHASE", `${expectedPhase} ではないため実行できません。`);
  }
  if (room.game?.roundIndex !== roundIndex) {
    throw domainError(409, "INVALID_PHASE", "ラウンドが一致しません。");
  }

  const updatedRoom = clone(room);
  const round = getCurrentRound(updatedRoom);
  if (!round) {
    throw domainError(409, "INVALID_PHASE", "ラウンド状態が見つかりません。");
  }

  const ballotKey = mode === "revote" ? "revotes" : "votes";
  const existingBallots = round[ballotKey] || {};

  const validTargetIds =
    mode === "revote" ? round.voteSummary?.tiedPlayerIds || [] : round.submissions.map((submission) => submission.playerId);
  if (!validTargetIds.includes(targetPlayerId)) {
    throw domainError(400, "INVALID_TARGET", "投票先が不正です。");
  }
  if (targetPlayerId === mePlayer.playerId && getGamePlayerCount(room) !== 2) {
    throw domainError(409, "SELF_VOTE_FORBIDDEN", "自分のワードには投票できません。");
  }

  round[ballotKey] = {
    ...existingBallots,
    [mePlayer.playerId]: targetPlayerId
  };

  const expectedVoterCount = getGamePlayerCount(updatedRoom);
  if (Object.keys(round[ballotKey]).length < expectedVoterCount) {
    updatedRoom.updatedAt = nowIso();
    updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
    updatedRoom.revision += 1;
    return updatedRoom;
  }

  const summary = summarizeRoundVotes(round, validTargetIds, round[ballotKey]);
  round.voteSummary = {
    counts: summary.counts,
    tiedPlayerIds: summary.tiedPlayerIds.length > 1 ? summary.tiedPlayerIds : []
  };

  if (summary.tiedPlayerIds.length > 1) {
    updatedRoom.game.phase = mode === "revote" ? "round_host_decide" : "round_revote";
    updatedRoom.game.currentTurnPlayerId = null;
    round.phaseStatus = mode === "revote" ? "host_decide" : "revote";
    if (mode === "vote") {
      round.revotes = {};
    }
  } else {
    setRoundWinner(updatedRoom, round, summary.winnerPlayerId, mode === "revote" ? "revote" : "initial", summary.counts);
  }

  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  return updatedRoom;
}

function buildHostDecisionRoom(room, mePlayer, roundIndex, winnerPlayerId) {
  requireNoActiveReveal(room);
  if (normalizePlayerRole(mePlayer.role) !== "player") {
    throw domainError(403, "SPECTATOR_FORBIDDEN", "観戦中は裁定できません。");
  }
  if (room.game?.phase !== "round_host_decide") {
    throw domainError(409, "INVALID_PHASE", "round_host_decide ではないため実行できません。");
  }
  if (!mePlayer.isHost) {
    throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
  }
  if (room.game?.roundIndex !== roundIndex) {
    throw domainError(409, "INVALID_PHASE", "ラウンドが一致しません。");
  }

  const updatedRoom = clone(room);
  const round = getCurrentRound(updatedRoom);
  if (!round) {
    throw domainError(409, "INVALID_PHASE", "ラウンド状態が見つかりません。");
  }
  const tiedPlayerIds = round.voteSummary?.tiedPlayerIds || [];
  if (!tiedPlayerIds.includes(winnerPlayerId)) {
    throw domainError(400, "INVALID_TARGET", "裁定対象が不正です。");
  }

  round.hostDecision = winnerPlayerId;
  setRoundWinner(updatedRoom, round, winnerPlayerId, "host_decide", round.voteSummary?.counts || []);
  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  return updatedRoom;
}

function beginFinalVote(updatedRoom) {
  updatedRoom.game.phase = "final_vote";
  updatedRoom.game.currentTurnPlayerId = null;
  clearReveal(updatedRoom);
  updatedRoom.game.finalVote = {
    phaseStatus: "vote",
    candidates: updatedRoom.game.rounds.map((round) => ({
      candidateId: `final_round${round.roundIndex + 1}`,
      roundIndex: round.roundIndex,
      playerId: round.winner.playerId,
      displayName: round.winner.displayName,
      phrase: round.winner.phrase,
      fontId: round.winner.fontId,
      sizePreset: round.winner.sizePreset,
      lineGapPreset: round.winner.lineGapPreset,
      fontSizeHint: round.winner.fontSizeHint,
      renderedLines: round.winner.renderedLines
    })),
    votes: {},
    revotes: {},
    hostDecision: null,
    voteSummary: null,
    winner: null
  };
}

function getEligibleFinalVoterIds(finalVote, players, mode = "vote") {
  const activePlayers = players.filter((player) => normalizePlayerRole(player.role) === "player");
  if (activePlayers.length === 2) {
    return activePlayers.map((player) => player.playerId);
  }
  const validTargetIds =
    mode === "revote" ? finalVote.voteSummary?.tiedCandidateIds || [] : finalVote.candidates.map((candidate) => candidate.candidateId);
  const validCandidates = finalVote.candidates.filter((candidate) => validTargetIds.includes(candidate.candidateId));
  return activePlayers
    .filter((player) => validCandidates.some((candidate) => candidate.playerId !== player.playerId))
    .map((player) => player.playerId);
}

function buildFinalVotedRoom(room, mePlayer, candidateId, mode = "vote") {
  requireNoActiveReveal(room);
  if (normalizePlayerRole(mePlayer.role) !== "player") {
    throw domainError(403, "SPECTATOR_FORBIDDEN", "観戦中は投票できません。");
  }
  const expectedPhase = mode === "revote" ? "final_revote" : "final_vote";
  if (room.game?.phase !== expectedPhase) {
    throw domainError(409, "INVALID_PHASE", `${expectedPhase} ではないため実行できません。`);
  }

  const updatedRoom = clone(room);
  const finalVote = updatedRoom.game.finalVote;
  if (!finalVote) {
    throw domainError(409, "INVALID_PHASE", "最終投票候補が存在しません。");
  }

  const ballotKey = mode === "revote" ? "revotes" : "votes";
  const existingBallots = finalVote[ballotKey] || {};

  const validTargetIds =
    mode === "revote" ? finalVote.voteSummary?.tiedCandidateIds || [] : finalVote.candidates.map((candidate) => candidate.candidateId);
  const selectedCandidate = finalVote.candidates.find((candidate) => candidate.candidateId === candidateId);
  if (!validTargetIds.includes(candidateId) || !selectedCandidate) {
    throw domainError(400, "INVALID_TARGET", "投票先が不正です。");
  }
  if (selectedCandidate.playerId === mePlayer.playerId && getGamePlayerCount(updatedRoom) !== 2) {
    throw domainError(409, "SELF_VOTE_FORBIDDEN", "自分のワードには投票できません。");
  }

  finalVote[ballotKey] = {
    ...existingBallots,
    [mePlayer.playerId]: candidateId
  };

  const expectedVoterCount = getEligibleFinalVoterIds(finalVote, updatedRoom.players, mode).length;
  if (Object.keys(finalVote[ballotKey]).length < expectedVoterCount) {
    updatedRoom.updatedAt = nowIso();
    updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
    updatedRoom.revision += 1;
    return updatedRoom;
  }

  const summary = summarizeFinalVotes(finalVote, validTargetIds, finalVote[ballotKey]);
  finalVote.voteSummary = {
    counts: summary.counts,
    tiedCandidateIds: summary.tiedCandidateIds.length > 1 ? summary.tiedCandidateIds : []
  };

  if (summary.tiedCandidateIds.length > 1) {
    updatedRoom.game.phase = mode === "revote" ? "final_host_decide" : "final_revote";
    updatedRoom.game.currentTurnPlayerId = null;
    finalVote.phaseStatus = mode === "revote" ? "host_decide" : "revote";
    if (mode === "vote") {
      finalVote.revotes = {};
    }
  } else {
    setFinalWinner(updatedRoom, finalVote, summary.winnerCandidateId, mode === "revote" ? "revote" : "initial", summary.counts);
  }

  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  return updatedRoom;
}

function buildFinalHostDecisionRoom(room, mePlayer, candidateId) {
  requireNoActiveReveal(room);
  if (normalizePlayerRole(mePlayer.role) !== "player") {
    throw domainError(403, "SPECTATOR_FORBIDDEN", "観戦中は裁定できません。");
  }
  if (room.game?.phase !== "final_host_decide") {
    throw domainError(409, "INVALID_PHASE", "final_host_decide ではないため実行できません。");
  }
  if (!mePlayer.isHost) {
    throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
  }

  const updatedRoom = clone(room);
  const finalVote = updatedRoom.game.finalVote;
  if (!finalVote) {
    throw domainError(409, "INVALID_PHASE", "最終投票候補が存在しません。");
  }
  const tiedCandidateIds = finalVote.voteSummary?.tiedCandidateIds || [];
  if (!tiedCandidateIds.includes(candidateId)) {
    throw domainError(400, "INVALID_TARGET", "裁定対象が不正です。");
  }

  finalVote.hostDecision = candidateId;
  setFinalWinner(updatedRoom, finalVote, candidateId, "host_decide", finalVote.voteSummary?.counts || []);
  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  return updatedRoom;
}

function buildRestartedRoom(room, mePlayer) {
  requireNoActiveReveal(room);
  if (normalizePlayerRole(mePlayer.role) !== "player") {
    throw domainError(403, "SPECTATOR_FORBIDDEN", "観戦中は再開できません。");
  }
  if (!mePlayer.isHost) {
    throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
  }
  if (room.game?.phase !== "final_result") {
    throw domainError(409, "INVALID_PHASE", "final_result ではないため実行できません。");
  }

  const updatedRoom = clone(room);
  updatedRoom.status = "lobby";
  updatedRoom.startPlayerId = null;
  updatedRoom.playerOrder = getActivePlayers(updatedRoom)
    .slice()
    .sort((left, right) => left.seatOrder - right.seatOrder)
    .map((player) => player.playerId);
  updatedRoom.players = updatedRoom.players.map((player) => ({
    ...player,
    usedTileIds: [],
    handCount: 0
  }));
  updatedRoom.game = {
    phase: "lobby",
    roundIndex: null,
      currentTurnPlayerId: null,
      deckId: null,
      deckVersion: null,
      initialHands: {},
      rounds: createEmptyRounds(room.playerCount),
      finalVote: null,
      champion: null,
      reveal: null
    };
  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  return updatedRoom;
}

function buildProceedRoom(room, mePlayer, roundIndex) {
  requireNoActiveReveal(room);
  if (normalizePlayerRole(mePlayer.role) !== "player") {
    throw domainError(403, "SPECTATOR_FORBIDDEN", "観戦中は進行できません。");
  }
  if (room.game?.phase !== "round_result") {
    throw domainError(409, "INVALID_PHASE", "round_result ではないため実行できません。");
  }
  if (!mePlayer.isHost) {
    throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
  }
  if (room.game?.roundIndex !== roundIndex) {
    throw domainError(409, "INVALID_PHASE", "ラウンドが一致しません。");
  }

  const updatedRoom = clone(room);
  if (roundIndex < updatedRoom.game.rounds.length - 1) {
    startRound(updatedRoom, roundIndex + 1);
  } else {
    beginFinalVote(updatedRoom);
  }
  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  return updatedRoom;
}

function buildClosedRevealRoom(room, mePlayer, revealId = "") {
  const currentReveal = room.game?.reveal;
  if (!currentReveal) {
    return { room: clone(room), changed: false };
  }
  if (revealId && currentReveal.revealId && currentReveal.revealId !== revealId) {
    return { room: clone(room), changed: false };
  }

  const updatedRoom = clone(room);
  const reveal = updatedRoom.game.reveal;
  const acknowledgedPlayerIds = new Set(reveal.acknowledgedPlayerIds || []);
  if (acknowledgedPlayerIds.has(mePlayer.playerId)) {
    return { room: updatedRoom, changed: false };
  }
  acknowledgedPlayerIds.add(mePlayer.playerId);

  const requiredPlayerIds = getActivePlayers(updatedRoom).map((player) => player.playerId);
  if (requiredPlayerIds.every((playerId) => acknowledgedPlayerIds.has(playerId))) {
    clearReveal(updatedRoom);
  } else {
    reveal.acknowledgedPlayerIds = [...acknowledgedPlayerIds];
  }

  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  return { room: updatedRoom, changed: true };
}

function createRoomState(params) {
  const { roomId, inviteCode, displayName, playerCount, playerId, playerTokenHash, issuedAt } = params;
  const expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;

  return {
    PK: `ROOM#${roomId}`,
    SK: "STATE",
    entityType: "RoomState",
    roomId,
    inviteCode,
    revision: 1,
    status: "lobby",
    hostPlayerId: playerId,
    playerCount,
    startPlayerId: null,
    playerOrder: [playerId],
    players: [createRoomMember({ playerId, displayName, isHost: true, role: "player", seatOrder: 1, joinedAt: issuedAt, playerTokenHash })],
    game: {
      phase: "lobby",
      roundIndex: null,
      currentTurnPlayerId: null,
      deckId: null,
      deckVersion: null,
      initialHands: {},
      rounds: createEmptyRounds(playerCount),
      finalVote: null,
      champion: null,
      reveal: null
    },
    createdAt: issuedAt,
    updatedAt: issuedAt,
    expiresAt
  };
}

function createInviteLookup(room) {
  return {
    PK: `INVITE#${room.inviteCode}`,
    SK: `ROOM#${room.roomId}`,
    entityType: "InviteLookup",
    roomId: room.roomId,
    inviteCode: room.inviteCode,
    status: room.status,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    expiresAt: room.expiresAt
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPlayerByToken(room, playerToken) {
  const playerTokenHash = hashPlayerToken(playerToken);
  return room.players.find((player) => player.playerTokenHash === playerTokenHash) || null;
}

function rotatePlayerOrder(playerIds, startPlayerId) {
  const startIndex = playerIds.indexOf(startPlayerId);
  if (startIndex === -1) {
    return playerIds;
  }
  return [...playerIds.slice(startIndex), ...playerIds.slice(0, startIndex)];
}

function derivePlayerOrder(room) {
  const playerIds = getActivePlayers(room)
    .sort((left, right) => left.seatOrder - right.seatOrder)
    .map((player) => player.playerId);

  if (room.startPlayerId) {
    return rotatePlayerOrder(playerIds, room.startPlayerId);
  }
  return playerIds;
}

function toPlayerView(player) {
  return {
    playerId: player.playerId,
    displayName: player.displayName,
    isHost: player.isHost,
    role: normalizePlayerRole(player.role),
    seatOrder: player.seatOrder,
    isConnected: Boolean(player.isConnected),
    handCount: Number(player.handCount || 0),
    usedTileIds: Array.isArray(player.usedTileIds) ? player.usedTileIds : []
  };
}

function buildMyHand(room, mePlayer) {
  if (normalizePlayerRole(mePlayer.role) !== "player") {
    return [];
  }
  const initialHands = room.game?.initialHands?.[mePlayer.playerId] || [];
  const usedTileIds = new Set(mePlayer.usedTileIds || []);
  return initialHands.map((tile) => ({
    tileId: tile.tileId,
    text: tile.text,
    isUsed: usedTileIds.has(tile.tileId)
  }));
}

function toRoundView(round, mePlayer) {
  return {
    roundIndex: round.roundIndex,
    label: round.label,
    wind: round.wind,
    phaseStatus: round.phaseStatus,
    submissions: clone(round.submissions || []),
    voteSummary: round.voteSummary ? clone(round.voteSummary) : null,
    winner: round.winner ? clone(round.winner) : null,
    votedPlayerIds: Object.keys(round.votes || {}),
    revotedPlayerIds: Object.keys(round.revotes || {}),
    myVoteTargetId: mePlayer ? round.votes?.[mePlayer.playerId] || "" : "",
    myRevoteTargetId: mePlayer ? round.revotes?.[mePlayer.playerId] || "" : ""
  };
}

function toFinalVoteView(finalVote, mePlayer) {
  if (!finalVote) {
    return null;
  }
  return {
    phaseStatus: finalVote.phaseStatus,
    candidates: clone(finalVote.candidates || []),
    voteSummary: finalVote.voteSummary ? clone(finalVote.voteSummary) : null,
    winner: finalVote.winner ? clone(finalVote.winner) : null,
    votedPlayerIds: Object.keys(finalVote.votes || {}),
    revotedPlayerIds: Object.keys(finalVote.revotes || {}),
    myVoteCandidateId: mePlayer ? finalVote.votes?.[mePlayer.playerId] || "" : "",
    myRevoteCandidateId: mePlayer ? finalVote.revotes?.[mePlayer.playerId] || "" : ""
  };
}

function toRevealView(reveal) {
  if (!reveal) {
    return null;
  }
  return {
    revealId: reveal.revealId,
    kind: reveal.kind,
    roundIndex: reveal.roundIndex ?? null,
    displayName: reveal.displayName,
    playerId: reveal.playerId,
    phrase: reveal.phrase,
    fontId: reveal.fontId,
    sizePreset: normalizeSizePreset(reveal.sizePreset),
    lineGapPreset: normalizeLineGapPreset(reveal.lineGapPreset),
    fontSizeHint: normalizeFontSizeHint(reveal.fontSizeHint),
    renderedLines: clone(reveal.renderedLines || []),
    acknowledgedPlayerIds: clone(reveal.acknowledgedPlayerIds || [])
  };
}

function mapRoomResponse(room, mePlayer) {
  const players = [...room.players]
    .map((player) => ({ ...player, role: normalizePlayerRole(player.role) }))
    .sort((left, right) => left.seatOrder - right.seatOrder);
  const activePlayers = players.filter((player) => player.role === "player");
  const spectatorPlayers = players.filter((player) => player.role === "spectator");
  return {
    roomId: room.roomId,
    inviteCode: room.inviteCode,
    revision: room.revision,
    status: room.status,
    hostPlayerId: room.hostPlayerId,
    playerCount: room.playerCount,
    activePlayerCount: activePlayers.length,
    spectatorCount: spectatorPlayers.length,
    startPlayerId: room.startPlayerId,
    playerOrder: Array.isArray(room.playerOrder) && room.playerOrder.length ? room.playerOrder : derivePlayerOrder(room),
    game: {
      phase: room.game?.phase || "lobby",
      roundIndex: room.game?.roundIndex ?? null,
      currentTurnPlayerId: room.game?.currentTurnPlayerId ?? null,
      players: players.map(toPlayerView),
      activePlayerIds: activePlayers.map((player) => player.playerId),
      spectatorPlayerIds: spectatorPlayers.map((player) => player.playerId),
      rounds: Array.isArray(room.game?.rounds) ? room.game.rounds.map((round) => toRoundView(round, mePlayer)) : createEmptyRounds(room.playerCount).map((round) => toRoundView(round, mePlayer)),
      finalVote: toFinalVoteView(room.game?.finalVote, mePlayer),
      champion: room.game?.champion ? clone(room.game.champion) : null,
      reveal: toRevealView(room.game?.reveal)
    },
    me: {
      playerId: mePlayer.playerId,
      displayName: mePlayer.displayName,
      isHost: mePlayer.isHost,
      role: normalizePlayerRole(mePlayer.role),
      isSpectator: normalizePlayerRole(mePlayer.role) === "spectator",
      reconnectTokenIssued: true
    },
    myHand: buildMyHand(room, mePlayer)
  };
}

function toRoomPayload(room, mePlayer, playerToken = null) {
  const payload = {
    room: mapRoomResponse(room, mePlayer)
  };
  if (playerToken) {
    payload.playerToken = playerToken;
  }
  return payload;
}

function toConditionalFailure(error) {
  return (
    error &&
    (error.name === "ConditionalCheckFailedException" ||
      error.code === "ConditionalCheckFailedException" ||
      error.name === "TransactionCanceledException" ||
      error.code === "TransactionCanceledException")
  );
}

async function loadAwsSdkModules() {
  if (!awsSdkModules) {
    const dynamodb = require("@aws-sdk/client-dynamodb");
    const dynamodbDocument = require("@aws-sdk/lib-dynamodb");
    awsSdkModules = {
      DynamoDBClient: dynamodb.DynamoDBClient,
      DynamoDBDocumentClient: dynamodbDocument.DynamoDBDocumentClient,
      DeleteCommand: dynamodbDocument.DeleteCommand,
      GetCommand: dynamodbDocument.GetCommand,
      PutCommand: dynamodbDocument.PutCommand,
      QueryCommand: dynamodbDocument.QueryCommand,
      TransactWriteCommand: dynamodbDocument.TransactWriteCommand
    };
  }
  return awsSdkModules;
}

async function createDynamoRoomRepository(options = {}) {
  const modules = await loadAwsSdkModules();
  const tableName = options.tableName || process.env.APP_TABLE_NAME || "OmojanApp";
  const client = options.client || new modules.DynamoDBClient({});
  const documentClient =
    options.documentClient ||
    modules.DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true
      }
    });

  async function getRoomItem(roomId) {
    const response = await documentClient.send(
      new modules.GetCommand({
        TableName: tableName,
        Key: {
          PK: `ROOM#${roomId}`,
          SK: "STATE"
        }
      })
    );
    return response.Item || null;
  }

  async function putRoomItem(room, expectedRevision) {
    const command = new modules.PutCommand({
      TableName: tableName,
      Item: room,
      ConditionExpression:
        expectedRevision === null ? "attribute_not_exists(PK)" : "#revision = :expectedRevision",
      ExpressionAttributeNames: expectedRevision === null ? undefined : { "#revision": "revision" },
      ExpressionAttributeValues: expectedRevision === null ? undefined : { ":expectedRevision": expectedRevision }
    });
    await documentClient.send(command);
  }

  async function findInvite(inviteCode) {
    const response = await documentClient.send(
      new modules.QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": `INVITE#${inviteCode}`
        },
        Limit: 1
      })
    );
    return response.Items?.[0] || null;
  }

  async function queryChampionHistory(limit) {
    const response = await documentClient.send(
      new modules.QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": "CHAMPIONS"
        },
        ScanIndexForward: false,
        Limit: Math.max(limit, 1)
      })
    );
    return response.Items || [];
  }

  async function queryAllChampionHistory() {
    const items = [];
    let exclusiveStartKey;

    do {
      const response = await documentClient.send(
        new modules.QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: {
            ":pk": "CHAMPIONS"
          },
          ScanIndexForward: false,
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      items.push(...(response.Items || []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return items;
  }

  async function findChampionHistoryItemById(championId) {
    let exclusiveStartKey;

    do {
      const response = await documentClient.send(
        new modules.QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk",
          FilterExpression: "championId = :championId",
          ExpressionAttributeValues: {
            ":pk": "CHAMPIONS",
            ":championId": championId
          },
          ScanIndexForward: false,
          Limit: 50,
          ExclusiveStartKey: exclusiveStartKey
        })
      );

      if (response.Items?.[0]) {
        return response.Items[0];
      }
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return null;
  }

  async function getChampionLikeItem(championId, deviceIdHash) {
    if (!championId || !deviceIdHash) {
      return null;
    }
    const response = await documentClient.send(
      new modules.GetCommand({
        TableName: tableName,
        Key: {
          PK: `CHAMPION#${championId}`,
          SK: `LIKE#${deviceIdHash}`
        }
      })
    );
    return response.Item || null;
  }

  async function queryChampionLikeItems(championId) {
    const items = [];
    let exclusiveStartKey;

    do {
      const response = await documentClient.send(
        new modules.QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: {
            ":pk": `CHAMPION#${championId}`
          },
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      items.push(...(response.Items || []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return items;
  }

  async function resolveLikedChampionIds(championIds, deviceIdHash) {
    if (!deviceIdHash || !Array.isArray(championIds) || !championIds.length) {
      return new Set();
    }

    const liked = await Promise.all(
      championIds.map(async (championId) => {
        const item = await getChampionLikeItem(championId, deviceIdHash);
        return item ? championId : null;
      })
    );

    return new Set(liked.filter(Boolean));
  }

  async function ensureChampionHistoryItem(championId) {
    const existingItem = await findChampionHistoryItemById(championId);
    if (existingItem) {
      return existingItem;
    }

    const seedItem = recentChampions.find((item) => item.championId === championId);
    if (!seedItem) {
      return null;
    }

    const championItem = buildSeedChampionHistoryEntry(seedItem);
    try {
      await documentClient.send(
        new modules.PutCommand({
          TableName: tableName,
          Item: championItem,
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
        })
      );
      return championItem;
    } catch (error) {
      if (!toConditionalFailure(error)) {
        throw error;
      }
      return findChampionHistoryItemById(championId);
    }
  }

  async function getPersistedDeckItem(deckId) {
    const response = await documentClient.send(
      new modules.GetCommand({
        TableName: tableName,
        Key: {
          PK: `DECK#${deckId}`,
          SK: "META"
        }
      })
    );
    return response.Item || null;
  }

  async function getDeckItem(deckId) {
    const persistedItem = await getPersistedDeckItem(deckId);
    if (persistedItem) {
      return persistedItem;
    }
    if (deckId === defaultDeck.deckId) {
      return {
        PK: `DECK#${deckId}`,
        SK: "META",
        entityType: "Deck",
        ...buildDeckState(deckId, defaultDeck, defaultDeck.version || 1)
      };
    }
    return null;
  }

  async function putDeckItem(deck, expectedVersion) {
    await documentClient.send(
      new modules.PutCommand({
        TableName: tableName,
        Item: {
          PK: `DECK#${deck.deckId}`,
          SK: "META",
          entityType: "Deck",
          ...deck
        },
        ConditionExpression:
          expectedVersion === null ? "attribute_not_exists(PK)" : "#version = :expectedVersion",
        ExpressionAttributeNames: expectedVersion === null ? undefined : { "#version": "version" },
        ExpressionAttributeValues: expectedVersion === null ? undefined : { ":expectedVersion": expectedVersion }
      })
    );
  }

  return {
    async getDeck(deckId) {
      const item = await getDeckItem(deckId);
      if (!item) {
        throw domainError(404, "DECK_NOT_FOUND", "指定されたデッキは存在しません。");
      }
      return buildDeckState(deckId, item, item.version || 1);
    },

    async replaceDeck(deckId, payload) {
      const requestedVersion = Number(payload?.version);
      const hasRequestedVersion = Number.isFinite(requestedVersion) && requestedVersion > 0;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const persistedDeck = await getPersistedDeckItem(deckId);
        const existingDeck =
          persistedDeck ||
          (deckId === defaultDeck.deckId ? buildDeckState(deckId, defaultDeck, defaultDeck.version || 1) : null);
        if (hasRequestedVersion && persistedDeck && requestedVersion !== persistedDeck.version) {
          throw domainError(409, "CONFLICT_RETRY", "デッキ更新が競合しました。もう一度お試しください。", true);
        }
        const normalizedDeck = normalizeDeckForStorage(deckId, payload, existingDeck);
        try {
          await putDeckItem(normalizedDeck, persistedDeck ? (hasRequestedVersion ? requestedVersion : persistedDeck.version) : null);
          return buildDeckState(deckId, normalizedDeck, normalizedDeck.version);
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "デッキ更新が競合しました。もう一度お試しください。", true);
    },

    async getRecentChampions(limit, options = {}) {
      const items = await queryChampionHistory(limit);
      const mergedPreview = buildRecentChampionItems(items, limit);
      return buildRecentChampionItems(items, limit, {
        likedChampionIds: await resolveLikedChampionIds(
          mergedPreview.map((item) => item.championId),
          options.deviceIdHash
        )
      });
    },

    async getChampionHistory(limit, options = {}) {
      const items = await queryChampionHistory(limit);
      return buildChampionHistoryViews(items, limit, {
        likedChampionIds: await resolveLikedChampionIds(
          items.slice(0, Math.max(limit, 1)).map((item) => item.championId),
          options.deviceIdHash
        )
      });
    },

    async getChampionRanking(limit, options = {}) {
      const items = await queryAllChampionHistory();
      const rankedItems = buildChampionRankingViews(items, limit);
      return buildChampionRankingViews(items, limit, {
        likedChampionIds: await resolveLikedChampionIds(
          rankedItems.map((item) => item.championId),
          options.deviceIdHash
        )
      });
    },

    async toggleChampionLike(championId, deviceIdHash) {
      if (!deviceIdHash) {
        throw domainError(400, "DEVICE_ID_REQUIRED", "いいねには端末識別子が必要です。");
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const championItem = await ensureChampionHistoryItem(championId);
        if (!championItem) {
          throw domainError(404, "CHAMPION_NOT_FOUND", "指定された総合優勝ワード履歴は存在しません。");
        }

        const likeItem = await getChampionLikeItem(championId, deviceIdHash);
        const nextLikeCount = Math.max(0, Number(championItem.likeCount || 0) + (likeItem ? -1 : 1));
        const nextChampionItem = {
          ...championItem,
          likeCount: nextLikeCount,
          updatedAt: nowIso()
        };

        try {
          await documentClient.send(
            new modules.TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: tableName,
                    Item: nextChampionItem,
                    ConditionExpression: "attribute_not_exists(#likeCount) OR #likeCount = :expectedLikeCount",
                    ExpressionAttributeNames: {
                      "#likeCount": "likeCount"
                    },
                    ExpressionAttributeValues: {
                      ":expectedLikeCount": Math.max(0, Number(championItem.likeCount || 0))
                    }
                  }
                },
                likeItem
                  ? {
                      Delete: {
                        TableName: tableName,
                        Key: {
                          PK: likeItem.PK,
                          SK: likeItem.SK
                        },
                        ConditionExpression: "attribute_exists(PK)"
                      }
                    }
                  : {
                      Put: {
                        TableName: tableName,
                        Item: buildChampionLikeItem(championId, deviceIdHash),
                        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
                      }
                    }
              ]
            })
          );

          return toChampionHistoryView(nextChampionItem, {
            likedChampionIds: new Set(likeItem ? [] : [championId])
          });
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "いいねの更新が競合しました。もう一度お試しください。", true);
    },

    async deleteChampion(championId) {
      const item = await findChampionHistoryItemById(championId);
      if (!item) {
        throw domainError(404, "CHAMPION_NOT_FOUND", "指定された総合優勝ワード履歴は存在しません。");
      }

       const likeItems = await queryChampionLikeItems(championId);

      await documentClient.send(
        new modules.DeleteCommand({
          TableName: tableName,
          Key: {
            PK: item.PK,
            SK: item.SK
          }
        })
      );

      for (const likeItem of likeItems) {
        await documentClient.send(
          new modules.DeleteCommand({
            TableName: tableName,
            Key: {
              PK: likeItem.PK,
              SK: likeItem.SK
            }
          })
        );
      }

      return toChampionHistoryView(item);
    },

    async createRoom({ displayName, playerCount }) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const issuedAt = nowIso();
        const roomId = makeId("room");
        const inviteCode = makeInviteCode();
        const playerId = makeId("player");
        const playerToken = makeId("pt");
        const room = createRoomState({
          roomId,
          inviteCode,
          displayName,
          playerCount,
          playerId,
          playerTokenHash: hashPlayerToken(playerToken),
          issuedAt
        });
        const inviteItem = createInviteLookup(room);

        try {
          await documentClient.send(
            new modules.TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: tableName,
                    Item: room,
                    ConditionExpression: "attribute_not_exists(PK)"
                  }
                },
                {
                  Put: {
                    TableName: tableName,
                    Item: inviteItem,
                    ConditionExpression: "attribute_not_exists(PK)"
                  }
                }
              ]
            })
          );
          return { room, mePlayer: room.players[0], playerToken };
        } catch (error) {
          if (toConditionalFailure(error) || error.name === "TransactionCanceledException") {
            continue;
          }
          throw error;
        }
      }
      throw domainError(409, "CONFLICT_RETRY", "ルーム作成が競合しました。もう一度お試しください。", true);
    },

    async joinRoom({ inviteCode, displayName }) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const inviteItem = await findInvite(inviteCode);
        if (!inviteItem?.roomId) {
          throw domainError(404, "INVITE_NOT_FOUND", "招待コードが見つかりません。");
        }

        const room = await getRoomItem(inviteItem.roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        if (room.status === "finished" && room.game?.phase === "final_result") {
          throw domainError(409, "ROOM_ALREADY_FINISHED", "このルームは終了しています。");
        }
        if (room.players.length >= MAX_ROOM_MEMBERS) {
          throw domainError(409, "ROOM_FULL", "このルームは満員です。");
        }

        const issuedAt = nowIso();
        const playerId = makeId("player");
        const playerToken = makeId("pt");
        const updatedRoom = clone(room);
        const role = room.status === "lobby" && room.game?.phase === "lobby" && getGamePlayerCount(room) < room.playerCount ? "player" : "spectator";
        updatedRoom.players.push(
          createRoomMember({
            playerId,
            displayName,
            isHost: false,
            role,
            seatOrder: updatedRoom.players.length + 1,
            joinedAt: issuedAt,
            playerTokenHash: hashPlayerToken(playerToken)
          })
        );
        updatedRoom.playerOrder = derivePlayerOrder(updatedRoom);
        updatedRoom.updatedAt = issuedAt;
        updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
        updatedRoom.revision += 1;

        try {
          await putRoomItem(updatedRoom, room.revision);
          const mePlayer = updatedRoom.players.find((player) => player.playerId === playerId);
          return { room: updatedRoom, mePlayer, playerToken };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "参加処理が競合しました。もう一度お試しください。", true);
    },

    async getRoom(roomId, playerToken, options = {}) {
      const room = await getRoomItem(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      if (options.sinceRevision !== null && options.sinceRevision === room.revision) {
        return { room, mePlayer, notModified: true, revision: room.revision };
      }
      return { room, mePlayer, notModified: false, revision: room.revision };
    },

    async reconnectRoom(roomId, playerToken) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const updatedRoom = clone(room);
        const player = updatedRoom.players.find((item) => item.playerId === mePlayer.playerId);
        player.isConnected = true;
        player.lastSeenAt = nowIso();
        updatedRoom.updatedAt = player.lastSeenAt;
        updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
        updatedRoom.revision += 1;

        try {
          await putRoomItem(updatedRoom, room.revision);
          return { room: updatedRoom, mePlayer: player };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "再接続処理が競合しました。もう一度お試しください。", true);
    },

    async closeReveal(roomId, playerToken, revealId = "") {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const result = buildClosedRevealRoom(room, mePlayer, revealId);
        if (!result.changed) {
          return { room: result.room, mePlayer };
        }

        try {
          await putRoomItem(result.room, room.revision);
          const updatedMePlayer = result.room.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: result.room, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "公開ポップアップの更新が競合しました。もう一度お試しください。", true);
    },

    async setStartPlayer(roomId, playerToken, startPlayerId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }
        if (!mePlayer.isHost) {
          throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
        }
        if (room.game?.phase !== "lobby") {
          throw domainError(409, "INVALID_PHASE", "lobby ではないため実行できません。");
        }
        if (!getActivePlayers(room).some((player) => player.playerId === startPlayerId)) {
          throw domainError(400, "INVALID_TARGET", "開始プレイヤーが不正です。");
        }

        const updatedRoom = clone(room);
        updatedRoom.startPlayerId = startPlayerId;
        updatedRoom.playerOrder = rotatePlayerOrder(
          updatedRoom.players
            .slice()
            .sort((left, right) => left.seatOrder - right.seatOrder)
            .map((player) => player.playerId),
          startPlayerId
        );
        updatedRoom.updatedAt = nowIso();
        updatedRoom.revision += 1;

        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "開始順の更新が競合しました。もう一度お試しください。", true);
    },

    async setPlayerRole(roomId, playerToken, targetPlayerId, nextRole) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }
        if (!mePlayer.isHost) {
          throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
        }
        if (room.game?.phase !== "lobby") {
          throw domainError(409, "INVALID_PHASE", "lobby でのみ観戦設定を変更できます。");
        }

        const normalizedRole = normalizePlayerRole(nextRole);
        const updatedRoom = clone(room);
        const targetPlayer = updatedRoom.players.find((player) => player.playerId === targetPlayerId);
        if (!targetPlayer) {
          throw domainError(404, "PLAYER_NOT_FOUND", "対象プレイヤーが見つかりません。");
        }
        if (targetPlayer.isHost) {
          throw domainError(409, "HOST_ROLE_FIXED", "ホストは観戦に変更できません。");
        }
        if (normalizePlayerRole(targetPlayer.role) === normalizedRole) {
          return { room: updatedRoom, mePlayer: updatedRoom.players.find((player) => player.playerId === mePlayer.playerId) };
        }
        if (normalizedRole === "player" && getGamePlayerCount(updatedRoom) >= updatedRoom.playerCount) {
          throw domainError(409, "ROOM_FULL", "参加枠が埋まっているため観戦のままです。");
        }

        targetPlayer.role = normalizedRole;
        targetPlayer.usedTileIds = [];
        targetPlayer.handCount = 0;
        updatedRoom.playerOrder = derivePlayerOrder(updatedRoom);
        if (!updatedRoom.playerOrder.includes(updatedRoom.startPlayerId)) {
          updatedRoom.startPlayerId = updatedRoom.playerOrder[0] || updatedRoom.hostPlayerId;
        }
        updatedRoom.updatedAt = nowIso();
        updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
        updatedRoom.revision += 1;

        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "観戦設定の更新が競合しました。もう一度お試しください。", true);
    },

    async transferHost(roomId, playerToken, targetPlayerId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }
        if (!mePlayer.isHost) {
          throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
        }
        if (room.game?.phase !== "lobby") {
          throw domainError(409, "INVALID_PHASE", "lobby でのみホストを切り替えできます。");
        }

        const updatedRoom = clone(room);
        const currentHost = updatedRoom.players.find((player) => player.isHost);
        const nextHost = updatedRoom.players.find((player) => player.playerId === targetPlayerId);
        if (!nextHost) {
          throw domainError(404, "PLAYER_NOT_FOUND", "対象プレイヤーが見つかりません。");
        }
        if (normalizePlayerRole(nextHost.role) !== "player") {
          throw domainError(409, "HOST_TRANSFER_REQUIRES_PLAYER", "参加中のプレイヤーだけホストにできます。");
        }
        if (nextHost.isHost) {
          return { room: updatedRoom, mePlayer: updatedRoom.players.find((player) => player.playerId === mePlayer.playerId) };
        }

        if (currentHost) {
          currentHost.isHost = false;
        }
        nextHost.isHost = true;
        updatedRoom.hostPlayerId = nextHost.playerId;
        updatedRoom.updatedAt = nowIso();
        updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
        updatedRoom.revision += 1;

        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "ホスト切り替えが競合しました。もう一度お試しください。", true);
    },

    async startGame(roomId, playerToken, deckId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }
        if (!mePlayer.isHost) {
          throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
        }
        if (room.game?.phase !== "lobby") {
          throw domainError(409, "INVALID_PHASE", "lobby ではないため実行できません。");
        }

        const deck = await this.getDeck(deckId);
        const updatedRoom = buildStartedRoom(room, deck);

        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "ゲーム開始処理が競合しました。もう一度お試しください。", true);
    },

    async submitWord(roomId, playerToken, roundIndex, payload) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const updatedRoom = buildSubmittedRoom(room, mePlayer, roundIndex, payload);

        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "提出処理が競合しました。もう一度お試しください。", true);
    },

    async submitVote(roomId, playerToken, roundIndex, targetPlayerId, mode = "vote") {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const updatedRoom = buildVotedRoom(room, mePlayer, roundIndex, targetPlayerId, mode);
        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "投票処理が競合しました。もう一度お試しください。", true);
    },

    async submitHostDecision(roomId, playerToken, roundIndex, winnerPlayerId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const updatedRoom = buildHostDecisionRoom(room, mePlayer, roundIndex, winnerPlayerId);
        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "ホスト裁定が競合しました。もう一度お試しください。", true);
    },

    async proceedRound(roomId, playerToken, roundIndex) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const updatedRoom = buildProceedRoom(room, mePlayer, roundIndex);
        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "次ラウンド進行が競合しました。もう一度お試しください。", true);
    },

    async submitFinalVote(roomId, playerToken, candidateId, mode = "vote") {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const updatedRoom = buildFinalVotedRoom(room, mePlayer, candidateId, mode);
        try {
          const championEntry =
            updatedRoom.game?.phase === "final_result" && room.game?.phase !== "final_result"
              ? buildChampionHistoryEntry(updatedRoom)
              : null;
          if (championEntry) {
            await documentClient.send(
              new modules.TransactWriteCommand({
                TransactItems: [
                  {
                    Put: {
                      TableName: tableName,
                      Item: updatedRoom,
                      ConditionExpression: "#revision = :expectedRevision",
                      ExpressionAttributeNames: { "#revision": "revision" },
                      ExpressionAttributeValues: { ":expectedRevision": room.revision }
                    }
                  },
                  {
                    Put: {
                      TableName: tableName,
                      Item: championEntry,
                      ConditionExpression: "attribute_not_exists(PK)"
                    }
                  }
                ]
              })
            );
          } else {
            await putRoomItem(updatedRoom, room.revision);
          }
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "最終投票処理が競合しました。もう一度お試しください。", true);
    },

    async submitFinalHostDecision(roomId, playerToken, candidateId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const updatedRoom = buildFinalHostDecisionRoom(room, mePlayer, candidateId);
        try {
          const championEntry =
            updatedRoom.game?.phase === "final_result" && room.game?.phase !== "final_result"
              ? buildChampionHistoryEntry(updatedRoom)
              : null;
          if (championEntry) {
            await documentClient.send(
              new modules.TransactWriteCommand({
                TransactItems: [
                  {
                    Put: {
                      TableName: tableName,
                      Item: updatedRoom,
                      ConditionExpression: "#revision = :expectedRevision",
                      ExpressionAttributeNames: { "#revision": "revision" },
                      ExpressionAttributeValues: { ":expectedRevision": room.revision }
                    }
                  },
                  {
                    Put: {
                      TableName: tableName,
                      Item: championEntry,
                      ConditionExpression: "attribute_not_exists(PK)"
                    }
                  }
                ]
              })
            );
          } else {
            await putRoomItem(updatedRoom, room.revision);
          }
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "最終ホスト裁定が競合しました。もう一度お試しください。", true);
    },

    async restartGame(roomId, playerToken) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const updatedRoom = buildRestartedRoom(room, mePlayer);
        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "ゲーム再開処理が競合しました。もう一度お試しください。", true);
    }
  };
}

function createMemoryRoomRepository() {
  const rooms = new Map();
  const invites = new Map();
  const decks = new Map([[defaultDeck.deckId, buildDeckState(defaultDeck.deckId, defaultDeck, defaultDeck.version || 1)]]);
  const championHistory = recentChampions.map((item) => buildSeedChampionHistoryEntry(item));
  const championLikes = new Map();

  function saveRoom(room) {
    rooms.set(room.roomId, clone(room));
  }

  function saveDeck(deck) {
    decks.set(deck.deckId, clone(deck));
  }

  function saveChampionEntry(room, previousPhase = null) {
    if (room.game?.phase !== "final_result" || previousPhase === "final_result") {
      return;
    }
    const entry = buildChampionHistoryEntry(room);
    if (!entry) {
      return;
    }
    championHistory.unshift(entry);
  }

  return {
    async getDeck(deckId) {
      const deck = decks.get(deckId);
      if (deck) {
        return clone(deck);
      }
      throw domainError(404, "DECK_NOT_FOUND", "指定されたデッキは存在しません。");
    },

    async replaceDeck(deckId, payload) {
      const existingDeck = decks.get(deckId) || null;
      const requestedVersion = Number(payload?.version);
      if (
        Number.isFinite(requestedVersion) &&
        requestedVersion > 0 &&
        existingDeck &&
        requestedVersion !== existingDeck.version
      ) {
        throw domainError(409, "CONFLICT_RETRY", "デッキ更新が競合しました。もう一度お試しください。", true);
      }
      const nextDeck = normalizeDeckForStorage(deckId, payload, existingDeck);
      saveDeck(nextDeck);
      return clone(nextDeck);
    },

    async getRecentChampions(limit, options = {}) {
      const items = buildRecentChampionItems(championHistory, limit);
      const likedChampionIds = new Set(
        items
          .filter((item) => championLikes.get(item.championId)?.has(options.deviceIdHash))
          .map((item) => item.championId)
      );
      return buildRecentChampionItems(championHistory, limit, { likedChampionIds });
    },

    async getChampionHistory(limit, options = {}) {
      const items = championHistory.slice(0, Math.max(limit, 1));
      const likedChampionIds = new Set(
        items
          .filter((item) => championLikes.get(item.championId)?.has(options.deviceIdHash))
          .map((item) => item.championId)
      );
      return buildChampionHistoryViews(championHistory, limit, { likedChampionIds });
    },

    async getChampionRanking(limit, options = {}) {
      const rankedItems = buildChampionRankingViews(championHistory, limit);
      const likedChampionIds = new Set(
        rankedItems
          .filter((item) => championLikes.get(item.championId)?.has(options.deviceIdHash))
          .map((item) => item.championId)
      );
      return buildChampionRankingViews(championHistory, limit, { likedChampionIds });
    },

    async toggleChampionLike(championId, deviceIdHash) {
      if (!deviceIdHash) {
        throw domainError(400, "DEVICE_ID_REQUIRED", "いいねには端末識別子が必要です。");
      }
      const item = championHistory.find((entry) => entry.championId === championId);
      if (!item) {
        throw domainError(404, "CHAMPION_NOT_FOUND", "指定された総合優勝ワード履歴は存在しません。");
      }

      const likeSet = championLikes.get(championId) || new Set();
      let likedByMe = false;
      if (likeSet.has(deviceIdHash)) {
        likeSet.delete(deviceIdHash);
      } else {
        likeSet.add(deviceIdHash);
        likedByMe = true;
      }
      if (likeSet.size) {
        championLikes.set(championId, likeSet);
      } else {
        championLikes.delete(championId);
      }
      item.likeCount = likeSet.size;
      return toChampionHistoryView(item, {
        likedChampionIds: likedByMe ? new Set([championId]) : new Set()
      });
    },

    async deleteChampion(championId) {
      const index = championHistory.findIndex((item) => item.championId === championId);
      if (index === -1) {
        throw domainError(404, "CHAMPION_NOT_FOUND", "指定された総合優勝ワード履歴は存在しません。");
      }
      const [removed] = championHistory.splice(index, 1);
      championLikes.delete(championId);
      return toChampionHistoryView(removed);
    },

    async createRoom({ displayName, playerCount }) {
      const issuedAt = nowIso();
      const roomId = makeId("room");
      const inviteCode = makeInviteCode();
      const playerId = makeId("player");
      const playerToken = makeId("pt");
      const room = createRoomState({
        roomId,
        inviteCode,
        displayName,
        playerCount,
        playerId,
        playerTokenHash: hashPlayerToken(playerToken),
        issuedAt
      });
      saveRoom(room);
      invites.set(inviteCode, roomId);
      return { room: clone(room), mePlayer: clone(room.players[0]), playerToken };
    },

    async joinRoom({ inviteCode, displayName }) {
      const roomId = invites.get(inviteCode);
      if (!roomId) {
        throw domainError(404, "INVITE_NOT_FOUND", "招待コードが見つかりません。");
      }
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      if (room.status === "finished" && room.game?.phase === "final_result") {
        throw domainError(409, "ROOM_ALREADY_FINISHED", "このルームは終了しています。");
      }
      if (room.players.length >= MAX_ROOM_MEMBERS) {
        throw domainError(409, "ROOM_FULL", "このルームは満員です。");
      }

      const issuedAt = nowIso();
      const playerId = makeId("player");
      const playerToken = makeId("pt");
      const updatedRoom = clone(room);
      const role = room.status === "lobby" && room.game?.phase === "lobby" && getGamePlayerCount(room) < room.playerCount ? "player" : "spectator";
      updatedRoom.players.push(
        createRoomMember({
          playerId,
          displayName,
          isHost: false,
          role,
          seatOrder: updatedRoom.players.length + 1,
          joinedAt: issuedAt,
          playerTokenHash: hashPlayerToken(playerToken)
        })
      );
      updatedRoom.playerOrder = derivePlayerOrder(updatedRoom);
      updatedRoom.updatedAt = issuedAt;
      updatedRoom.revision += 1;
      saveRoom(updatedRoom);
      const mePlayer = updatedRoom.players.find((player) => player.playerId === playerId);
      return { room: clone(updatedRoom), mePlayer: clone(mePlayer), playerToken };
    },

    async getRoom(roomId, playerToken, options = {}) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      if (options.sinceRevision !== null && options.sinceRevision === room.revision) {
        return { room: clone(room), mePlayer: clone(mePlayer), notModified: true, revision: room.revision };
      }
      return { room: clone(room), mePlayer: clone(mePlayer), notModified: false, revision: room.revision };
    },

    async reconnectRoom(roomId, playerToken) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      const updatedRoom = clone(room);
      const player = updatedRoom.players.find((item) => item.playerId === mePlayer.playerId);
      player.isConnected = true;
      player.lastSeenAt = nowIso();
      updatedRoom.updatedAt = player.lastSeenAt;
      updatedRoom.revision += 1;
      saveRoom(updatedRoom);
      return { room: clone(updatedRoom), mePlayer: clone(player) };
    },

    async closeReveal(roomId, playerToken, revealId = "") {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }

      const result = buildClosedRevealRoom(room, mePlayer, revealId);
      if (!result.changed) {
        return { room: result.room, mePlayer: clone(mePlayer) };
      }

      saveRoom(result.room);
      const updatedMePlayer = result.room.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(result.room), mePlayer: clone(updatedMePlayer) };
    },

    async setStartPlayer(roomId, playerToken, startPlayerId) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      if (!mePlayer.isHost) {
        throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
      }
      if (room.game?.phase !== "lobby") {
        throw domainError(409, "INVALID_PHASE", "lobby ではないため実行できません。");
      }
      if (!getActivePlayers(room).some((player) => player.playerId === startPlayerId)) {
        throw domainError(400, "INVALID_TARGET", "開始プレイヤーが不正です。");
      }

      const updatedRoom = clone(room);
      updatedRoom.startPlayerId = startPlayerId;
      updatedRoom.playerOrder = rotatePlayerOrder(
        updatedRoom.players
          .slice()
          .sort((left, right) => left.seatOrder - right.seatOrder)
          .map((player) => player.playerId),
        startPlayerId
      );
      updatedRoom.updatedAt = nowIso();
      updatedRoom.revision += 1;
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    async setPlayerRole(roomId, playerToken, targetPlayerId, nextRole) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      if (!mePlayer.isHost) {
        throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
      }
      if (room.game?.phase !== "lobby") {
        throw domainError(409, "INVALID_PHASE", "lobby でのみ観戦設定を変更できます。");
      }

      const updatedRoom = clone(room);
      const targetPlayer = updatedRoom.players.find((player) => player.playerId === targetPlayerId);
      if (!targetPlayer) {
        throw domainError(404, "PLAYER_NOT_FOUND", "対象プレイヤーが見つかりません。");
      }
      if (targetPlayer.isHost) {
        throw domainError(409, "HOST_ROLE_FIXED", "ホストは観戦に変更できません。");
      }

      const normalizedRole = normalizePlayerRole(nextRole);
      if (normalizePlayerRole(targetPlayer.role) === normalizedRole) {
        return { room: clone(updatedRoom), mePlayer: clone(updatedRoom.players.find((player) => player.playerId === mePlayer.playerId)) };
      }
      if (normalizedRole === "player" && getGamePlayerCount(updatedRoom) >= updatedRoom.playerCount) {
        throw domainError(409, "ROOM_FULL", "参加枠が埋まっているため観戦のままです。");
      }

      targetPlayer.role = normalizedRole;
      targetPlayer.usedTileIds = [];
      targetPlayer.handCount = 0;
      updatedRoom.playerOrder = derivePlayerOrder(updatedRoom);
      if (!updatedRoom.playerOrder.includes(updatedRoom.startPlayerId)) {
        updatedRoom.startPlayerId = updatedRoom.playerOrder[0] || updatedRoom.hostPlayerId;
      }
      updatedRoom.updatedAt = nowIso();
      updatedRoom.revision += 1;
      saveRoom(updatedRoom);
      return {
        room: clone(updatedRoom),
        mePlayer: clone(updatedRoom.players.find((player) => player.playerId === mePlayer.playerId))
      };
    },

    async transferHost(roomId, playerToken, targetPlayerId) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      if (!mePlayer.isHost) {
        throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
      }
      if (room.game?.phase !== "lobby") {
        throw domainError(409, "INVALID_PHASE", "lobby でのみホストを切り替えできます。");
      }

      const updatedRoom = clone(room);
      const currentHost = updatedRoom.players.find((player) => player.isHost);
      const nextHost = updatedRoom.players.find((player) => player.playerId === targetPlayerId);
      if (!nextHost) {
        throw domainError(404, "PLAYER_NOT_FOUND", "対象プレイヤーが見つかりません。");
      }
      if (normalizePlayerRole(nextHost.role) !== "player") {
        throw domainError(409, "HOST_TRANSFER_REQUIRES_PLAYER", "参加中のプレイヤーだけホストにできます。");
      }
      if (nextHost.isHost) {
        return {
          room: clone(updatedRoom),
          mePlayer: clone(updatedRoom.players.find((player) => player.playerId === mePlayer.playerId))
        };
      }

      if (currentHost) {
        currentHost.isHost = false;
      }
      nextHost.isHost = true;
      updatedRoom.hostPlayerId = nextHost.playerId;
      updatedRoom.updatedAt = nowIso();
      updatedRoom.revision += 1;
      saveRoom(updatedRoom);
      return {
        room: clone(updatedRoom),
        mePlayer: clone(updatedRoom.players.find((player) => player.playerId === mePlayer.playerId))
      };
    },

    async startGame(roomId, playerToken, deckId) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      if (!mePlayer.isHost) {
        throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
      }
      if (room.game?.phase !== "lobby") {
        throw domainError(409, "INVALID_PHASE", "lobby ではないため実行できません。");
      }

      const deck = await this.getDeck(deckId);
      const updatedRoom = buildStartedRoom(room, deck);
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    async submitWord(roomId, playerToken, roundIndex, payload) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }

      const updatedRoom = buildSubmittedRoom(room, mePlayer, roundIndex, payload);
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    async submitVote(roomId, playerToken, roundIndex, targetPlayerId, mode = "vote") {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }

      const updatedRoom = buildVotedRoom(room, mePlayer, roundIndex, targetPlayerId, mode);
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    async submitHostDecision(roomId, playerToken, roundIndex, winnerPlayerId) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }

      const updatedRoom = buildHostDecisionRoom(room, mePlayer, roundIndex, winnerPlayerId);
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    async proceedRound(roomId, playerToken, roundIndex) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }

      const updatedRoom = buildProceedRoom(room, mePlayer, roundIndex);
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    async submitFinalVote(roomId, playerToken, candidateId, mode = "vote") {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }

      const updatedRoom = buildFinalVotedRoom(room, mePlayer, candidateId, mode);
      saveChampionEntry(updatedRoom, room.game?.phase);
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    async submitFinalHostDecision(roomId, playerToken, candidateId) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }

      const updatedRoom = buildFinalHostDecisionRoom(room, mePlayer, candidateId);
      saveChampionEntry(updatedRoom, room.game?.phase);
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    async restartGame(roomId, playerToken) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }

      const updatedRoom = buildRestartedRoom(room, mePlayer);
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    debugGetStoredRoom(roomId) {
      const room = rooms.get(roomId);
      return room ? clone(room) : null;
    }
  };
}

function toErrorResponse(error) {
  if (error?.statusCode && error?.code) {
    return fail(error.statusCode, error.code, error.message, Boolean(error.retryable));
  }
  return fail(500, "INTERNAL_ERROR", "サーバー内部でエラーが発生しました。", true);
}

function createHandler(options = {}) {
  const adminSharedPasscode = String(options.adminSharedPasscode ?? process.env.ADMIN_SHARED_PASSCODE ?? "").trim();
  const roomRepositoryPromise = options.roomRepository
    ? Promise.resolve(options.roomRepository)
    : createDynamoRoomRepository(options.dynamo || {});

  return async function lambdaHandler(event) {
    const method = event.requestContext?.http?.method || event.httpMethod || "GET";
    const pathname = normalizePathname(event);

    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: buildHeaders(),
        body: ""
      };
    }

    const matched = parseRoute(method, pathname);
    if (!matched) {
      return fail(404, "ROUTE_NOT_FOUND", "指定された API は存在しません。");
    }

    try {
      switch (matched.route) {
        case "health":
          return handleHealth();
        case "getChampionsRecent":
          {
            const repository = await roomRepositoryPromise;
            const deviceIdHash = hashDeviceId(normalizeDeviceId(getHeader(event, DEVICE_ID_HEADER)));
            if (typeof repository.getRecentChampions === "function") {
              const requestedLimit = Number(event.queryStringParameters?.limit || "5");
              const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5;
              return ok({
                items: await repository.getRecentChampions(limit, { deviceIdHash })
              });
            }
            return handleGetChampionsRecent(event);
          }
        case "getChampionsHistory":
          {
            const repository = await roomRepositoryPromise;
            const deviceIdHash = hashDeviceId(normalizeDeviceId(getHeader(event, DEVICE_ID_HEADER)));
            if (typeof repository.getChampionHistory === "function") {
              const requestedLimit = Number(event.queryStringParameters?.limit || "50");
              const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 50;
              return ok({
                items: await repository.getChampionHistory(limit, { deviceIdHash })
              });
            }
            return handleGetChampionsHistory(event);
          }
        case "getChampionsRanking":
          {
            const repository = await roomRepositoryPromise;
            const deviceIdHash = hashDeviceId(normalizeDeviceId(getHeader(event, DEVICE_ID_HEADER)));
            const requestedLimit = Number(event.queryStringParameters?.limit || "10");
            const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 10;
            if (typeof repository.getChampionRanking === "function") {
              return ok({
                items: await repository.getChampionRanking(limit, { deviceIdHash })
              });
            }
            return ok({
              items: []
            });
          }
        case "toggleChampionLike": {
          const repository = await roomRepositoryPromise;
          if (typeof repository.toggleChampionLike !== "function") {
            return fail(501, "NOT_IMPLEMENTED", "いいね機能は未対応です。");
          }
          const deviceId = normalizeDeviceId(getHeader(event, DEVICE_ID_HEADER));
          if (!deviceId) {
            return fail(400, "DEVICE_ID_REQUIRED", "いいねには端末識別子が必要です。");
          }
          const item = await repository.toggleChampionLike(matched.params[0], hashDeviceId(deviceId));
          return ok({ item });
        }
        case "getAdminChampions": {
          requireAdminPasscode(event, adminSharedPasscode);
          const repository = await roomRepositoryPromise;
          const requestedLimit = Number(event.queryStringParameters?.limit || "100");
          const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;
          if (typeof repository.getChampionHistory === "function") {
            return ok({
              items: await repository.getChampionHistory(limit)
            });
          }
          return handleGetChampionsHistory({
            queryStringParameters: { limit: String(limit) }
          });
        }
        case "deleteAdminChampion": {
          requireAdminPasscode(event, adminSharedPasscode);
          const repository = await roomRepositoryPromise;
          if (typeof repository.deleteChampion !== "function") {
            return fail(501, "NOT_IMPLEMENTED", "優勝ワード履歴の削除は未対応です。");
          }
          const removed = await repository.deleteChampion(matched.params[0]);
          return ok({ removed });
        }
        case "getDeck":
          {
            requireAdminPasscode(event, adminSharedPasscode);
            const repository = await roomRepositoryPromise;
            const deck = await repository.getDeck(matched.params[0]);
            return ok(deck);
          }
        case "putDeck": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          requireAdminPasscode(event, adminSharedPasscode);
          const repository = await roomRepositoryPromise;
          const deck = await repository.replaceDeck(matched.params[0], body);
          return ok(deck);
        }
        case "createRoom": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.createRoom({
            displayName: normalizeDisplayName(body.displayName),
            playerCount: normalizePlayerCount(body.playerCount)
          });
          return ok(toRoomPayload(result.room, result.mePlayer, result.playerToken));
        }
        case "joinRoom": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const inviteCode = String(body.inviteCode || "").trim();
          if (!inviteCode) {
            return fail(400, "INVITE_NOT_FOUND", "招待コードが必要です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.joinRoom({
            inviteCode,
            displayName: normalizeDisplayName(body.displayName)
          });
          return ok(toRoomPayload(result.room, result.mePlayer, result.playerToken));
        }
        case "getRoom": {
          const repository = await roomRepositoryPromise;
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const sinceRevision = normalizeKnownRevision(event.queryStringParameters?.sinceRevision);
          const result = await repository.getRoom(matched.params[0], playerToken, { sinceRevision });
          if (result.notModified) {
            return ok({
              roomId: matched.params[0],
              revision: result.revision,
              notModified: true
            });
          }
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "reconnectRoom": {
          const repository = await roomRepositoryPromise;
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const result = await repository.reconnectRoom(matched.params[0], playerToken);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "closeReveal": {
          const body = parseBody(event);
          if (body === null) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.closeReveal(matched.params[0], playerToken, String(body?.revealId || "").trim());
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "startPlayer": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const startPlayerId = String(body.startPlayerId || "").trim();
          if (!startPlayerId) {
            return fail(400, "INVALID_TARGET", "開始プレイヤーが不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.setStartPlayer(matched.params[0], playerToken, startPlayerId);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "setPlayerRole": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const targetPlayerId = String(body.targetPlayerId || "").trim();
          if (!targetPlayerId) {
            return fail(400, "INVALID_TARGET", "対象プレイヤーが不正です。");
          }
          const role = normalizePlayerRole(body.role);
          const repository = await roomRepositoryPromise;
          const result = await repository.setPlayerRole(matched.params[0], playerToken, targetPlayerId, role);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "transferHost": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const targetPlayerId = String(body.targetPlayerId || "").trim();
          if (!targetPlayerId) {
            return fail(400, "INVALID_TARGET", "対象プレイヤーが不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.transferHost(matched.params[0], playerToken, targetPlayerId);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "startGame": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.startGame(
            matched.params[0],
            playerToken,
            String(body.deckId || "default").trim() || "default"
          );
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "submitWord": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.submitWord(matched.params[0], playerToken, Number(matched.params[1]), body);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "submitVote": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const targetPlayerId = String(body.targetPlayerId || "").trim();
          if (!targetPlayerId) {
            return fail(400, "INVALID_TARGET", "投票先が不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.submitVote(
            matched.params[0],
            playerToken,
            Number(matched.params[1]),
            targetPlayerId,
            "vote"
          );
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "submitRevote": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const targetPlayerId = String(body.targetPlayerId || "").trim();
          if (!targetPlayerId) {
            return fail(400, "INVALID_TARGET", "投票先が不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.submitVote(
            matched.params[0],
            playerToken,
            Number(matched.params[1]),
            targetPlayerId,
            "revote"
          );
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "submitHostDecision": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const winnerPlayerId = String(body.winnerPlayerId || "").trim();
          if (!winnerPlayerId) {
            return fail(400, "INVALID_TARGET", "裁定対象が不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.submitHostDecision(
            matched.params[0],
            playerToken,
            Number(matched.params[1]),
            winnerPlayerId
          );
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "proceedRound": {
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.proceedRound(matched.params[0], playerToken, Number(matched.params[1]));
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "submitFinalVote": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const candidateId = String(body.candidateId || "").trim();
          if (!candidateId) {
            return fail(400, "INVALID_TARGET", "投票先が不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.submitFinalVote(matched.params[0], playerToken, candidateId, "vote");
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "submitFinalRevote": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const candidateId = String(body.candidateId || "").trim();
          if (!candidateId) {
            return fail(400, "INVALID_TARGET", "投票先が不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.submitFinalVote(matched.params[0], playerToken, candidateId, "revote");
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "submitFinalHostDecision": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const candidateId = String(body.candidateId || "").trim();
          if (!candidateId) {
            return fail(400, "INVALID_TARGET", "裁定対象が不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.submitFinalHostDecision(matched.params[0], playerToken, candidateId);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "restartGame": {
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.restartGame(matched.params[0], playerToken);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "notImplemented":
          return handleNotImplemented(pathname);
        default:
          return fail(404, "ROUTE_NOT_FOUND", "指定された API は存在しません。");
      }
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

let defaultHandler = null;

async function handler(event) {
  if (!defaultHandler) {
    defaultHandler = createHandler();
  }
  return defaultHandler(event);
}

module.exports = {
  handler,
  createHandler,
  createMemoryRoomRepository,
  createDynamoRoomRepository,
  parseRoute,
  normalizePathname
};
