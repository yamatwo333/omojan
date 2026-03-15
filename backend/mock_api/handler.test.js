const test = require("node:test");
const assert = require("node:assert/strict");
const { handler, roomStore } = require("./handler");

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
  return JSON.parse(response.body);
}

async function createLiveRoom(playerCount = 4) {
  const createResponse = await handler(
    createEvent("POST", "/v1/rooms", {
      body: {
        displayName: "あなた",
        playerCount
      }
    })
  );
  const createBody = await parseResponse(createResponse);
  return {
    roomId: createBody.data.room.roomId,
    playerToken: createBody.data.playerToken,
    room: createBody.data.room
  };
}

async function callJson(method, path, options = {}) {
  const response = await handler(createEvent(method, path, options));
  const body = await parseResponse(response);
  return { response, body };
}

async function advanceToFinalVote(live) {
  const headers = { "X-Omojan-Player-Token": live.playerToken };

  await callJson("POST", `/v1/rooms/${live.roomId}/start-player`, {
    headers,
    body: { startPlayerId: "player_you" }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/start`, {
    headers,
    body: { deckId: "default" }
  });

  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/0/submit`, {
    headers,
    body: {
      tileIds: ["tile_001", "tile_002"],
      tileOrder: [1, 0],
      phrase: "謝罪現場猫",
      fontId: "broadcast",
      lineMode: "manual",
      manualBreaks: [2],
      renderedLines: ["謝罪", "現場猫"]
    }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/0/vote`, {
    headers,
    body: { targetPlayerId: "player_host" }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/0/proceed`, {
    headers,
    body: {}
  });

  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/1/submit`, {
    headers,
    body: {
      tileIds: ["tile_003", "tile_004"],
      tileOrder: [0, 1],
      phrase: "深夜大反省",
      fontId: "heavy",
      lineMode: "single",
      manualBreaks: [],
      renderedLines: ["深夜大反省"]
    }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/1/vote`, {
    headers,
    body: { targetPlayerId: "player_host" }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/1/revote`, {
    headers,
    body: { targetPlayerId: "player_host" }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/1/host-decision`, {
    headers,
    body: { winnerPlayerId: "player_tanaka" }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/1/proceed`, {
    headers,
    body: {}
  });

  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/2/submit`, {
    headers,
    body: {
      tileIds: ["tile_005", "tile_006"],
      tileOrder: [0, 1],
      phrase: "ラーメン薄",
      fontId: "round",
      lineMode: "single",
      manualBreaks: [],
      renderedLines: ["ラーメン薄"]
    }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/2/vote`, {
    headers,
    body: { targetPlayerId: "player_host" }
  });

  return callJson("POST", `/v1/rooms/${live.roomId}/rounds/2/proceed`, {
    headers,
    body: {}
  });
}

test.afterEach(() => {
  roomStore.clear();
});

test("GET /v1/champions/recent returns recent items", async () => {
  const response = await handler(createEvent("GET", "/v1/champions/recent", { query: { limit: "3" } }));
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 3);
});

test("GET /v1/rooms/:roomId returns room scenario", async () => {
  const response = await handler(createEvent("GET", "/v1/rooms/room_omo_2048", { query: { scenario: "round_vote" } }));
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.room.game.phase, "round_vote");
});

test("POST /v1/rooms creates mock host room", async () => {
  const response = await handler(
    createEvent("POST", "/v1/rooms", {
      body: {
        displayName: "テストホスト",
        playerCount: 3
      }
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.room.me.isHost, true);
  assert.equal(body.data.room.playerCount, 3);
  assert.equal(body.data.room.hostPlayerId, "player_you");
});

test("POST /v1/rooms/:roomId/reconnect requires player token", async () => {
  const live = await createLiveRoom();
  const response = await handler(createEvent("POST", `/v1/rooms/${live.roomId}/reconnect`));
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 401);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "PLAYER_TOKEN_INVALID");
});

test("live room can start and move to round_submit", async () => {
  const live = await createLiveRoom();

  let result = await callJson("POST", `/v1/rooms/${live.roomId}/start-player`, {
    headers: {
      "X-Omojan-Player-Token": live.playerToken
    },
    body: {
      startPlayerId: "player_you"
    }
  });
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body.data.room.playerOrder, ["player_you", "player_host", "player_tanaka", "player_miki"]);

  result = await callJson("POST", `/v1/rooms/${live.roomId}/start`, {
    headers: {
      "X-Omojan-Player-Token": live.playerToken
    },
    body: {
      deckId: "default"
    }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "round_submit");
  assert.equal(result.body.data.room.game.currentTurnPlayerId, "player_you");
  assert.equal(result.body.data.room.myHand.length, 10);
});

test("submit and vote can resolve round 1 into round_result", async () => {
  const live = await createLiveRoom();

  await callJson("POST", `/v1/rooms/${live.roomId}/start-player`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: { startPlayerId: "player_you" }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/start`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: { deckId: "default" }
  });

  let result = await callJson("POST", `/v1/rooms/${live.roomId}/rounds/0/submit`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: {
      tileIds: ["tile_001", "tile_002"],
      tileOrder: [1, 0],
      phrase: "謝罪現場猫",
      fontId: "broadcast",
      lineMode: "manual",
      manualBreaks: [2],
      renderedLines: ["謝罪", "現場猫"]
    }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "round_vote");
  assert.equal(result.body.data.room.game.rounds[0].submissions.length, 4);

  result = await callJson("POST", `/v1/rooms/${live.roomId}/rounds/0/vote`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: {
      targetPlayerId: "player_host"
    }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "round_result");
  assert.equal(result.body.data.room.game.rounds[0].winner.playerId, "player_you");
});

test("round 2 can enter revote and host decision", async () => {
  const live = await createLiveRoom();

  await callJson("POST", `/v1/rooms/${live.roomId}/start-player`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: { startPlayerId: "player_you" }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/start`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: { deckId: "default" }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/0/submit`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: {
      tileIds: ["tile_001", "tile_002"],
      tileOrder: [1, 0],
      phrase: "謝罪現場猫",
      fontId: "broadcast",
      lineMode: "manual",
      manualBreaks: [2],
      renderedLines: ["謝罪", "現場猫"]
    }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/0/vote`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: { targetPlayerId: "player_host" }
  });
  await callJson("POST", `/v1/rooms/${live.roomId}/rounds/0/proceed`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: {}
  });

  let result = await callJson("POST", `/v1/rooms/${live.roomId}/rounds/1/submit`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: {
      tileIds: ["tile_003", "tile_004"],
      tileOrder: [0, 1],
      phrase: "深夜大反省",
      fontId: "heavy",
      lineMode: "single",
      manualBreaks: [],
      renderedLines: ["深夜大反省"]
    }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "round_vote");

  result = await callJson("POST", `/v1/rooms/${live.roomId}/rounds/1/vote`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: { targetPlayerId: "player_host" }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "round_revote");
  assert.deepEqual(result.body.data.room.game.rounds[1].voteSummary.tiedPlayerIds.sort(), ["player_host", "player_tanaka"]);

  result = await callJson("POST", `/v1/rooms/${live.roomId}/rounds/1/revote`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: { targetPlayerId: "player_host" }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "round_host_decide");

  result = await callJson("POST", `/v1/rooms/${live.roomId}/rounds/1/host-decision`, {
    headers: { "X-Omojan-Player-Token": live.playerToken },
    body: { winnerPlayerId: "player_tanaka" }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "round_result");
  assert.equal(result.body.data.room.game.rounds[1].winner.playerId, "player_tanaka");
});

test("final vote can enter final_revote and final_host_decide", async () => {
  const live = await createLiveRoom();
  const headers = { "X-Omojan-Player-Token": live.playerToken };

  let result = await advanceToFinalVote(live);
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "final_vote");

  result = await callJson("POST", `/v1/rooms/${live.roomId}/final-vote`, {
    headers,
    body: { candidateId: "final_round2" }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "final_revote");
  assert.deepEqual(result.body.data.room.game.finalVote.voteSummary.tiedCandidateIds.sort(), ["final_round2", "final_round3"]);

  result = await callJson("POST", `/v1/rooms/${live.roomId}/final-revote`, {
    headers,
    body: { candidateId: "final_round2" }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "final_host_decide");

  result = await callJson("POST", `/v1/rooms/${live.roomId}/final-host-decision`, {
    headers,
    body: { candidateId: "final_round3" }
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.body.data.room.game.phase, "final_result");
  assert.equal(result.body.data.room.game.champion.playerId, "player_host");
});
