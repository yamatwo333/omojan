const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler, createMemoryRoomRepository, createDynamoRoomRepository, normalizePathname } = require("./handler");

function createEvent(method, path, options = {}) {
  return {
    rawPath: path,
    queryStringParameters: options.query || {},
    headers: options.headers || {},
    body: options.body ? JSON.stringify(options.body) : "",
    requestContext: {
      http: {
        method
      }
    }
  };
}

async function parseResponse(response) {
  return JSON.parse(response.body || "{}");
}

function createTestHandler(options = {}) {
  return createHandler({
    roomRepository: createMemoryRoomRepository(),
    adminSharedPasscode: options.adminSharedPasscode || ""
  });
}

function createAdminHeaders(passcode) {
  return {
    "X-Omojan-Admin-Passcode": passcode
  };
}

function createDeviceHeaders(deviceId) {
  return {
    "X-Omojan-Device-Id": deviceId
  };
}

async function getRoom(handler, roomId, playerToken) {
  const response = await handler(
    createEvent("GET", `/v1/rooms/${roomId}`, {
      headers: {
        "X-Omojan-Player-Token": playerToken
      }
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function getRoomSnapshot(handler, roomId, playerToken, query = {}) {
  const response = await handler(
    createEvent("GET", `/v1/rooms/${roomId}`, {
      headers: {
        "X-Omojan-Player-Token": playerToken
      },
      query
    })
  );
  return {
    response,
    body: await parseResponse(response)
  };
}

async function createSession(handler, displayNames = ["ホスト", "ゲストA", "ゲストB"]) {
  const createResponse = await handler(
    createEvent("POST", "/v1/rooms", {
      body: {
        displayName: displayNames[0],
        playerCount: displayNames.length
      }
    })
  );
  const createBody = await parseResponse(createResponse);

  const session = {
    roomId: createBody.data.room.roomId,
    inviteCode: createBody.data.room.inviteCode,
    players: [
      {
        displayName: displayNames[0],
        playerId: createBody.data.room.me.playerId,
        playerToken: createBody.data.playerToken
      }
    ]
  };

  for (const displayName of displayNames.slice(1)) {
    const joinResponse = await handler(
      createEvent("POST", "/v1/rooms/join", {
        body: {
          inviteCode: session.inviteCode,
          displayName
        }
      })
    );
    const joinBody = await parseResponse(joinResponse);
    session.players.push({
      displayName,
      playerId: joinBody.data.room.me.playerId,
      playerToken: joinBody.data.playerToken
    });
  }

  return session;
}

function findPlayer(session, displayName) {
  const player = session.players.find((item) => item.displayName === displayName);
  assert.ok(player, `player not found: ${displayName}`);
  return player;
}

async function startGame(handler, session, startPlayerDisplayName = null) {
  const host = session.players[0];
  const startPlayer = startPlayerDisplayName ? findPlayer(session, startPlayerDisplayName) : host;

  const startPlayerResponse = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/start-player`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {
        startPlayerId: startPlayer.playerId
      }
    })
  );
  const startPlayerBody = await parseResponse(startPlayerResponse);
  assert.equal(startPlayerResponse.statusCode, 200);
  assert.equal(startPlayerBody.ok, true);

  const startResponse = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/start`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {
        deckId: "default"
      }
    })
  );
  const startBody = await parseResponse(startResponse);
  assert.equal(startResponse.statusCode, 200);
  assert.equal(startBody.ok, true);
  return startBody.data.room;
}

function buildSubmitPayload(room) {
  const availableTiles = room.myHand.filter((tile) => !tile.isUsed).slice(0, 2);
  assert.equal(availableTiles.length, 2);
  return {
    tileIds: availableTiles.map((tile) => tile.tileId),
    tileOrder: [0, 1],
    phrase: availableTiles.map((tile) => tile.text).join(""),
    fontId: "broadcast",
    sizePreset: "large",
    lineGapPreset: "none",
    lineMode: "boundary",
    manualBreaks: [],
    renderedLines: availableTiles.map((tile) => tile.text)
  };
}

async function submitFor(handler, session, player, roundIndex) {
  const room = await getRoom(handler, session.roomId, player.playerToken);
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/rounds/${roundIndex}/submit`, {
      headers: {
        "X-Omojan-Player-Token": player.playerToken
      },
      body: buildSubmitPayload(room)
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function submitAllForCurrentRound(handler, session, roundIndex) {
  let room = await getRoom(handler, session.roomId, session.players[0].playerToken);
  while (room.game.phase === "round_submit") {
    const currentPlayer = session.players.find((player) => player.playerId === room.game.currentTurnPlayerId);
    assert.ok(currentPlayer, "current turn player not found");
    room = await submitFor(handler, session, currentPlayer, roundIndex);
    room = await closeRevealForAll(handler, session);
  }
  return room;
}

async function voteFor(handler, session, voterDisplayName, roundIndex, targetDisplayName, mode = "vote") {
  const voter = findPlayer(session, voterDisplayName);
  const target = findPlayer(session, targetDisplayName);
  const endpoint = mode === "revote" ? "revote" : "vote";
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/rounds/${roundIndex}/${endpoint}`, {
      headers: {
        "X-Omojan-Player-Token": voter.playerToken
      },
      body: {
        targetPlayerId: target.playerId
      }
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function editCurrentVoteFor(handler, session, voterDisplayName) {
  const voter = findPlayer(session, voterDisplayName);
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/edit-vote`, {
      headers: {
        "X-Omojan-Player-Token": voter.playerToken
      },
      body: {}
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function hostDecisionFor(handler, session, roundIndex, winnerDisplayName) {
  const host = session.players[0];
  const winner = findPlayer(session, winnerDisplayName);
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/rounds/${roundIndex}/host-decision`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {
        winnerPlayerId: winner.playerId
      }
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function proceedRound(handler, session, roundIndex) {
  const host = session.players[0];
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/rounds/${roundIndex}/proceed`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {}
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function closeRevealFor(handler, session, player) {
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/reveal-close`, {
      headers: {
        "X-Omojan-Player-Token": player.playerToken
      },
      body: {}
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function closeRevealForAll(handler, session) {
  let room = await getRoom(handler, session.roomId, session.players[0].playerToken);
  if (!room.game.reveal) {
    return room;
  }
  for (const player of session.players) {
    room = await closeRevealFor(handler, session, player);
  }
  return room;
}

async function playRound(handler, session, roundIndex, votePlan, options = {}) {
  let room = await submitAllForCurrentRound(handler, session, roundIndex);
  assert.equal(room.game.phase, "round_vote");

  for (const [voterDisplayName, targetDisplayName] of votePlan) {
    room = await voteFor(handler, session, voterDisplayName, roundIndex, targetDisplayName, "vote");
  }

  if (room.game.phase === "round_revote") {
    assert.ok(options.revotePlan, "revotePlan is required for tied round");
    for (const [voterDisplayName, targetDisplayName] of options.revotePlan) {
      room = await voteFor(handler, session, voterDisplayName, roundIndex, targetDisplayName, "revote");
    }
  }

  if (room.game.phase === "round_host_decide") {
    assert.ok(options.hostDecisionDisplayName, "hostDecisionDisplayName is required for host decision");
    room = await hostDecisionFor(handler, session, roundIndex, options.hostDecisionDisplayName);
  }

  assert.equal(room.game.phase, "round_result");
  return room;
}

function getFinalCandidateByDisplayName(room, displayName) {
  const candidate = room.game.finalVote.candidates.find((item) => item.displayName === displayName);
  assert.ok(candidate, `final candidate not found: ${displayName}`);
  return candidate;
}

async function voteFinalFor(handler, session, room, voterDisplayName, targetDisplayName, mode = "vote") {
  const voter = findPlayer(session, voterDisplayName);
  const candidate = getFinalCandidateByDisplayName(room, targetDisplayName);
  const endpoint = mode === "revote" ? "final-revote" : "final-vote";
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/${endpoint}`, {
      headers: {
        "X-Omojan-Player-Token": voter.playerToken
      },
      body: {
        candidateId: candidate.candidateId
      }
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function finalHostDecisionFor(handler, session, room, targetDisplayName) {
  const host = session.players[0];
  const candidate = getFinalCandidateByDisplayName(room, targetDisplayName);
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/final-host-decision`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {
        candidateId: candidate.candidateId
      }
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function restartGame(handler, session) {
  const host = session.players[0];
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/restart`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {}
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function reachFinalVote(handler, session) {
  await startGame(handler, session, "ホスト");

  await playRound(handler, session, 0, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ゲストB"],
    ["ゲストB", "ゲストA"]
  ]);
  await closeRevealForAll(handler, session);
  await proceedRound(handler, session, 0);

  await playRound(handler, session, 1, [
    ["ホスト", "ゲストB"],
    ["ゲストA", "ゲストB"],
    ["ゲストB", "ホスト"]
  ]);
  await closeRevealForAll(handler, session);
  await proceedRound(handler, session, 1);

  await playRound(handler, session, 2, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ホスト"],
    ["ゲストB", "ホスト"]
  ]);
  await closeRevealForAll(handler, session);

  const finalVoteRoom = await proceedRound(handler, session, 2);
  assert.equal(finalVoteRoom.game.phase, "final_vote");
  assert.equal(finalVoteRoom.game.finalVote.candidates.length, 3);
  return finalVoteRoom;
}

test("GET /v1/health returns lambda scaffold metadata", async () => {
  process.env.APP_STAGE = "dev";
  process.env.APP_TABLE_NAME = "OmojanApp";

  const handler = createTestHandler();
  const response = await handler(createEvent("GET", "/v1/health"));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.mode, "lambda-scaffold");
  assert.equal(body.data.tableName, "OmojanApp");
  assert.deepEqual(body.data.implementedRoutes, [
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
    "rooms:edit-vote",
    "rooms:reveal-close",
    "rooms:start-player",
    "rooms:player-order",
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
  ]);
});

test("normalizePathname strips API Gateway stage prefix", () => {
  assert.equal(
    normalizePathname({
      rawPath: "/dev/v1/health",
      requestContext: { stage: "dev" }
    }),
    "/v1/health"
  );
  assert.equal(
    normalizePathname({
      rawPath: "/v1/health",
      requestContext: { stage: "$default" }
    }),
    "/v1/health"
  );
});

test("GET /v1/champions/recent returns recent items", async () => {
  const handler = createTestHandler();
  const response = await handler(createEvent("GET", "/v1/champions/recent", { query: { limit: "2" } }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 2);
});

test("GET /v1/champions/history returns champion history items", async () => {
  const handler = createTestHandler();
  const response = await handler(createEvent("GET", "/v1/champions/history", { query: { limit: "4" } }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 4);
  assert.ok(body.data.items[0].championId);
  assert.ok(Array.isArray(body.data.items[0].renderedLines));
});

test("champion likes can toggle and ranking reflects the count", async () => {
  const handler = createTestHandler();
  const deviceHeaders = createDeviceHeaders("device-like-test");
  const historyResponse = await handler(
    createEvent("GET", "/v1/champions/history", {
      query: { limit: "10" }
    })
  );
  const historyBody = await parseResponse(historyResponse);
  const targetChampionId = historyBody.data.items.at(-1)?.championId || historyBody.data.items[0].championId;

  let response = await handler(
    createEvent("POST", `/v1/champions/${targetChampionId}/like-toggle`, {
      headers: deviceHeaders,
      body: {}
    })
  );
  let body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.data.item.championId, targetChampionId);
  assert.equal(body.data.item.likeCount, 1);
  assert.equal(body.data.item.likedByMe, true);

  response = await handler(
    createEvent("GET", "/v1/champions/history", {
      headers: deviceHeaders,
      query: { limit: "10" }
    })
  );
  body = await parseResponse(response);
  const likedItem = body.data.items.find((item) => item.championId === targetChampionId);
  assert.ok(likedItem);
  assert.equal(likedItem.likeCount, 1);
  assert.equal(likedItem.likedByMe, true);

  response = await handler(
    createEvent("GET", "/v1/champions/ranking", {
      headers: deviceHeaders,
      query: { limit: "3" }
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.data.items[0].championId, targetChampionId);
  assert.equal(body.data.items[0].likeCount, 1);
  assert.equal(body.data.items[0].likedByMe, true);

  response = await handler(
    createEvent("POST", `/v1/champions/${targetChampionId}/like-toggle`, {
      headers: deviceHeaders,
      body: {}
    })
  );
  body = await parseResponse(response);
  assert.equal(body.data.item.likeCount, 0);
  assert.equal(body.data.item.likedByMe, false);
});

test("admin champion history API can list and delete items", async () => {
  const adminPasscode = "test-admin-passcode";
  const handler = createTestHandler({ adminSharedPasscode: adminPasscode });

  let response = await handler(createEvent("GET", "/v1/admin/champions"));
  let body = await parseResponse(response);
  assert.equal(response.statusCode, 401);
  assert.equal(body.error.code, "ADMIN_PASSCODE_REQUIRED");

  response = await handler(
    createEvent("GET", "/v1/admin/champions", {
      headers: createAdminHeaders(adminPasscode),
      query: { limit: "3" }
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 3);
  const championId = body.data.items[0].championId;

  response = await handler(
    createEvent("DELETE", `/v1/admin/champions/${championId}`, {
      headers: createAdminHeaders(adminPasscode)
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.removed.championId, championId);

  response = await handler(
    createEvent("GET", "/v1/admin/champions", {
      headers: createAdminHeaders(adminPasscode),
      query: { limit: "10" }
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.data.items.some((item) => item.championId === championId), false);
});

test("admin deck API requires passcode and updated deck is used on next game start", async () => {
  const adminPasscode = "test-admin-passcode";
  const handler = createTestHandler({ adminSharedPasscode: adminPasscode });

  let response = await handler(createEvent("GET", "/v1/admin/decks/default"));
  let body = await parseResponse(response);
  assert.equal(response.statusCode, 401);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "ADMIN_PASSCODE_REQUIRED");

  response = await handler(
    createEvent("GET", "/v1/admin/decks/default", {
      headers: createAdminHeaders("wrong-passcode")
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 403);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "ADMIN_PASSCODE_INVALID");

  response = await handler(
    createEvent("GET", "/v1/admin/decks/default", {
      headers: createAdminHeaders(adminPasscode)
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  const previousVersion = body.data.version;

  response = await handler(
    createEvent("PUT", "/v1/admin/decks/default", {
      headers: createAdminHeaders(adminPasscode),
      body: {
        deckName: "default",
        tiles: Array.from({ length: 20 }, (_, index) => ({
          tileId: `tile_admin_${String(index + 1).padStart(3, "0")}`,
          text: `管理牌${String(index + 1).padStart(2, "0")}`,
          enabled: true
        }))
      }
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.version, previousVersion + 1);
  assert.equal(body.data.tiles.length, 20);
  assert.equal(body.data.tiles[0].text, "管理牌01");
  assert.equal(body.data.tiles[19].text, "管理牌20");

  const session = await createSession(handler, ["ホスト", "ゲストA"]);
  const room = await startGame(handler, session, "ホスト");
  const configuredWords = new Set(body.data.tiles.map((tile) => tile.text));
  assert.equal(room.myHand.length, 10);
  assert.equal(room.myHand.every((tile) => configuredWords.has(tile.text)), true);
});

test("admin deck API rejects stale version on save", async () => {
  const adminPasscode = "test-admin-passcode";
  const handler = createTestHandler({ adminSharedPasscode: adminPasscode });

  const initialResponse = await handler(
    createEvent("GET", "/v1/admin/decks/default", {
      headers: createAdminHeaders(adminPasscode)
    })
  );
  const initialBody = await parseResponse(initialResponse);
  assert.equal(initialResponse.statusCode, 200);

  const basePayload = {
    deckName: "default",
    version: initialBody.data.version,
    tiles: Array.from({ length: 2 }, (_, index) => ({
      tileId: `tile_conflict_${index + 1}`,
      text: `競合確認${index + 1}`,
      enabled: true
    }))
  };

  const firstSaveResponse = await handler(
    createEvent("PUT", "/v1/admin/decks/default", {
      headers: createAdminHeaders(adminPasscode),
      body: basePayload
    })
  );
  const firstSaveBody = await parseResponse(firstSaveResponse);
  assert.equal(firstSaveResponse.statusCode, 200);
  assert.equal(firstSaveBody.ok, true);

  const staleSaveResponse = await handler(
    createEvent("PUT", "/v1/admin/decks/default", {
      headers: createAdminHeaders(adminPasscode),
      body: {
        ...basePayload,
        deckName: "default stale"
      }
    })
  );
  const staleSaveBody = await parseResponse(staleSaveResponse);
  assert.equal(staleSaveResponse.statusCode, 409);
  assert.equal(staleSaveBody.ok, false);
  assert.equal(staleSaveBody.error.code, "CONFLICT_RETRY");
});

test("admin deck API removes duplicate words and keeps the first one", async () => {
  const adminPasscode = "test-admin-passcode";
  const handler = createTestHandler({ adminSharedPasscode: adminPasscode });

  const initialResponse = await handler(
    createEvent("GET", "/v1/admin/decks/default", {
      headers: createAdminHeaders(adminPasscode)
    })
  );
  const initialBody = await parseResponse(initialResponse);

  const saveResponse = await handler(
    createEvent("PUT", "/v1/admin/decks/default", {
      headers: createAdminHeaders(adminPasscode),
      body: {
        deckName: "default",
        version: initialBody.data.version,
        tiles: [
          { tileId: "dup_top", text: "重複ワード", enabled: true },
          { tileId: "unique_1", text: "別ワード", enabled: true },
          { tileId: "dup_bottom", text: "重複ワード", enabled: false }
        ]
      }
    })
  );
  const saveBody = await parseResponse(saveResponse);

  assert.equal(saveResponse.statusCode, 200);
  assert.equal(saveBody.ok, true);
  assert.equal(saveBody.data.tiles.length, 2);
  assert.equal(saveBody.data.tiles[0].tileId, "dup_top");
  assert.equal(saveBody.data.tiles[0].text, "重複ワード");
  assert.equal(saveBody.data.tiles[1].text, "別ワード");
});

test("dynamo deck repository can save default deck before it exists in table", async () => {
  let storedDeckItem = null;
  let lastPutInput = null;

  const repository = await createDynamoRoomRepository({
    tableName: "OmojanTest",
    documentClient: {
      async send(command) {
        const input = command.input || {};
        if (input.Key?.PK === "DECK#default" && input.Key?.SK === "META") {
          return { Item: storedDeckItem };
        }
        if (input.Item?.PK === "DECK#default" && input.Item?.SK === "META") {
          lastPutInput = input;
          storedDeckItem = JSON.parse(JSON.stringify(input.Item));
          return {};
        }
        throw new Error("Unexpected command in test");
      }
    }
  });

  const initialDeck = await repository.getDeck("default");
  assert.ok(initialDeck.version >= 1);

  const savedDeck = await repository.replaceDeck("default", {
    deckName: "default",
    version: initialDeck.version,
    tiles: [
      { tileId: "tile_first_1", text: "初回保存1", enabled: true },
      { tileId: "tile_first_2", text: "初回保存2", enabled: true }
    ]
  });

  assert.equal(savedDeck.version, initialDeck.version + 1);
  assert.equal(savedDeck.tiles.length, 2);
  assert.equal(lastPutInput.ConditionExpression, "attribute_not_exists(PK)");
  assert.equal(storedDeckItem.version, initialDeck.version + 1);
});

test("room create/join/get/reconnect work in lobby", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["やまだ", "たなか"]);
  const guest = findPlayer(session, "たなか");

  const room = await getRoom(handler, session.roomId, guest.playerToken);
  assert.equal(room.me.displayName, "たなか");
  assert.equal(room.game.players.length, 2);

  const reconnectResponse = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/reconnect`, {
      headers: {
        "X-Omojan-Player-Token": guest.playerToken
      },
      body: {}
    })
  );
  const reconnectBody = await parseResponse(reconnectResponse);

  assert.equal(reconnectResponse.statusCode, 200);
  assert.equal(reconnectBody.ok, true);
  assert.equal(reconnectBody.data.room.me.displayName, "たなか");
});

test("joining beyond active player limit enters spectator mode", async () => {
  const handler = createTestHandler();
  const createResponse = await handler(
    createEvent("POST", "/v1/rooms", {
      body: { displayName: "ホスト", playerCount: 2 }
    })
  );
  const createBody = await parseResponse(createResponse);
  const inviteCode = createBody.data.room.inviteCode;

  await handler(
    createEvent("POST", "/v1/rooms/join", {
      body: { inviteCode, displayName: "ゲストA" }
    })
  );
  const spectatorJoin = await handler(
    createEvent("POST", "/v1/rooms/join", {
      body: { inviteCode, displayName: "観戦B" }
    })
  );
  const spectatorBody = await parseResponse(spectatorJoin);

  assert.equal(spectatorJoin.statusCode, 200);
  assert.equal(spectatorBody.data.room.me.role, "spectator");
  assert.equal(spectatorBody.data.room.activePlayerCount, 2);
  assert.equal(spectatorBody.data.room.spectatorCount, 1);
});

test("host can switch lobby members between player and spectator", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA"]);
  const host = findPlayer(session, "ホスト");

  const spectatorJoinResponse = await handler(
    createEvent("POST", "/v1/rooms/join", {
      body: { inviteCode: session.inviteCode, displayName: "観戦B" }
    })
  );
  const spectatorJoinBody = await parseResponse(spectatorJoinResponse);
  const spectator = {
    displayName: "観戦B",
    playerId: spectatorJoinBody.data.room.me.playerId,
    playerToken: spectatorJoinBody.data.playerToken
  };

  let response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/player-role`, {
      headers: { "X-Omojan-Player-Token": host.playerToken },
      body: { targetPlayerId: spectator.playerId, role: "player" }
    })
  );
  let body = await parseResponse(response);
  assert.equal(response.statusCode, 409);
  assert.equal(body.error.code, "ROOM_FULL");

  const guest = findPlayer(session, "ゲストA");
  response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/player-role`, {
      headers: { "X-Omojan-Player-Token": host.playerToken },
      body: { targetPlayerId: guest.playerId, role: "spectator" }
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.data.room.game.players.find((player) => player.playerId === guest.playerId).role, "spectator");

  response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/player-role`, {
      headers: { "X-Omojan-Player-Token": host.playerToken },
      body: { targetPlayerId: spectator.playerId, role: "player" }
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.data.room.game.players.find((player) => player.playerId === spectator.playerId).role, "player");
});

test("spectators are excluded from player order and first turn", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA"]);
  const host = findPlayer(session, "ホスト");

  const spectatorJoinResponse = await handler(
    createEvent("POST", "/v1/rooms/join", {
      body: { inviteCode: session.inviteCode, displayName: "観戦B" }
    })
  );
  const spectatorJoinBody = await parseResponse(spectatorJoinResponse);
  const spectator = spectatorJoinBody.data.room.game.players.find((player) => player.displayName === "観戦B");

  const setStartPlayerResponse = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/start-player`, {
      headers: { "X-Omojan-Player-Token": host.playerToken },
      body: { startPlayerId: host.playerId }
    })
  );
  const setStartPlayerBody = await parseResponse(setStartPlayerResponse);
  assert.equal(setStartPlayerResponse.statusCode, 200);
  assert.equal(setStartPlayerBody.data.room.playerOrder.includes(spectator.playerId), false);

  const startResponse = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/start`, {
      headers: { "X-Omojan-Player-Token": host.playerToken },
      body: {}
    })
  );
  const startBody = await parseResponse(startResponse);
  assert.equal(startResponse.statusCode, 200);
  assert.equal(startBody.data.room.playerOrder.includes(spectator.playerId), false);
  assert.equal(startBody.data.room.game.activePlayerIds.includes(spectator.playerId), false);
  assert.equal(startBody.data.room.game.currentTurnPlayerId, host.playerId);
});

test("host can transfer host role to another active player in lobby", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  const host = findPlayer(session, "ホスト");
  const nextHost = findPlayer(session, "ゲストA");

  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/host-transfer`, {
      headers: { "X-Omojan-Player-Token": host.playerToken },
      body: { targetPlayerId: nextHost.playerId }
    })
  );
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.room.hostPlayerId, nextHost.playerId);
  assert.equal(body.data.room.game.players.find((player) => player.playerId === nextHost.playerId).isHost, true);
  assert.equal(body.data.room.game.players.find((player) => player.playerId === host.playerId).isHost, false);
});

test("get room returns notModified when client revision is current", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲスト"]);
  const host = findPlayer(session, "ホスト");

  const initial = await getRoomSnapshot(handler, session.roomId, host.playerToken);
  assert.equal(initial.response.statusCode, 200);
  assert.equal(initial.body.ok, true);
  assert.equal(typeof initial.body.data.room.revision, "number");

  const unchanged = await getRoomSnapshot(handler, session.roomId, host.playerToken, {
    sinceRevision: String(initial.body.data.room.revision)
  });
  assert.equal(unchanged.response.statusCode, 200);
  assert.equal(unchanged.body.ok, true);
  assert.equal(unchanged.body.data.notModified, true);
  assert.equal(unchanged.body.data.revision, initial.body.data.room.revision);
  assert.equal("room" in unchanged.body.data, false);

  const updateResponse = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/start-player`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {
        startPlayerId: host.playerId
      }
    })
  );
  assert.equal(updateResponse.statusCode, 200);

  const changed = await getRoomSnapshot(handler, session.roomId, host.playerToken, {
    sinceRevision: String(initial.body.data.room.revision)
  });
  assert.equal(changed.response.statusCode, 200);
  assert.equal(changed.body.ok, true);
  assert.equal(changed.body.data.notModified, undefined);
  assert.equal(changed.body.data.room.startPlayerId, host.playerId);
  assert.ok(changed.body.data.room.revision > initial.body.data.room.revision);
});

test("start-player and start enter round_submit with dealt hands", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  const room = await startGame(handler, session, "ゲストB");

  assert.equal(room.status, "playing");
  assert.equal(room.game.phase, "round_submit");
  assert.equal(room.game.roundIndex, 0);
  assert.equal(room.game.currentTurnPlayerId, findPlayer(session, "ゲストB").playerId);
  assert.equal(room.myHand.length, 10);
  assert.equal(room.game.players.every((player) => player.handCount === 10), true);
  assert.equal(room.game.rounds.length, 3);
  assert.equal(room.game.rounds[0].phaseStatus, "submit");
});

test("player-order updates lobby order and first turn", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  const host = session.players[0];
  const guestA = findPlayer(session, "ゲストA");
  const guestB = findPlayer(session, "ゲストB");

  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/player-order`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {
        playerOrder: [guestB.playerId, host.playerId, guestA.playerId]
      }
    })
  );
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.room.playerOrder, [guestB.playerId, host.playerId, guestA.playerId]);
  assert.equal(body.data.room.startPlayerId, guestB.playerId);
});

test("player-order rejects spectator reordering", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB", "観戦"]);
  const host = session.players[0];
  const spectator = findPlayer(session, "観戦");
  const guestA = findPlayer(session, "ゲストA");
  const guestB = findPlayer(session, "ゲストB");

  await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/player-role`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {
        targetPlayerId: spectator.playerId,
        role: "spectator"
      }
    })
  );

  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/player-order`, {
      headers: {
        "X-Omojan-Player-Token": spectator.playerToken
      },
      body: {
        playerOrder: [guestA.playerId, guestB.playerId, host.playerId]
      }
    })
  );
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 403);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "SPECTATOR_FORBIDDEN");
});

test("start deals non-duplicate words across all players", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB", "ゲストC"]);
  await startGame(handler, session, "ホスト");

  const allWords = [];
  for (const player of session.players) {
    const room = await getRoom(handler, session.roomId, player.playerToken);
    const words = room.myHand.map((tile) => tile.text);
    assert.equal(new Set(words).size, words.length);
    allWords.push(...words);
  }

  assert.equal(new Set(allWords).size, allWords.length);
});

test("start rejects decks that are too small for non-duplicate dealing", async () => {
  const adminPasscode = "test-admin-passcode";
  const handler = createTestHandler({ adminSharedPasscode: adminPasscode });

  const initialResponse = await handler(
    createEvent("GET", "/v1/admin/decks/default", {
      headers: createAdminHeaders(adminPasscode)
    })
  );
  const initialBody = await parseResponse(initialResponse);

  const saveResponse = await handler(
    createEvent("PUT", "/v1/admin/decks/default", {
      headers: createAdminHeaders(adminPasscode),
      body: {
        deckName: "default",
        version: initialBody.data.version,
        tiles: Array.from({ length: 12 }, (_, index) => ({
          tileId: `tile_small_${index + 1}`,
          text: `少数牌${index + 1}`,
          enabled: true
        }))
      }
    })
  );
  const saveBody = await parseResponse(saveResponse);
  assert.equal(saveResponse.statusCode, 200);
  assert.equal(saveBody.ok, true);

  const session = await createSession(handler, ["ホスト", "ゲストA"]);
  const host = session.players[0];
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/start`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {
        deckId: "default"
      }
    })
  );
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 409);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "DECK_TOO_SMALL");
});

test("submit advances turn and last submission moves to round_vote", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");

  const firstSubmitRoom = await submitFor(handler, session, findPlayer(session, "ホスト"), 0);
  assert.equal(firstSubmitRoom.game.phase, "round_submit");
  assert.equal(firstSubmitRoom.game.reveal.kind, "submission");
  assert.equal(firstSubmitRoom.game.currentTurnPlayerId, findPlayer(session, "ゲストA").playerId);
  assert.equal(firstSubmitRoom.myHand.filter((tile) => tile.isUsed).length, 2);

  const acknowledgedRoom = await closeRevealForAll(handler, session);
  assert.equal(acknowledgedRoom.game.reveal, null);

  const finalRoom = await submitAllForCurrentRound(handler, session, 0);
  assert.equal(finalRoom.game.phase, "round_vote");
  assert.equal(finalRoom.game.currentTurnPlayerId, null);
  assert.equal(finalRoom.game.rounds[0].phaseStatus, "vote");
  assert.equal(finalRoom.game.rounds[0].submissions.length, 3);
});

test("round votes can resolve directly into round_result", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");
  const resultRoom = await playRound(handler, session, 0, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ゲストB"],
    ["ゲストB", "ゲストA"]
  ]);

  assert.equal(resultRoom.game.phase, "round_result");
  assert.equal(resultRoom.game.rounds[0].winner.playerId, findPlayer(session, "ゲストA").playerId);
  assert.equal(resultRoom.game.rounds[0].winner.source, "initial");
  assert.deepEqual(resultRoom.game.rounds[0].votedPlayerIds.sort(), session.players.map((player) => player.playerId).sort());
});

test("round vote can be changed before everyone finishes voting", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");
  await submitAllForCurrentRound(handler, session, 0);

  await voteFor(handler, session, "ホスト", 0, "ゲストA", "vote");
  let room = await getRoom(handler, session.roomId, findPlayer(session, "ホスト").playerToken);
  assert.equal(room.game.phase, "round_vote");
  assert.equal(room.game.rounds[0].myVoteTargetId, findPlayer(session, "ゲストA").playerId);

  await voteFor(handler, session, "ホスト", 0, "ゲストB", "vote");
  room = await getRoom(handler, session.roomId, findPlayer(session, "ホスト").playerToken);
  assert.equal(room.game.phase, "round_vote");
  assert.equal(room.game.rounds[0].myVoteTargetId, findPlayer(session, "ゲストB").playerId);
});

test("returning to round vote clears the previous vote from counting", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");
  await submitAllForCurrentRound(handler, session, 0);

  await voteFor(handler, session, "ホスト", 0, "ゲストA", "vote");
  let room = await editCurrentVoteFor(handler, session, "ホスト");
  assert.equal(room.game.phase, "round_vote");
  assert.equal(room.game.rounds[0].myVoteTargetId, "");

  room = await voteFor(handler, session, "ゲストA", 0, "ゲストB", "vote");
  room = await voteFor(handler, session, "ゲストB", 0, "ゲストA", "vote");
  assert.equal(room.game.phase, "round_vote");
});

test("tie can progress through revote and host decision", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");
  const resultRoom = await playRound(
    handler,
    session,
    0,
    [
      ["ホスト", "ゲストA"],
      ["ゲストA", "ゲストB"],
      ["ゲストB", "ホスト"]
    ],
    {
      revotePlan: [
        ["ホスト", "ゲストA"],
        ["ゲストA", "ゲストB"],
        ["ゲストB", "ホスト"]
      ],
      hostDecisionDisplayName: "ゲストA"
    }
  );

  assert.equal(resultRoom.game.phase, "round_result");
  assert.equal(resultRoom.game.rounds[0].winner.playerId, findPlayer(session, "ゲストA").playerId);
  assert.equal(resultRoom.game.rounds[0].winner.source, "host_decide");
  assert.deepEqual(resultRoom.game.rounds[0].revotedPlayerIds.sort(), session.players.map((player) => player.playerId).sort());
});

test("two-player round vote allows voting for your own word", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA"]);
  await startGame(handler, session, "ホスト");
  await submitAllForCurrentRound(handler, session, 0);

  let room = await voteFor(handler, session, "ホスト", 0, "ホスト", "vote");
  room = await voteFor(handler, session, "ゲストA", 0, "ゲストA", "vote");

  assert.equal(room.game.phase, "round_revote");
  assert.deepEqual(room.game.rounds[0].voteSummary.tiedPlayerIds.sort(), session.players.map((player) => player.playerId).sort());
});

test("host can proceed from round_result into next round", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");
  await playRound(handler, session, 0, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ゲストB"],
    ["ゲストB", "ゲストA"]
  ]);
  await closeRevealForAll(handler, session);

  const nextRoundRoom = await proceedRound(handler, session, 0);
  assert.equal(nextRoundRoom.game.phase, "round_submit");
  assert.equal(nextRoundRoom.game.roundIndex, 1);
  assert.equal(nextRoundRoom.game.rounds[1].phaseStatus, "submit");
  assert.equal(nextRoundRoom.game.currentTurnPlayerId, findPlayer(session, "ゲストA").playerId);
  assert.equal(nextRoundRoom.game.players.every((player) => player.handCount === 8), true);
});

test("final vote can resolve directly into final_result and restart to lobby", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  let room = await reachFinalVote(handler, session);

  room = await voteFinalFor(handler, session, room, "ホスト", "ゲストA", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストA", "ホスト", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストB", "ホスト", "vote");

  assert.equal(room.game.phase, "final_result");
  assert.equal(room.status, "finished");
  assert.equal(room.game.champion.playerId, findPlayer(session, "ホスト").playerId);
  assert.equal(room.game.champion.source, "initial");
  assert.equal(room.game.finalVote.phaseStatus, "finished");
  assert.deepEqual(room.game.finalVote.votedPlayerIds.sort(), session.players.map((player) => player.playerId).sort());
  assert.equal(room.game.reveal.kind, "champion");

  await closeRevealForAll(handler, session);

  const restartedRoom = await restartGame(handler, session);
  assert.equal(restartedRoom.status, "lobby");
  assert.equal(restartedRoom.game.phase, "lobby");
  assert.equal(restartedRoom.game.roundIndex, null);
  assert.equal(restartedRoom.game.finalVote, null);
  assert.equal(restartedRoom.myHand.length, 0);
});

test("two-player final vote allows voting for your own winning word", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA"]);
  await startGame(handler, session, "ホスト");

  await playRound(handler, session, 0, [
    ["ホスト", "ホスト"],
    ["ゲストA", "ゲストA"]
  ], {
    revotePlan: [
      ["ホスト", "ホスト"],
      ["ゲストA", "ゲストA"]
    ],
    hostDecisionDisplayName: "ホスト"
  });
  await closeRevealForAll(handler, session);
  await proceedRound(handler, session, 0);

  await playRound(handler, session, 1, [
    ["ホスト", "ホスト"],
    ["ゲストA", "ゲストA"]
  ], {
    revotePlan: [
      ["ホスト", "ホスト"],
      ["ゲストA", "ゲストA"]
    ],
    hostDecisionDisplayName: "ゲストA"
  });
  await closeRevealForAll(handler, session);
  await proceedRound(handler, session, 1);

  let room = await getRoom(handler, session.roomId, findPlayer(session, "ホスト").playerToken);
  assert.equal(room.game.phase, "final_vote");

  room = await voteFinalFor(handler, session, room, "ホスト", "ホスト", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストA", "ゲストA", "vote");

  assert.equal(room.game.phase, "final_revote");
  assert.equal(room.game.finalVote.voteSummary.tiedCandidateIds.length, 2);
});

test("final vote can be changed before everyone finishes voting", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  let room = await reachFinalVote(handler, session);
  const host = findPlayer(session, "ホスト");
  const firstCandidateId = room.game.finalVote.candidates[0].candidateId;
  const secondCandidateId = room.game.finalVote.candidates[1].candidateId;

  let response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/final-vote`, {
      headers: { "X-Omojan-Player-Token": host.playerToken },
      body: { candidateId: firstCandidateId }
    })
  );
  let body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.data.room.game.phase, "final_vote");

  response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/final-vote`, {
      headers: { "X-Omojan-Player-Token": host.playerToken },
      body: { candidateId: secondCandidateId }
    })
  );
  body = await parseResponse(response);
  assert.equal(response.statusCode, 200);

  room = await getRoom(handler, session.roomId, host.playerToken);
  assert.equal(room.game.phase, "final_vote");
  assert.equal(room.game.finalVote.myVoteCandidateId, secondCandidateId);
});

test("returning to final vote clears the previous vote from counting", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  let room = await reachFinalVote(handler, session);

  room = await voteFinalFor(handler, session, room, "ホスト", "ゲストA", "vote");
  room = await editCurrentVoteFor(handler, session, "ホスト");
  assert.equal(room.game.phase, "final_vote");
  assert.equal(room.game.finalVote.myVoteCandidateId, "");

  room = await voteFinalFor(handler, session, room, "ゲストA", "ホスト", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストB", "ホスト", "vote");
  assert.equal(room.game.phase, "final_vote");
});

test("recent champions includes newly finished game at the top", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  let room = await reachFinalVote(handler, session);

  room = await voteFinalFor(handler, session, room, "ホスト", "ゲストA", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストA", "ホスト", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストB", "ホスト", "vote");

  const response = await handler(createEvent("GET", "/v1/champions/recent", { query: { limit: "3" } }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items[0].displayName, room.game.champion.displayName);
  assert.equal(body.data.items[0].phrase, room.game.champion.phrase);
  assert.match(body.data.items[0].championId, /^ch_/);
  assert.equal(body.data.items.length, 3);
});

test("final tie can progress through final_revote and final_host_decide", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  let room = await reachFinalVote(handler, session);

  room = await voteFinalFor(handler, session, room, "ホスト", "ゲストA", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストA", "ゲストB", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストB", "ホスト", "vote");
  assert.equal(room.game.phase, "final_revote");

  room = await voteFinalFor(handler, session, room, "ホスト", "ゲストA", "revote");
  room = await voteFinalFor(handler, session, room, "ゲストA", "ゲストB", "revote");
  room = await voteFinalFor(handler, session, room, "ゲストB", "ホスト", "revote");
  assert.equal(room.game.phase, "final_host_decide");

  room = await finalHostDecisionFor(handler, session, room, "ゲストB");
  assert.equal(room.game.phase, "final_result");
  assert.equal(room.game.champion.playerId, findPlayer(session, "ゲストB").playerId);
  assert.equal(room.game.champion.source, "host_decide");
  assert.deepEqual(room.game.finalVote.revotedPlayerIds.sort(), session.players.map((player) => player.playerId).sort());
});

test("final vote excludes players who only have their own words as candidates", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB", "ゲストC"]);
  await startGame(handler, session, "ホスト");

  await playRound(handler, session, 0, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ホスト"],
    ["ゲストB", "ゲストA"],
    ["ゲストC", "ゲストA"]
  ]);
  await closeRevealForAll(handler, session);
  await proceedRound(handler, session, 0);

  await playRound(handler, session, 1, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ホスト"],
    ["ゲストB", "ゲストA"],
    ["ゲストC", "ゲストA"]
  ]);
  await closeRevealForAll(handler, session);
  await proceedRound(handler, session, 1);

  await playRound(handler, session, 2, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ホスト"],
    ["ゲストB", "ゲストA"],
    ["ゲストC", "ゲストA"]
  ]);
  await closeRevealForAll(handler, session);
  await proceedRound(handler, session, 2);

  await playRound(handler, session, 3, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ホスト"],
    ["ゲストB", "ゲストA"],
    ["ゲストC", "ゲストA"]
  ]);
  await closeRevealForAll(handler, session);

  let room = await proceedRound(handler, session, 3);
  assert.equal(room.game.phase, "final_vote");
  assert.equal(room.game.finalVote.candidates.every((candidate) => candidate.playerId === findPlayer(session, "ゲストA").playerId), true);

  room = await voteFinalFor(handler, session, room, "ホスト", "ゲストA", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストB", "ゲストA", "vote");
  room = await voteFinalFor(handler, session, room, "ゲストC", "ゲストA", "vote");

  assert.equal(room.game.phase, "final_result");
  assert.equal(room.game.champion.playerId, findPlayer(session, "ゲストA").playerId);
  assert.deepEqual(
    room.game.finalVote.votedPlayerIds.sort(),
    [findPlayer(session, "ホスト").playerId, findPlayer(session, "ゲストB").playerId, findPlayer(session, "ゲストC").playerId].sort()
  );
});

test("reveal close is required before the next action can continue", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");

  const submittedRoom = await submitFor(handler, session, findPlayer(session, "ホスト"), 0);
  assert.equal(submittedRoom.game.reveal.kind, "submission");

  const blockedResponse = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/rounds/0/submit`, {
      headers: {
        "X-Omojan-Player-Token": findPlayer(session, "ゲストA").playerToken
      },
      body: buildSubmitPayload(await getRoom(handler, session.roomId, findPlayer(session, "ゲストA").playerToken))
    })
  );
  const blockedBody = await parseResponse(blockedResponse);
  assert.equal(blockedResponse.statusCode, 409);
  assert.equal(blockedBody.error.code, "REVEAL_PENDING");

  const halfClosedRoom = await closeRevealFor(handler, session, findPlayer(session, "ホスト"));
  assert.deepEqual(halfClosedRoom.game.reveal.acknowledgedPlayerIds, [findPlayer(session, "ホスト").playerId]);

  const clearedRoom = await closeRevealForAll(handler, session);
  assert.equal(clearedRoom.game.reveal, null);
  assert.equal(clearedRoom.game.currentTurnPlayerId, findPlayer(session, "ゲストA").playerId);
});

test("round count matches player count and start player rotates every round", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB", "ゲストC"]);
  let room = await startGame(handler, session, "ホスト");

  assert.equal(room.game.rounds.length, 4);
  assert.equal(room.game.currentTurnPlayerId, findPlayer(session, "ホスト").playerId);

  for (let roundIndex = 0; roundIndex < 3; roundIndex += 1) {
    room = await playRound(handler, session, roundIndex, [
      ["ホスト", "ゲストA"],
      ["ゲストA", "ゲストB"],
      ["ゲストB", "ゲストA"],
      ["ゲストC", "ゲストA"]
    ]);
    room = await closeRevealForAll(handler, session);
    room = await proceedRound(handler, session, roundIndex);
  }

  assert.equal(room.game.roundIndex, 3);
  assert.equal(room.game.currentTurnPlayerId, findPlayer(session, "ゲストC").playerId);
});
