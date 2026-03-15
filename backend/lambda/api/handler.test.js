const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler, createMemoryRoomRepository } = require("./handler");

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

function createTestHandler() {
  return createHandler({
    roomRepository: createMemoryRoomRepository()
  });
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

async function voteFor(handler, session, player, roundIndex, targetPlayerId, mode = "vote") {
  const endpoint = mode === "revote" ? "revote" : "vote";
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/rounds/${roundIndex}/${endpoint}`, {
      headers: {
        "X-Omojan-Player-Token": player.playerToken
      },
      body: {
        targetPlayerId
      }
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  return body.data.room;
}

async function hostDecisionFor(handler, session, roundIndex, winnerPlayerId) {
  const host = session.players[0];
  const response = await handler(
    createEvent("POST", `/v1/rooms/${session.roomId}/rounds/${roundIndex}/host-decision`, {
      headers: {
        "X-Omojan-Player-Token": host.playerToken
      },
      body: {
        winnerPlayerId
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
    "rounds:proceed"
  ]);
});

test("GET /v1/champions/recent returns recent items", async () => {
  const handler = createTestHandler();
  const response = await handler(createEvent("GET", "/v1/champions/recent", { query: { limit: "2" } }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 2);
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
  await submitAllForCurrentRound(handler, session, 0);

  const host = findPlayer(session, "ホスト");
  const guestA = findPlayer(session, "ゲストA");
  const guestB = findPlayer(session, "ゲストB");

  const afterFirstVote = await voteFor(handler, session, host, 0, guestA.playerId, "vote");
  assert.equal(afterFirstVote.game.phase, "round_vote");
  assert.deepEqual(afterFirstVote.game.rounds[0].votedPlayerIds, [host.playerId]);
  assert.equal("votes" in afterFirstVote.game.rounds[0], false);

  await voteFor(handler, session, guestA, 0, guestB.playerId, "vote");
  const resultRoom = await voteFor(handler, session, guestB, 0, guestA.playerId, "vote");

  assert.equal(resultRoom.game.phase, "round_result");
  assert.equal(resultRoom.game.rounds[0].winner.playerId, guestA.playerId);
  assert.equal(resultRoom.game.rounds[0].winner.source, "initial");
  assert.equal(resultRoom.game.rounds[0].voteSummary.counts.find((item) => item.playerId === guestA.playerId).count, 2);
});

test("tie can progress through revote and host decision", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");
  await submitAllForCurrentRound(handler, session, 0);

  const host = findPlayer(session, "ホスト");
  const guestA = findPlayer(session, "ゲストA");
  const guestB = findPlayer(session, "ゲストB");

  await voteFor(handler, session, host, 0, guestA.playerId, "vote");
  await voteFor(handler, session, guestA, 0, guestB.playerId, "vote");
  const revoteRoom = await voteFor(handler, session, guestB, 0, host.playerId, "vote");

  assert.equal(revoteRoom.game.phase, "round_revote");
  assert.deepEqual(
    [...revoteRoom.game.rounds[0].voteSummary.tiedPlayerIds].sort(),
    [host.playerId, guestA.playerId, guestB.playerId].sort()
  );

  await voteFor(handler, session, host, 0, guestA.playerId, "revote");
  await voteFor(handler, session, guestA, 0, guestB.playerId, "revote");
  const hostDecideRoom = await voteFor(handler, session, guestB, 0, host.playerId, "revote");

  assert.equal(hostDecideRoom.game.phase, "round_host_decide");
  assert.deepEqual(
    [...hostDecideRoom.game.rounds[0].voteSummary.tiedPlayerIds].sort(),
    [host.playerId, guestA.playerId, guestB.playerId].sort()
  );

  const resultRoom = await hostDecisionFor(handler, session, 0, guestA.playerId);
  assert.equal(resultRoom.game.phase, "round_result");
  assert.equal(resultRoom.game.rounds[0].winner.playerId, guestA.playerId);
  assert.equal(resultRoom.game.rounds[0].winner.source, "host_decide");
});

test("host can proceed from round_result into next round", async () => {
  const handler = createTestHandler();
  const session = await createSession(handler, ["ホスト", "ゲストA", "ゲストB"]);
  await startGame(handler, session, "ホスト");
  await submitAllForCurrentRound(handler, session, 0);

  const host = findPlayer(session, "ホスト");
  const guestA = findPlayer(session, "ゲストA");
  const guestB = findPlayer(session, "ゲストB");
  await voteFor(handler, session, host, 0, guestA.playerId, "vote");
  await voteFor(handler, session, guestA, 0, guestB.playerId, "vote");
  await voteFor(handler, session, guestB, 0, guestA.playerId, "vote");

  const nextRoundRoom = await proceedRound(handler, session, 0);
  assert.equal(nextRoundRoom.game.phase, "round_submit");
  assert.equal(nextRoundRoom.game.roundIndex, 1);
  assert.equal(nextRoundRoom.game.rounds[1].phaseStatus, "submit");
  assert.equal(nextRoundRoom.game.currentTurnPlayerId, host.playerId);
  assert.equal(nextRoundRoom.game.players.every((player) => player.handCount === 8), true);
});

test("POST final vote still returns not implemented in lambda", async () => {
  const handler = createTestHandler();
  const response = await handler(createEvent("POST", "/v1/rooms/room_x/final-vote", { body: {} }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 501);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "NOT_IMPLEMENTED");
});
