const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler, createMemoryRoomRepository, normalizePathname } = require("./handler");

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
  await proceedRound(handler, session, 0);

  await playRound(handler, session, 1, [
    ["ホスト", "ゲストB"],
    ["ゲストA", "ゲストB"],
    ["ゲストB", "ホスト"]
  ]);
  await proceedRound(handler, session, 1);

  await playRound(handler, session, 2, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ホスト"],
    ["ゲストB", "ホスト"]
  ]);

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
  assert.equal(room.game.rounds[0].phaseStatus, "submit");
});

test("submit advances turn and last submission moves to round_vote", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");

  const firstSubmitRoom = await submitFor(handler, session, findPlayer(session, "ホスト"), 0);
  assert.equal(firstSubmitRoom.game.phase, "round_submit");
  assert.equal(firstSubmitRoom.game.currentTurnPlayerId, findPlayer(session, "ゲストA").playerId);
  assert.equal(firstSubmitRoom.myHand.filter((tile) => tile.isUsed).length, 2);

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

test("host can proceed from round_result into next round", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");
  await playRound(handler, session, 0, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ゲストB"],
    ["ゲストB", "ゲストA"]
  ]);

  const nextRoundRoom = await proceedRound(handler, session, 0);
  assert.equal(nextRoundRoom.game.phase, "round_submit");
  assert.equal(nextRoundRoom.game.roundIndex, 1);
  assert.equal(nextRoundRoom.game.rounds[1].phaseStatus, "submit");
  assert.equal(nextRoundRoom.game.currentTurnPlayerId, findPlayer(session, "ホスト").playerId);
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

  const restartedRoom = await restartGame(handler, session);
  assert.equal(restartedRoom.status, "lobby");
  assert.equal(restartedRoom.game.phase, "lobby");
  assert.equal(restartedRoom.game.roundIndex, null);
  assert.equal(restartedRoom.game.finalVote, null);
  assert.equal(restartedRoom.myHand.length, 0);
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
  await proceedRound(handler, session, 0);

  await playRound(handler, session, 1, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ホスト"],
    ["ゲストB", "ゲストA"],
    ["ゲストC", "ゲストA"]
  ]);
  await proceedRound(handler, session, 1);

  await playRound(handler, session, 2, [
    ["ホスト", "ゲストA"],
    ["ゲストA", "ホスト"],
    ["ゲストB", "ゲストA"],
    ["ゲストC", "ゲストA"]
  ]);

  let room = await proceedRound(handler, session, 2);
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
