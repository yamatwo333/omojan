const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const MOCK_DIR = path.join(ROOT_DIR, "mock_api");

const roomStore = new Map();
let roomSequence = 1;
let inviteSequence = 2048;

const ROUND_META = [
  { label: "ラウンド1", wind: "東一局" },
  { label: "ラウンド2", wind: "東二局" },
  { label: "ラウンド3", wind: "東三局" }
];

const DEMO_PLAYERS = [
  { playerId: "player_you", displayName: "あなた", isHost: true },
  { playerId: "player_host", displayName: "やまだ", isHost: false },
  { playerId: "player_tanaka", displayName: "たなか", isHost: false },
  { playerId: "player_miki", displayName: "みき", isHost: false }
];

const BOT_SUBMISSIONS = [
  {
    player_host: { phrase: "爆ラーメン", fontId: "classic", renderedLines: ["爆ラーメン"] },
    player_tanaka: { phrase: "寝社長", fontId: "classic", renderedLines: ["寝社長"] },
    player_miki: { phrase: "汁侍", fontId: "classic", renderedLines: ["汁侍"] }
  },
  {
    player_host: { phrase: "雲会見", fontId: "classic", renderedLines: ["雲会見"] },
    player_tanaka: { phrase: "薄ラーメン", fontId: "classic", renderedLines: ["薄ラーメン"] },
    player_miki: { phrase: "社長汁", fontId: "classic", renderedLines: ["社長汁"] }
  },
  {
    player_host: { phrase: "現場大洪水", fontId: "round", renderedLines: ["現場大洪水"] },
    player_tanaka: { phrase: "薄爆会見", fontId: "classic", renderedLines: ["薄爆会見"] },
    player_miki: { phrase: "汁ラッシュ", fontId: "playful", renderedLines: ["汁ラッシュ"] }
  }
];

const ROUND_BOT_VOTE_PREFERENCES = {
  0: {
    initial: {
      player_host: ["player_you", "player_tanaka", "player_miki"],
      player_tanaka: ["player_you", "player_host", "player_miki"],
      player_miki: ["player_you", "player_host", "player_tanaka"]
    },
    revote: {
      player_host: ["player_you", "player_tanaka", "player_miki"],
      player_tanaka: ["player_you", "player_host", "player_miki"],
      player_miki: ["player_you", "player_host", "player_tanaka"]
    }
  },
  1: {
    initial: {
      player_host: ["player_tanaka", "player_miki", "player_you"],
      player_tanaka: ["player_host", "player_miki", "player_you"],
      player_miki: ["player_tanaka", "player_host", "player_you"]
    },
    revote: {
      player_host: ["player_tanaka", "player_you", "player_miki"],
      player_tanaka: ["player_host", "player_you", "player_miki"],
      player_miki: ["player_tanaka", "player_host", "player_you"]
    }
  },
  2: {
    initial: {
      player_host: ["player_you", "player_tanaka", "player_miki"],
      player_tanaka: ["player_host", "player_you", "player_miki"],
      player_miki: ["player_host", "player_tanaka", "player_you"]
    },
    revote: {
      player_host: ["player_you", "player_tanaka", "player_miki"],
      player_tanaka: ["player_host", "player_you", "player_miki"],
      player_miki: ["player_host", "player_tanaka", "player_you"]
    }
  }
};

const FINAL_BOT_VOTE_PREFERENCES = {
  initial: {
    player_host: ["final_round2", "final_round1", "final_round3"],
    player_tanaka: ["final_round3", "final_round1", "final_round2"],
    player_miki: ["final_round3", "final_round2", "final_round1"]
  },
  revote: {
    player_host: ["final_round2", "final_round1", "final_round3"],
    player_tanaka: ["final_round3", "final_round1", "final_round2"],
    player_miki: ["final_round3", "final_round2", "final_round1"]
  }
};

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(MOCK_DIR, fileName), "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const defaultDeck = readJson("deck_default.json").data;
const scenarioPayload = readJson("room_scenarios.json");
const mutableChampionItems = clone(readJson("champions_recent.json").data.items);

function nowIso() {
  return new Date().toISOString();
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
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

function getHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((headerName) => headerName.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : "";
}

function getRoomScenario(scenarioName = "lobby") {
  return scenarioPayload.scenarios[scenarioName] || null;
}

function parseRoute(method, pathname) {
  const routes = [
    { method: "GET", pattern: /^\/v1\/champions\/recent$/, route: "getChampionsRecent" },
    { method: "GET", pattern: /^\/v1\/admin\/decks\/([^/]+)$/, route: "getDeck" },
    { method: "POST", pattern: /^\/v1\/rooms$/, route: "createRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/join$/, route: "joinRoom" },
    { method: "GET", pattern: /^\/v1\/rooms\/([^/]+)$/, route: "getRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/reconnect$/, route: "reconnectRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/start-player$/, route: "startPlayer" },
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

function createEmptyRounds() {
  return ROUND_META.map((meta, roundIndex) => ({
    roundIndex,
    label: meta.label,
    wind: meta.wind,
    phaseStatus: "pending",
    submissions: [],
    voteSummary: null,
    winner: null
  }));
}

function makeRoomId() {
  const roomId = `room_live_${String(roomSequence).padStart(4, "0")}`;
  roomSequence += 1;
  return roomId;
}

function makeInviteCode() {
  const inviteCode = `OMO-${String(inviteSequence).padStart(4, "0")}`;
  inviteSequence += 1;
  return inviteCode;
}

function createDemoRoom(displayName, playerCount) {
  const players = DEMO_PLAYERS.slice(0, playerCount).map((player, index) => ({
    playerId: player.playerId,
    displayName: player.playerId === "player_you" ? displayName : player.displayName,
    isHost: player.playerId === "player_you",
    seatOrder: index + 1,
    isConnected: true,
    handCount: 0,
    usedTileIds: []
  }));

  return {
    roomId: makeRoomId(),
    inviteCode: makeInviteCode(),
    revision: 1,
    status: "lobby",
    hostPlayerId: "player_you",
    playerCount,
    startPlayerId: null,
    playerOrder: [],
    me: {
      playerId: "player_you",
      displayName,
      isHost: true,
      reconnectTokenIssued: true
    },
    myHand: [],
    game: {
      phase: "lobby",
      roundIndex: null,
      currentTurnPlayerId: null,
      players,
      rounds: createEmptyRounds(),
      finalVote: null,
      champion: null
    }
  };
}

function createStore(displayName, playerCount) {
  const room = createDemoRoom(displayName, playerCount);
  return {
    room,
    playerToken: `pt_${room.roomId}_you`,
    roundVotes: {},
    finalVotes: {}
  };
}

function getStore(roomId) {
  return roomStore.get(roomId) || null;
}

function getPlayer(room, playerId) {
  return room.game.players.find((player) => player.playerId === playerId) || null;
}

function getCurrentRound(room) {
  if (room.game.roundIndex === null) {
    return null;
  }
  return room.game.rounds[room.game.roundIndex] || null;
}

function getMePlayer(room) {
  return getPlayer(room, room.me.playerId);
}

function createMyHand() {
  return defaultDeck.tiles
    .filter((tile) => tile.enabled)
    .slice(0, 10)
    .map((tile) => ({
      tileId: tile.tileId,
      text: tile.text,
      isUsed: false
    }));
}

function updateYouHandCount(room) {
  const mePlayer = getMePlayer(room);
  if (mePlayer) {
    mePlayer.handCount = room.myHand.filter((tile) => !tile.isUsed).length;
  }
}

function updateBotHandCount(room, playerId) {
  const player = getPlayer(room, playerId);
  if (player) {
    player.handCount = Math.max(0, 10 - player.usedTileIds.length);
  }
}

function findNextTurnPlayerId(room) {
  const round = getCurrentRound(room);
  if (!round) {
    return null;
  }
  return room.playerOrder.find((playerId) => !round.submissions.some((submission) => submission.playerId === playerId)) || null;
}

function buildRoomResponse(room) {
  return clone(room);
}

function requireStoreAndToken(event, roomId) {
  const store = getStore(roomId);
  if (!store) {
    return { error: fail(404, "ROOM_NOT_FOUND", "指定された room は存在しません。") };
  }
  const playerToken = getHeader(event, "X-Omojan-Player-Token");
  if (!playerToken || playerToken !== store.playerToken) {
    return { error: fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。") };
  }
  return { store };
}

function requireHost(store) {
  if (!store.room.me.isHost) {
    return fail(403, "NOT_HOST", "ホストのみ実行できます。");
  }
  return null;
}

function ensurePhase(room, expectedPhase) {
  if (room.game.phase !== expectedPhase) {
    return fail(409, "INVALID_PHASE", `${expectedPhase} ではないため実行できません。`);
  }
  return null;
}

function rotatePlayerOrder(room, startPlayerId) {
  const playerIds = room.game.players.map((player) => player.playerId);
  const startIndex = playerIds.indexOf(startPlayerId);
  if (startIndex === -1) {
    return playerIds;
  }
  return [...playerIds.slice(startIndex), ...playerIds.slice(0, startIndex)];
}

function resetGameFields(room) {
  room.status = "playing";
  room.game.roundIndex = 0;
  room.game.finalVote = null;
  room.game.champion = null;
  room.game.rounds = createEmptyRounds();
  room.myHand = createMyHand();
  updateYouHandCount(room);
  room.game.players.forEach((player) => {
    player.usedTileIds = [];
    player.handCount = 10;
  });
}

function getBotSubmission(roundIndex, playerId) {
  const roundConfig = BOT_SUBMISSIONS[roundIndex] || {};
  return roundConfig[playerId] || {
    phrase: `${playerId}-round-${roundIndex + 1}`,
    fontId: "classic",
    renderedLines: [`${playerId}-round-${roundIndex + 1}`]
  };
}

function addSubmission(room, playerId, submission) {
  const round = getCurrentRound(room);
  if (!round) {
    return;
  }
  round.submissions.push({
    playerId,
    displayName: getPlayer(room, playerId)?.displayName || playerId,
    phrase: submission.phrase,
    fontId: submission.fontId,
    renderedLines: submission.renderedLines,
    submittedAt: nowIso()
  });
}

function finishSubmitTurn(room) {
  const round = getCurrentRound(room);
  if (!round) {
    return;
  }
  const nextTurnPlayerId = findNextTurnPlayerId(room);
  if (nextTurnPlayerId) {
    room.game.currentTurnPlayerId = nextTurnPlayerId;
    return;
  }
  room.game.currentTurnPlayerId = null;
  room.game.phase = "round_vote";
  round.phaseStatus = "vote";
}

function autoSubmitBot(store, playerId) {
  const room = store.room;
  const round = getCurrentRound(room);
  const submission = getBotSubmission(room.game.roundIndex, playerId);
  addSubmission(room, playerId, submission);
  const player = getPlayer(room, playerId);
  player.usedTileIds.push(`${playerId}_r${room.game.roundIndex}_a`, `${playerId}_r${room.game.roundIndex}_b`);
  updateBotHandCount(room, playerId);
  finishSubmitTurn(room);
}

function autoAdvanceBotsUntilUserTurn(store) {
  const room = store.room;
  while (room.game.phase === "round_submit" && room.game.currentTurnPlayerId && room.game.currentTurnPlayerId !== room.me.playerId) {
    autoSubmitBot(store, room.game.currentTurnPlayerId);
  }
}

function buildPhraseFromPayload(room, payload) {
  const tileIdOrder = Array.isArray(payload.tileOrder) && payload.tileOrder.length === 2 ? payload.tileOrder : [0, 1];
  const selectedTiles = payload.tileIds.map((tileId) => room.myHand.find((tile) => tile.tileId === tileId));
  const orderedTiles = tileIdOrder.map((index) => selectedTiles[index]).filter(Boolean);
  return orderedTiles.map((tile) => tile.text).join("");
}

function createRenderedLines(room, payload) {
  if (Array.isArray(payload.renderedLines) && payload.renderedLines.length) {
    return payload.renderedLines.map((line) => String(line));
  }
  const tileIdOrder = Array.isArray(payload.tileOrder) && payload.tileOrder.length === 2 ? payload.tileOrder : [0, 1];
  const selectedTiles = payload.tileIds.map((tileId) => room.myHand.find((tile) => tile.tileId === tileId));
  const orderedTiles = tileIdOrder.map((index) => selectedTiles[index]).filter(Boolean);
  if (payload.lineMode === "single") {
    return [orderedTiles.map((tile) => tile.text).join("")];
  }
  return orderedTiles.map((tile) => tile.text);
}

function addUserSubmission(store, payload) {
  const room = store.room;
  if (!Array.isArray(payload.tileIds) || payload.tileIds.length !== 2) {
    return fail(400, "INVALID_TARGET", "牌は 2 枚ちょうど選択してください。");
  }

  const selectedTiles = payload.tileIds.map((tileId) => room.myHand.find((tile) => tile.tileId === tileId));
  if (selectedTiles.some((tile) => !tile || tile.isUsed)) {
    return fail(400, "INVALID_TARGET", "選択した牌は使用できません。");
  }

  const round = getCurrentRound(room);
  if (round.submissions.some((submission) => submission.playerId === room.me.playerId)) {
    return fail(409, "ALREADY_SUBMITTED", "すでに提出済みです。");
  }

  addSubmission(room, room.me.playerId, {
    phrase: String(payload.phrase || buildPhraseFromPayload(room, payload)),
    fontId: String(payload.fontId || "broadcast"),
    renderedLines: createRenderedLines(room, payload)
  });

  room.myHand = room.myHand.map((tile) =>
    payload.tileIds.includes(tile.tileId)
      ? {
          ...tile,
          isUsed: true
        }
      : tile
  );

  const mePlayer = getMePlayer(room);
  mePlayer.usedTileIds.push(...payload.tileIds);
  updateYouHandCount(room);
  finishSubmitTurn(room);
  autoAdvanceBotsUntilUserTurn(store);
  return null;
}

function pickPreferredTarget(preferences, validTargetIds, voterId) {
  return (preferences || []).find((targetId) => targetId !== voterId && validTargetIds.includes(targetId)) || validTargetIds[0] || null;
}

function summarizeRoundVotes(round, targetIds, ballots) {
  const counts = targetIds.map((playerId) => {
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
    topCount,
    winnerPlayerId: tiedPlayerIds[0] || null,
    tiedPlayerIds: tiedPlayerIds.length > 1 ? tiedPlayerIds : []
  };
}

function summarizeFinalVotes(finalVote, targetIds, ballots) {
  const counts = targetIds.map((candidateId) => {
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
    topCount,
    winnerCandidateId: tiedCandidateIds[0] || null,
    tiedCandidateIds: tiedCandidateIds.length > 1 ? tiedCandidateIds : []
  };
}

function setRoundWinner(store, winnerPlayerId, source, counts) {
  const room = store.room;
  const round = getCurrentRound(room);
  const submission = round.submissions.find((item) => item.playerId === winnerPlayerId);
  const countRow = counts.find((item) => item.playerId === winnerPlayerId);
  round.winner = {
    playerId: winnerPlayerId,
    displayName: submission.displayName,
    phrase: submission.phrase,
    fontId: submission.fontId,
    renderedLines: submission.renderedLines,
    voteCount: countRow?.count || 0,
    source
  };
  round.phaseStatus = "finished";
  round.voteSummary = {
    counts,
    tiedPlayerIds: []
  };
  room.game.phase = "round_result";
  room.game.currentTurnPlayerId = null;
}

function setFinalWinner(store, winnerCandidateId, source, counts) {
  const room = store.room;
  const finalVote = room.game.finalVote;
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
    renderedLines: candidate.renderedLines,
    voteCount: countRow?.count || 0,
    source
  };
  finalVote.phaseStatus = "finished";
  room.game.champion = clone(finalVote.winner);
  room.game.phase = "final_result";
  room.status = "finished";

  mutableChampionItems.unshift({
    championId: `ch_${room.roomId}_${Date.now()}`,
    phrase: candidate.phrase,
    displayName: candidate.displayName,
    wonAt: nowIso()
  });
  mutableChampionItems.splice(15);
}

function castBotRoundVotes(store, mode, validTargetIds) {
  const room = store.room;
  const roundIndex = room.game.roundIndex;
  const ballotKey = mode === "revote" ? "revote" : "initial";
  const ballots = { ...(store.roundVotes[roundIndex]?.[ballotKey] || {}) };
  for (const player of room.game.players) {
    if (player.playerId === room.me.playerId) {
      continue;
    }
    const preferences = ROUND_BOT_VOTE_PREFERENCES[roundIndex]?.[ballotKey]?.[player.playerId] || [];
    const targetId = pickPreferredTarget(preferences, validTargetIds, player.playerId);
    if (targetId) {
      ballots[player.playerId] = targetId;
    }
  }
  store.roundVotes[roundIndex] = store.roundVotes[roundIndex] || {};
  store.roundVotes[roundIndex][ballotKey] = ballots;
  return ballots;
}

function castBotFinalVotes(store, mode, validTargetIds) {
  const ballotKey = mode === "revote" ? "revote" : "initial";
  const ballots = { ...(store.finalVotes[ballotKey] || {}) };
  for (const player of store.room.game.players) {
    if (player.playerId === store.room.me.playerId) {
      continue;
    }
    const preferences = FINAL_BOT_VOTE_PREFERENCES[ballotKey]?.[player.playerId] || [];
    const allowedTargetIds = validTargetIds.filter((candidateId) => {
      const candidate = store.room.game.finalVote.candidates.find((item) => item.candidateId === candidateId);
      return candidate && candidate.playerId !== player.playerId;
    });
    const targetId = pickPreferredTarget(preferences, allowedTargetIds, player.playerId);
    if (targetId) {
      ballots[player.playerId] = targetId;
    }
  }
  store.finalVotes[ballotKey] = ballots;
  return ballots;
}

function startRound(store, roundIndex) {
  const room = store.room;
  const round = room.game.rounds[roundIndex];
  round.phaseStatus = "submit";
  round.submissions = [];
  round.voteSummary = null;
  round.winner = null;
  room.game.roundIndex = roundIndex;
  room.game.phase = "round_submit";
  room.game.currentTurnPlayerId = room.playerOrder[0] || room.me.playerId;
  autoAdvanceBotsUntilUserTurn(store);
}

function beginFinalVote(room) {
  room.game.phase = "final_vote";
  room.game.currentTurnPlayerId = null;
  room.game.finalVote = {
    phaseStatus: "vote",
    candidates: room.game.rounds
      .filter((round) => round.winner)
      .map((round) => ({
        candidateId: `final_round${round.roundIndex + 1}`,
        roundIndex: round.roundIndex,
        playerId: round.winner.playerId,
        displayName: round.winner.displayName,
        phrase: round.winner.phrase,
        fontId: round.winner.fontId,
        renderedLines: round.winner.renderedLines
      })),
    voteSummary: null,
    winner: null
  };
}

function handleGetChampionsRecent(event) {
  const requestedLimit = Number(event.queryStringParameters?.limit || "5");
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5;
  return ok({ items: clone(mutableChampionItems.slice(0, limit)) });
}

function handleGetDeck(event, deckId) {
  if (deckId !== "default") {
    return fail(404, "DECK_NOT_FOUND", "指定されたデッキは存在しません。");
  }
  return ok(clone(defaultDeck));
}

function handleCreateRoom(event) {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }

  const displayName = String(body.displayName || "").trim() || "あなた";
  const playerCount = [2, 3, 4].includes(body.playerCount) ? body.playerCount : 4;
  const store = createStore(displayName, playerCount);
  roomStore.set(store.room.roomId, store);
  return ok({
    playerToken: store.playerToken,
    room: buildRoomResponse(store.room)
  });
}

function handleJoinRoom(event) {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const inviteCode = String(body.inviteCode || "").trim();
  if (!inviteCode) {
    return fail(400, "INVITE_NOT_FOUND", "招待コードが必要です。");
  }

  const liveStore = [...roomStore.values()].find((store) => store.room.inviteCode === inviteCode);
  if (liveStore) {
    return ok({
      playerToken: liveStore.playerToken,
      room: buildRoomResponse(liveStore.room)
    });
  }

  const scenario = getRoomScenario("lobby");
  if (!scenario) {
    return fail(404, "INVITE_NOT_FOUND", "招待コードが見つかりません。");
  }
  return ok({
    playerToken: "pt_mock_you",
    room: clone(scenario.data.room)
  });
}

function handleGetRoom(event, roomId) {
  const scenarioName = event.queryStringParameters?.scenario;
  if (scenarioName) {
    const scenario = getRoomScenario(scenarioName);
    if (!scenario) {
      return fail(404, "ROOM_NOT_FOUND", "指定されたシナリオが存在しません。");
    }
    const room = clone(scenario.data.room);
    if (roomId && room.roomId !== roomId) {
      room.roomId = roomId;
    }
    return ok({ room });
  }

  const store = getStore(roomId);
  if (!store) {
    return fail(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
  }
  return ok({ room: buildRoomResponse(store.room) });
}

function handleReconnect(event, roomId) {
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }
  return ok({ room: buildRoomResponse(result.store.room) });
}

function handleStartPlayer(event, roomId) {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }
  const hostError = requireHost(result.store);
  if (hostError) {
    return hostError;
  }
  const phaseError = ensurePhase(result.store.room, "lobby");
  if (phaseError) {
    return phaseError;
  }

  const startPlayerId = String(body.startPlayerId || "");
  if (!getPlayer(result.store.room, startPlayerId)) {
    return fail(400, "INVALID_TARGET", "開始プレイヤーが不正です。");
  }

  result.store.room.startPlayerId = startPlayerId;
  result.store.room.playerOrder = rotatePlayerOrder(result.store.room, startPlayerId);
  result.store.room.revision += 1;
  return ok({ room: buildRoomResponse(result.store.room) });
}

function handleStartGame(event, roomId) {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }
  const hostError = requireHost(result.store);
  if (hostError) {
    return hostError;
  }
  const phaseError = ensurePhase(result.store.room, "lobby");
  if (phaseError) {
    return phaseError;
  }

  result.store.roundVotes = {};
  result.store.finalVotes = {};
  result.store.room.playerOrder =
    result.store.room.playerOrder.length > 0
      ? result.store.room.playerOrder
      : rotatePlayerOrder(result.store.room, result.store.room.startPlayerId || result.store.room.me.playerId);
  result.store.room.startPlayerId = result.store.room.playerOrder[0] || result.store.room.me.playerId;

  resetGameFields(result.store.room);
  startRound(result.store, 0);
  result.store.room.revision += 1;
  return ok({ room: buildRoomResponse(result.store.room) });
}

function handleSubmitWord(event, roomId, roundIndexValue) {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }
  const phaseError = ensurePhase(result.store.room, "round_submit");
  if (phaseError) {
    return phaseError;
  }
  const room = result.store.room;
  const roundIndex = Number(roundIndexValue);
  if (room.game.roundIndex !== roundIndex) {
    return fail(409, "INVALID_PHASE", "ラウンドが一致しません。");
  }
  if (room.game.currentTurnPlayerId !== room.me.playerId) {
    return fail(409, "NOT_YOUR_TURN", "あなたの手番ではありません。");
  }

  const submissionError = addUserSubmission(result.store, body);
  if (submissionError) {
    return submissionError;
  }

  room.revision += 1;
  return ok({ room: buildRoomResponse(room) });
}

function handleSubmitVote(event, roomId, roundIndexValue, mode = "vote") {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }

  const expectedPhase = mode === "revote" ? "round_revote" : "round_vote";
  const phaseError = ensurePhase(result.store.room, expectedPhase);
  if (phaseError) {
    return phaseError;
  }

  const room = result.store.room;
  const roundIndex = Number(roundIndexValue);
  if (room.game.roundIndex !== roundIndex) {
    return fail(409, "INVALID_PHASE", "ラウンドが一致しません。");
  }
  const round = getCurrentRound(room);
  const targetPlayerId = String(body.targetPlayerId || "");
  const validTargetIds =
    mode === "revote" ? round.voteSummary?.tiedPlayerIds || [] : round.submissions.map((submission) => submission.playerId);

  if (!validTargetIds.includes(targetPlayerId)) {
    return fail(400, "INVALID_TARGET", "投票先が不正です。");
  }
  if (targetPlayerId === room.me.playerId) {
    return fail(409, "SELF_VOTE_FORBIDDEN", "自分のワードには投票できません。");
  }

  const ballotKey = mode === "revote" ? "revote" : "initial";
  result.store.roundVotes[roundIndex] = result.store.roundVotes[roundIndex] || {};
  result.store.roundVotes[roundIndex][ballotKey] = result.store.roundVotes[roundIndex][ballotKey] || {};
  result.store.roundVotes[roundIndex][ballotKey][room.me.playerId] = targetPlayerId;

  const ballots = castBotRoundVotes(result.store, mode, validTargetIds);
  ballots[room.me.playerId] = targetPlayerId;

  const summary = summarizeRoundVotes(round, validTargetIds, ballots);
  round.voteSummary = {
    counts: summary.counts,
    tiedPlayerIds: summary.tiedPlayerIds
  };

  if (summary.tiedPlayerIds.length > 1) {
    room.game.phase = mode === "revote" ? "round_host_decide" : "round_revote";
    round.phaseStatus = mode === "revote" ? "host_decide" : "revote";
  } else {
    setRoundWinner(result.store, summary.winnerPlayerId, mode === "revote" ? "revote" : "initial", summary.counts);
  }

  room.revision += 1;
  return ok({ room: buildRoomResponse(room) });
}

function handleHostDecision(event, roomId, roundIndexValue) {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }
  const hostError = requireHost(result.store);
  if (hostError) {
    return hostError;
  }
  const phaseError = ensurePhase(result.store.room, "round_host_decide");
  if (phaseError) {
    return phaseError;
  }

  const room = result.store.room;
  const roundIndex = Number(roundIndexValue);
  if (room.game.roundIndex !== roundIndex) {
    return fail(409, "INVALID_PHASE", "ラウンドが一致しません。");
  }
  const round = getCurrentRound(room);
  const winnerPlayerId = String(body.winnerPlayerId || "");
  if (!(round.voteSummary?.tiedPlayerIds || []).includes(winnerPlayerId)) {
    return fail(400, "INVALID_TARGET", "裁定対象が不正です。");
  }

  setRoundWinner(result.store, winnerPlayerId, "host_decide", round.voteSummary.counts);
  room.revision += 1;
  return ok({ room: buildRoomResponse(room) });
}

function handleProceedRound(event, roomId, roundIndexValue) {
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }
  const hostError = requireHost(result.store);
  if (hostError) {
    return hostError;
  }
  const phaseError = ensurePhase(result.store.room, "round_result");
  if (phaseError) {
    return phaseError;
  }

  const room = result.store.room;
  const roundIndex = Number(roundIndexValue);
  if (room.game.roundIndex !== roundIndex) {
    return fail(409, "INVALID_PHASE", "ラウンドが一致しません。");
  }

  if (roundIndex < 2) {
    startRound(result.store, roundIndex + 1);
  } else {
    beginFinalVote(room);
  }

  room.revision += 1;
  return ok({ room: buildRoomResponse(room) });
}

function handleFinalVote(event, roomId, mode = "vote") {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }
  const expectedPhase = mode === "revote" ? "final_revote" : "final_vote";
  const phaseError = ensurePhase(result.store.room, expectedPhase);
  if (phaseError) {
    return phaseError;
  }

  const room = result.store.room;
  const finalVote = room.game.finalVote;
  const validTargetIds =
    mode === "revote" ? finalVote.voteSummary?.tiedCandidateIds || [] : finalVote.candidates.map((candidate) => candidate.candidateId);
  const candidateId = String(body.candidateId || "");
  const selectedCandidate = finalVote.candidates.find((candidate) => candidate.candidateId === candidateId);

  if (!validTargetIds.includes(candidateId) || !selectedCandidate) {
    return fail(400, "INVALID_TARGET", "投票先が不正です。");
  }
  if (selectedCandidate.playerId === room.me.playerId) {
    return fail(409, "SELF_VOTE_FORBIDDEN", "自分のワードには投票できません。");
  }

  const ballotKey = mode === "revote" ? "revote" : "initial";
  result.store.finalVotes[ballotKey] = result.store.finalVotes[ballotKey] || {};
  result.store.finalVotes[ballotKey][room.me.playerId] = candidateId;

  const ballots = castBotFinalVotes(result.store, mode, validTargetIds);
  ballots[room.me.playerId] = candidateId;

  const summary = summarizeFinalVotes(finalVote, validTargetIds, ballots);
  finalVote.voteSummary = {
    counts: summary.counts,
    tiedCandidateIds: summary.tiedCandidateIds
  };

  if (summary.tiedCandidateIds.length > 1) {
    room.game.phase = mode === "revote" ? "final_host_decide" : "final_revote";
    finalVote.phaseStatus = mode === "revote" ? "host_decide" : "revote";
  } else {
    setFinalWinner(result.store, summary.winnerCandidateId, mode === "revote" ? "revote" : "initial", summary.counts);
  }

  room.revision += 1;
  return ok({ room: buildRoomResponse(room) });
}

function handleFinalHostDecision(event, roomId) {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }
  const hostError = requireHost(result.store);
  if (hostError) {
    return hostError;
  }
  const phaseError = ensurePhase(result.store.room, "final_host_decide");
  if (phaseError) {
    return phaseError;
  }

  const candidateId = String(body.candidateId || "");
  const finalVote = result.store.room.game.finalVote;
  if (!(finalVote.voteSummary?.tiedCandidateIds || []).includes(candidateId)) {
    return fail(400, "INVALID_TARGET", "裁定対象が不正です。");
  }

  setFinalWinner(result.store, candidateId, "host_decide", finalVote.voteSummary.counts);
  result.store.room.revision += 1;
  return ok({ room: buildRoomResponse(result.store.room) });
}

function handleRestart(event, roomId) {
  const result = requireStoreAndToken(event, roomId);
  if (result.error) {
    return result.error;
  }
  const hostError = requireHost(result.store);
  if (hostError) {
    return hostError;
  }
  const room = result.store.room;
  const displayName = room.me.displayName;
  const playerCount = room.playerCount;
  const freshRoom = createDemoRoom(displayName, playerCount);
  freshRoom.roomId = room.roomId;
  freshRoom.inviteCode = room.inviteCode;
  freshRoom.revision = room.revision + 1;
  result.store.room = freshRoom;
  result.store.roundVotes = {};
  result.store.finalVotes = {};
  return ok({ room: buildRoomResponse(result.store.room) });
}

async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const pathname = event.rawPath || event.path || "/";
  const matched = parseRoute(method, pathname);

  if (!matched) {
    return fail(404, "ROUTE_NOT_FOUND", "指定された API は存在しません。");
  }

  switch (matched.route) {
    case "getChampionsRecent":
      return handleGetChampionsRecent(event);
    case "getDeck":
      return handleGetDeck(event, matched.params[0]);
    case "createRoom":
      return handleCreateRoom(event);
    case "joinRoom":
      return handleJoinRoom(event);
    case "getRoom":
      return handleGetRoom(event, matched.params[0]);
    case "reconnectRoom":
      return handleReconnect(event, matched.params[0]);
    case "startPlayer":
      return handleStartPlayer(event, matched.params[0]);
    case "startGame":
      return handleStartGame(event, matched.params[0]);
    case "submitWord":
      return handleSubmitWord(event, matched.params[0], matched.params[1]);
    case "submitVote":
      return handleSubmitVote(event, matched.params[0], matched.params[1], "vote");
    case "submitRevote":
      return handleSubmitVote(event, matched.params[0], matched.params[1], "revote");
    case "submitHostDecision":
      return handleHostDecision(event, matched.params[0], matched.params[1]);
    case "proceedRound":
      return handleProceedRound(event, matched.params[0], matched.params[1]);
    case "submitFinalVote":
      return handleFinalVote(event, matched.params[0], "vote");
    case "submitFinalRevote":
      return handleFinalVote(event, matched.params[0], "revote");
    case "submitFinalHostDecision":
      return handleFinalHostDecision(event, matched.params[0]);
    case "restartGame":
      return handleRestart(event, matched.params[0]);
    default:
      return fail(404, "ROUTE_NOT_FOUND", "指定された API は存在しません。");
  }
}

module.exports = {
  handler,
  parseRoute,
  handleGetRoom,
  handleCreateRoom,
  handleJoinRoom,
  roomStore
};
