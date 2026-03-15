const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const MOCK_DIR = path.join(ROOT_DIR, "mock_api");
const ROOM_TTL_SECONDS = 60 * 60 * 24 * 3;
const STARTING_HAND_SIZE = 10;

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
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-omojan-player-token"
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
      "rooms:create",
      "rooms:join",
      "rooms:get",
      "rooms:reconnect",
      "rooms:start-player",
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

function normalizePlayerCount(value) {
  const count = Number(value);
  return [2, 3, 4].includes(count) ? count : 4;
}

function hashPlayerToken(playerToken) {
  return `sha256:${crypto.createHash("sha256").update(playerToken).digest("hex")}`;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function makeInviteCode() {
  return `OMO-${String(Math.floor(1000 + Math.random() * 9000))}`;
}

function createEmptyRounds() {
  return [
    {
      roundIndex: 0,
      label: "ラウンド1",
      wind: "東一局",
      phaseStatus: "pending",
      submissions: [],
      votes: {},
      revotes: {},
      hostDecision: null,
      voteSummary: null,
      winner: null
    },
    {
      roundIndex: 1,
      label: "ラウンド2",
      wind: "東二局",
      phaseStatus: "pending",
      submissions: [],
      votes: {},
      revotes: {},
      hostDecision: null,
      voteSummary: null,
      winner: null
    },
    {
      roundIndex: 2,
      label: "ラウンド3",
      wind: "東三局",
      phaseStatus: "pending",
      submissions: [],
      votes: {},
      revotes: {},
      hostDecision: null,
      voteSummary: null,
      winner: null
    }
  ];
}

function getPlayableDeck(deckId) {
  if (deckId !== "default") {
    throw domainError(404, "DECK_NOT_FOUND", "指定されたデッキは存在しません。");
  }

  const enabledTiles = (defaultDeck.tiles || []).filter((tile) => tile.enabled !== false);
  if (!enabledTiles.length) {
    throw domainError(409, "DECK_EMPTY", "使用可能な牌がデッキにありません。");
  }

  return {
    deckId: defaultDeck.deckId,
    version: defaultDeck.version || 1,
    tiles: enabledTiles
  };
}

function dealInitialHands(players, deck) {
  let cursor = 0;
  const hands = {};

  for (const player of players) {
    hands[player.playerId] = Array.from({ length: STARTING_HAND_SIZE }, (_, index) => {
      const sourceTile = deck.tiles[cursor % deck.tiles.length];
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

function buildStartedRoom(room, deckId) {
  const deck = getPlayableDeck(deckId);
  const updatedRoom = clone(room);
  const playersInSeatOrder = updatedRoom.players.slice().sort((left, right) => left.seatOrder - right.seatOrder);
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
  updatedRoom.game.phase = "round_submit";
  updatedRoom.game.roundIndex = 0;
  updatedRoom.game.currentTurnPlayerId = startPlayerId;
  updatedRoom.game.deckId = deck.deckId;
  updatedRoom.game.deckVersion = deck.version;
  updatedRoom.game.initialHands = dealInitialHands(playersInSeatOrder, deck);
  updatedRoom.game.rounds = createEmptyRounds();
  updatedRoom.game.rounds[0].phaseStatus = "submit";
  updatedRoom.game.finalVote = null;
  updatedRoom.game.champion = null;

  updatedRoom.players = playersInSeatOrder.map((player) => ({
    ...player,
    usedTileIds: [],
    handCount: STARTING_HAND_SIZE
  }));
  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;

  return updatedRoom;
}

function getCurrentRound(room) {
  if (room.game?.roundIndex === null || room.game?.roundIndex === undefined) {
    return null;
  }
  return room.game.rounds?.[room.game.roundIndex] || null;
}

function startRound(updatedRoom, roundIndex) {
  updatedRoom.game.roundIndex = roundIndex;
  updatedRoom.game.phase = "round_submit";
  updatedRoom.game.currentTurnPlayerId = updatedRoom.playerOrder[0] || updatedRoom.startPlayerId || updatedRoom.hostPlayerId;
  updatedRoom.game.rounds[roundIndex].phaseStatus = "submit";
  updatedRoom.game.rounds[roundIndex].votes = {};
  updatedRoom.game.rounds[roundIndex].revotes = {};
  updatedRoom.game.rounds[roundIndex].hostDecision = null;
  updatedRoom.game.rounds[roundIndex].voteSummary = null;
  updatedRoom.game.rounds[roundIndex].winner = null;
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

  round.submissions.push({
    playerId: updatedPlayer.playerId,
    displayName: updatedPlayer.displayName,
    phrase,
    fontId: String(payload.fontId || "broadcast"),
    renderedLines: buildRenderedLines(payload, selectedTiles),
    submittedAt: nowIso()
  });

  updatedPlayer.usedTileIds = [...usedTileIds, ...payload.tileIds];
  updatedPlayer.handCount = Math.max(0, STARTING_HAND_SIZE - updatedPlayer.usedTileIds.length);

  const nextTurnPlayerId =
    updatedRoom.playerOrder.find(
      (playerId) => !round.submissions.some((submission) => submission.playerId === playerId)
    ) || null;

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
    renderedLines: candidate.renderedLines,
    voteCount: countRow?.count || 0,
    source
  };
  finalVote.phaseStatus = "finished";
  updatedRoom.game.champion = clone(finalVote.winner);
  updatedRoom.game.phase = "final_result";
  updatedRoom.game.currentTurnPlayerId = null;
  updatedRoom.status = "finished";
}

function buildVotedRoom(room, mePlayer, roundIndex, targetPlayerId, mode = "vote") {
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
  if (existingBallots[mePlayer.playerId]) {
    throw domainError(409, "ALREADY_VOTED", "すでに投票済みです。");
  }

  const validTargetIds =
    mode === "revote" ? round.voteSummary?.tiedPlayerIds || [] : round.submissions.map((submission) => submission.playerId);
  if (!validTargetIds.includes(targetPlayerId)) {
    throw domainError(400, "INVALID_TARGET", "投票先が不正です。");
  }
  if (targetPlayerId === mePlayer.playerId) {
    throw domainError(409, "SELF_VOTE_FORBIDDEN", "自分のワードには投票できません。");
  }

  round[ballotKey] = {
    ...existingBallots,
    [mePlayer.playerId]: targetPlayerId
  };

  const expectedVoterCount = updatedRoom.players.length;
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
  updatedRoom.game.finalVote = {
    phaseStatus: "vote",
    candidates: updatedRoom.game.rounds.map((round) => ({
      candidateId: `final_round${round.roundIndex + 1}`,
      roundIndex: round.roundIndex,
      playerId: round.winner.playerId,
      displayName: round.winner.displayName,
      phrase: round.winner.phrase,
      fontId: round.winner.fontId,
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
  const validTargetIds =
    mode === "revote" ? finalVote.voteSummary?.tiedCandidateIds || [] : finalVote.candidates.map((candidate) => candidate.candidateId);
  const validCandidates = finalVote.candidates.filter((candidate) => validTargetIds.includes(candidate.candidateId));
  return players
    .filter((player) => validCandidates.some((candidate) => candidate.playerId !== player.playerId))
    .map((player) => player.playerId);
}

function buildFinalVotedRoom(room, mePlayer, candidateId, mode = "vote") {
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
  if (existingBallots[mePlayer.playerId]) {
    throw domainError(409, "ALREADY_VOTED", "すでに投票済みです。");
  }

  const validTargetIds =
    mode === "revote" ? finalVote.voteSummary?.tiedCandidateIds || [] : finalVote.candidates.map((candidate) => candidate.candidateId);
  const selectedCandidate = finalVote.candidates.find((candidate) => candidate.candidateId === candidateId);
  if (!validTargetIds.includes(candidateId) || !selectedCandidate) {
    throw domainError(400, "INVALID_TARGET", "投票先が不正です。");
  }
  if (selectedCandidate.playerId === mePlayer.playerId) {
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
  if (!mePlayer.isHost) {
    throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
  }
  if (room.game?.phase !== "final_result") {
    throw domainError(409, "INVALID_PHASE", "final_result ではないため実行できません。");
  }

  const updatedRoom = clone(room);
  updatedRoom.status = "lobby";
  updatedRoom.startPlayerId = null;
  updatedRoom.playerOrder = updatedRoom.players
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
    rounds: createEmptyRounds(),
    finalVote: null,
    champion: null
  };
  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  return updatedRoom;
}

function buildProceedRoom(room, mePlayer, roundIndex) {
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
  if (roundIndex < 2) {
    startRound(updatedRoom, roundIndex + 1);
  } else {
    beginFinalVote(updatedRoom);
  }
  updatedRoom.updatedAt = nowIso();
  updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  updatedRoom.revision += 1;
  return updatedRoom;
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
    players: [
      {
        playerId,
        displayName,
        isHost: true,
        seatOrder: 1,
        joinedAt: issuedAt,
        isConnected: true,
        playerTokenHash,
        lastSeenAt: issuedAt,
        usedTileIds: [],
        handCount: 0
      }
    ],
    game: {
      phase: "lobby",
      roundIndex: null,
      currentTurnPlayerId: null,
      deckId: null,
      deckVersion: null,
      initialHands: {},
      rounds: createEmptyRounds(),
      finalVote: null,
      champion: null
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
  const playerIds = [...room.players]
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
    seatOrder: player.seatOrder,
    isConnected: Boolean(player.isConnected),
    handCount: Number(player.handCount || 0),
    usedTileIds: Array.isArray(player.usedTileIds) ? player.usedTileIds : []
  };
}

function buildMyHand(room, mePlayer) {
  const initialHands = room.game?.initialHands?.[mePlayer.playerId] || [];
  const usedTileIds = new Set(mePlayer.usedTileIds || []);
  return initialHands.map((tile) => ({
    tileId: tile.tileId,
    text: tile.text,
    isUsed: usedTileIds.has(tile.tileId)
  }));
}

function toRoundView(round) {
  return {
    roundIndex: round.roundIndex,
    label: round.label,
    wind: round.wind,
    phaseStatus: round.phaseStatus,
    submissions: clone(round.submissions || []),
    voteSummary: round.voteSummary ? clone(round.voteSummary) : null,
    winner: round.winner ? clone(round.winner) : null,
    votedPlayerIds: Object.keys(round.votes || {}),
    revotedPlayerIds: Object.keys(round.revotes || {})
  };
}

function toFinalVoteView(finalVote) {
  if (!finalVote) {
    return null;
  }
  return {
    phaseStatus: finalVote.phaseStatus,
    candidates: clone(finalVote.candidates || []),
    voteSummary: finalVote.voteSummary ? clone(finalVote.voteSummary) : null,
    winner: finalVote.winner ? clone(finalVote.winner) : null,
    votedPlayerIds: Object.keys(finalVote.votes || {}),
    revotedPlayerIds: Object.keys(finalVote.revotes || {})
  };
}

function mapRoomResponse(room, mePlayer) {
  const players = [...room.players].sort((left, right) => left.seatOrder - right.seatOrder);
  return {
    roomId: room.roomId,
    inviteCode: room.inviteCode,
    revision: room.revision,
    status: room.status,
    hostPlayerId: room.hostPlayerId,
    playerCount: room.playerCount,
    startPlayerId: room.startPlayerId,
    playerOrder: Array.isArray(room.playerOrder) && room.playerOrder.length ? room.playerOrder : derivePlayerOrder(room),
    game: {
      phase: room.game?.phase || "lobby",
      roundIndex: room.game?.roundIndex ?? null,
      currentTurnPlayerId: room.game?.currentTurnPlayerId ?? null,
      players: players.map(toPlayerView),
      rounds: Array.isArray(room.game?.rounds) ? room.game.rounds.map(toRoundView) : createEmptyRounds().map(toRoundView),
      finalVote: toFinalVoteView(room.game?.finalVote),
      champion: room.game?.champion ? clone(room.game.champion) : null
    },
    me: {
      playerId: mePlayer.playerId,
      displayName: mePlayer.displayName,
      isHost: mePlayer.isHost,
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
  return error && (error.name === "ConditionalCheckFailedException" || error.code === "ConditionalCheckFailedException");
}

async function loadAwsSdkModules() {
  if (!awsSdkModules) {
    const dynamodb = require("@aws-sdk/client-dynamodb");
    const dynamodbDocument = require("@aws-sdk/lib-dynamodb");
    awsSdkModules = {
      DynamoDBClient: dynamodb.DynamoDBClient,
      DynamoDBDocumentClient: dynamodbDocument.DynamoDBDocumentClient,
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

  return {
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
        if (room.status !== "lobby" || room.game?.phase !== "lobby") {
          throw domainError(409, "ROOM_ALREADY_STARTED", "すでにゲームが始まっています。");
        }
        if (room.players.length >= room.playerCount) {
          throw domainError(409, "ROOM_FULL", "このルームは満員です。");
        }

        const issuedAt = nowIso();
        const playerId = makeId("player");
        const playerToken = makeId("pt");
        const updatedRoom = clone(room);
        updatedRoom.players.push({
          playerId,
          displayName,
          isHost: false,
          seatOrder: updatedRoom.players.length + 1,
          joinedAt: issuedAt,
          isConnected: true,
          playerTokenHash: hashPlayerToken(playerToken),
          lastSeenAt: issuedAt,
          usedTileIds: [],
          handCount: 0
        });
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

    async getRoom(roomId, playerToken) {
      const room = await getRoomItem(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      return { room, mePlayer };
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
        if (!room.players.some((player) => player.playerId === startPlayerId)) {
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

        const updatedRoom = buildStartedRoom(room, deckId);

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

  function saveRoom(room) {
    rooms.set(room.roomId, clone(room));
  }

  return {
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
      if (room.status !== "lobby" || room.game?.phase !== "lobby") {
        throw domainError(409, "ROOM_ALREADY_STARTED", "すでにゲームが始まっています。");
      }
      if (room.players.length >= room.playerCount) {
        throw domainError(409, "ROOM_FULL", "このルームは満員です。");
      }

      const issuedAt = nowIso();
      const playerId = makeId("player");
      const playerToken = makeId("pt");
      const updatedRoom = clone(room);
      updatedRoom.players.push({
        playerId,
        displayName,
        isHost: false,
        seatOrder: updatedRoom.players.length + 1,
        joinedAt: issuedAt,
        isConnected: true,
        playerTokenHash: hashPlayerToken(playerToken),
        lastSeenAt: issuedAt,
        usedTileIds: [],
        handCount: 0
      });
      updatedRoom.playerOrder = derivePlayerOrder(updatedRoom);
      updatedRoom.updatedAt = issuedAt;
      updatedRoom.revision += 1;
      saveRoom(updatedRoom);
      const mePlayer = updatedRoom.players.find((player) => player.playerId === playerId);
      return { room: clone(updatedRoom), mePlayer: clone(mePlayer), playerToken };
    },

    async getRoom(roomId, playerToken) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      return { room: clone(room), mePlayer: clone(mePlayer) };
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
      if (!room.players.some((player) => player.playerId === startPlayerId)) {
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

      const updatedRoom = buildStartedRoom(room, deckId);
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
          return handleGetChampionsRecent(event);
        case "getDeck":
          return handleGetDeck(matched.params[0]);
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
          const result = await repository.getRoom(matched.params[0], playerToken);
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
