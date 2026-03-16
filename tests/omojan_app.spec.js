const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const API_BASE = "http://127.0.0.1:8788/v1";
const STATIC_URL = "http://127.0.0.1:8000/omojan_app.html?apiBaseUrl=http%3A%2F%2F127.0.0.1%3A8788%2Fv1";

let staticServer = null;
let apiServer = null;

function waitForPort(port, host = "127.0.0.1", timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function startServers() {
  staticServer = spawn("python3", ["-m", "http.server", "8000"], {
    cwd: ROOT,
    stdio: "ignore"
  });
  apiServer = spawn("node", ["backend/lambda/api/local_server.js"], {
    cwd: ROOT,
    stdio: "ignore"
  });
  await Promise.all([waitForPort(8000), waitForPort(8788)]);
}

async function stopServers() {
  for (const child of [staticServer, apiServer]) {
    if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

async function api(pathname, options = {}, playerToken = "") {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };
  if (playerToken) {
    headers["X-Omojan-Player-Token"] = playerToken;
  }
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  }
  return payload.data;
}

async function setupRoundVoteRoom() {
  const created = await api("/rooms", {
    method: "POST",
    body: JSON.stringify({ displayName: "HostAppTest", playerCount: 2 })
  });
  const roomId = created.room.roomId;
  const hostToken = created.playerToken;
  const inviteCode = created.room.inviteCode;

  const joined = await api("/rooms/join", {
    method: "POST",
    body: JSON.stringify({ inviteCode, displayName: "GuestAppTest" })
  });
  const guestToken = joined.playerToken;

  await api(
    `/rooms/${encodeURIComponent(roomId)}/start-player`,
    {
      method: "POST",
      body: JSON.stringify({ startPlayerId: created.room.me.playerId })
    },
    hostToken
  );
  const started = await api(
    `/rooms/${encodeURIComponent(roomId)}/start`,
    {
      method: "POST",
      body: JSON.stringify({ deckId: "default" })
    },
    hostToken
  );
  const hostTiles = started.room.myHand.slice(0, 2);
  await api(
    `/rooms/${encodeURIComponent(roomId)}/rounds/0/submit`,
    {
      method: "POST",
      body: JSON.stringify({
        tileIds: hostTiles.map((tile) => tile.tileId),
        tileOrder: [0, 1],
        phrase: hostTiles.map((tile) => tile.text).join(""),
        fontId: "broadcast",
        lineMode: "boundary",
        manualBreaks: [],
        renderedLines: hostTiles.map((tile) => tile.text)
      })
    },
    hostToken
  );

  const guestRoom = await api(`/rooms/${encodeURIComponent(roomId)}/reconnect`, { method: "POST" }, guestToken);
  const guestTiles = guestRoom.room.myHand.slice(0, 2);
  await api(
    `/rooms/${encodeURIComponent(roomId)}/rounds/0/submit`,
    {
      method: "POST",
      body: JSON.stringify({
        tileIds: guestTiles.map((tile) => tile.tileId),
        tileOrder: [0, 1],
        phrase: guestTiles.map((tile) => tile.text).join(""),
        fontId: "broadcast",
        lineMode: "boundary",
        manualBreaks: [],
        renderedLines: guestTiles.map((tile) => tile.text)
      })
    },
    guestToken
  );

  return { roomId, hostToken };
}

async function createTwoPlayerRoom(browser) {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto(STATIC_URL);
  await host.fill("#createDisplayName", "HostFlowTest");
  await host.getByRole("button", { name: "2人" }).click();
  await host.getByRole("button", { name: "ルームを作る" }).click();
  await expect(host.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();

  const inviteCode = ((await host.locator(".room-code").textContent()) || "").trim();

  await guest.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await guest.fill("#joinDisplayName", "GuestFlowTest");
  await guest.getByRole("button", { name: "参加する" }).click();
  await expect(guest.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();

  return { hostContext, guestContext, host, guest };
}

async function submitCurrentDraft(page) {
  const submitButton = page.locator('button[data-action="submit-word"]');
  await expect(submitButton).toBeEnabled();
  await submitButton.click();
  await expect(page.locator("#revealOverlay")).toBeHidden({ timeout: 5000 });
}

async function reconnect(page) {
  await page.reload();
  await expect(page.locator("#statusLabel")).toContainText("接続中");
}

async function reopenWithStoredSession(browser, context, expectHeading) {
  const storageState = await context.storageState();
  await context.close();
  const reopenedContext = await browser.newContext({ storageState });
  const page = await reopenedContext.newPage();
  await page.goto(STATIC_URL);
  if (expectHeading) {
    await expect(page.getByRole("heading", { name: expectHeading, exact: true })).toBeVisible({ timeout: 10000 });
  }
  return { context: reopenedContext, page };
}

async function submitCurrentVote(page, action = "submit-vote") {
  const candidate = page.locator(
    action === "submit-final-vote" ? "[data-final-vote-id]:not([disabled])" : "[data-vote-id]:not([disabled])"
  ).first();
  await candidate.click();
  await expect(candidate).toHaveAttribute("aria-pressed", "true");
  await page.locator(`button[data-action="${action}"]`).click();
}

async function completeRoundByHostDecision(host, guest, roundLabel, hostDecisionWinnerName) {
  await expect(host.locator("body")).toContainText("HostFlowTest の手番");
  await expect(guest.locator("body")).toContainText("HostFlowTest の手番");

  await submitCurrentDraft(host);

  await reconnect(guest);
  await expect(guest.locator("body")).toContainText("GuestFlowTest の手番", { timeout: 10000 });
  await submitCurrentDraft(guest);

  await reconnect(host);
  await reconnect(guest);
  await expect(host.getByRole("heading", { name: "このラウンドで一番おもしろいワードに投票" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "このラウンドで一番おもしろいワードに投票" })).toBeVisible({ timeout: 10000 });

  await submitCurrentVote(host, "submit-vote");
  await submitCurrentVote(guest, "submit-vote");

  await reconnect(host);
  await reconnect(guest);
  await expect(host.getByRole("heading", { name: "再投票" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "再投票" })).toBeVisible({ timeout: 10000 });

  await host.locator("[data-revote-id]:not([disabled])").first().click();
  await guest.locator("[data-revote-id]:not([disabled])").first().click();
  await host.locator('button[data-action="submit-revote"]').click();
  await guest.locator('button[data-action="submit-revote"]').click();

  await reconnect(host);
  await expect(host.getByRole("heading", { name: "ホスト裁定" })).toBeVisible({ timeout: 10000 });
  await host.locator("[data-host-pick-id]", { hasText: hostDecisionWinnerName }).click();
  await host.locator('button[data-action="submit-host-pick"]').click();

  await reconnect(host);
  await reconnect(guest);
  await expect(host.getByRole("heading", { name: roundLabel })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: roundLabel })).toBeVisible({ timeout: 10000 });
  await expect(host.locator("body")).toContainText("票数内訳");
  await expect(guest.locator("body")).toContainText("票数内訳");
}

test.beforeAll(async () => {
  await startServers();
});

test.afterAll(async () => {
  await stopServers();
});

test("app vote card selection enables submit button", async ({ page }) => {
  const session = await setupRoundVoteRoom();

  await page.goto(STATIC_URL);
  await page.evaluate(({ roomId, hostToken }) => {
    window.localStorage.setItem("omojan-app-room-id", roomId);
    window.localStorage.setItem("omojan-app-player-token", hostToken);
  }, session);
  await page.reload();

  await expect(page.getByRole("heading", { name: "このラウンドで一番おもしろいワードに投票" })).toBeVisible();
  const voteCandidate = page.locator("[data-vote-id]:not([disabled])").first();
  await voteCandidate.click();

  await expect(voteCandidate).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('button[data-action="submit-vote"]')).toBeEnabled();
});

test("app can complete create, join, start, submit, vote, host decision, and show round result", async ({ browser }) => {
  const { hostContext, guestContext, host, guest } = await createTwoPlayerRoom(browser);

  await host.getByRole("button", { name: "この順で開始" }).click();

  await completeRoundByHostDecision(host, guest, "ラウンド1", "GuestFlowTest");

  await hostContext.close();
  await guestContext.close();
});

test("app can complete a full game through final champion and restart", async ({ browser }) => {
  test.setTimeout(60000);

  const { hostContext, guestContext, host, guest } = await createTwoPlayerRoom(browser);

  await host.getByRole("button", { name: "この順で開始" }).click();

  await completeRoundByHostDecision(host, guest, "ラウンド1", "GuestFlowTest");
  await host.getByRole("button", { name: "次のラウンドへ" }).click();
  await reconnect(guest);

  await completeRoundByHostDecision(host, guest, "ラウンド2", "HostFlowTest");
  await host.getByRole("button", { name: "次のラウンドへ" }).click();
  await reconnect(guest);

  await completeRoundByHostDecision(host, guest, "ラウンド3", "GuestFlowTest");
  await host.getByRole("button", { name: "最終投票へ進む" }).click();
  await reconnect(guest);

  await expect(host.getByRole("heading", { name: "最終投票" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "最終投票" })).toBeVisible({ timeout: 10000 });
  await submitCurrentVote(host, "submit-final-vote");
  await submitCurrentVote(guest, "submit-final-vote");

  await reconnect(host);
  await reconnect(guest);
  await expect(host.getByRole("heading", { name: "最終再投票" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "最終再投票" })).toBeVisible({ timeout: 10000 });
  await host.locator("[data-final-vote-id]:not([disabled])").first().click();
  await guest.locator("[data-final-vote-id]:not([disabled])").first().click();
  await host.locator('button[data-action="submit-final-vote"]').click();
  await guest.locator('button[data-action="submit-final-vote"]').click();

  await reconnect(host);
  await expect(host.getByRole("heading", { name: "最終ホスト裁定" })).toBeVisible({ timeout: 10000 });
  const finalPick = host.locator("[data-final-pick-id]").first();
  const championPhrase = ((await finalPick.locator(".muted").textContent()) || "").trim();
  await finalPick.click();
  await host.locator('button[data-action="submit-final-host-pick"]').click();

  await expect(host.locator("#revealOverlay")).toBeVisible({ timeout: 10000 });
  await expect(host.locator("#revealOverlay")).toContainText("総合優勝");
  await host.locator("#closeRevealBtn").click();

  await reconnect(host);
  await reconnect(guest);
  await expect(host.getByRole("heading", { name: "総合優勝" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "総合優勝" })).toBeVisible({ timeout: 10000 });
  await expect(host.locator("body")).toContainText(championPhrase);
  await expect(guest.locator("body")).toContainText(championPhrase);

  await host.getByRole("button", { name: "もう一度最初から" }).click();
  await reconnect(guest);
  await expect(host.getByRole("heading", { name: "ルーム待機中" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "ルーム待機中" })).toBeVisible({ timeout: 10000 });

  await hostContext.close();
  await guestContext.close();
});

test("app restores session after reopening the browser context", async ({ browser }) => {
  test.setTimeout(60000);

  let { hostContext, guestContext, host, guest } = await createTwoPlayerRoom(browser);

  await host.getByRole("button", { name: "この順で開始" }).click();
  await expect(host.locator("body")).toContainText("HostFlowTest の手番");
  await expect(guest.locator("body")).toContainText("HostFlowTest の手番");

  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext, "待機"));
  await expect(guest.locator("body")).toContainText("HostFlowTest の手番");

  await submitCurrentDraft(host);

  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext));
  await expect(guest.locator("body")).toContainText("GuestFlowTest の手番");
  await submitCurrentDraft(guest);

  ({ context: hostContext, page: host } = await reopenWithStoredSession(browser, hostContext, "このラウンドで一番おもしろいワードに投票"));
  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext, "このラウンドで一番おもしろいワードに投票"));

  await submitCurrentVote(host, "submit-vote");
  await submitCurrentVote(guest, "submit-vote");

  ({ context: hostContext, page: host } = await reopenWithStoredSession(browser, hostContext, "再投票"));
  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext, "再投票"));

  await host.locator("[data-revote-id]:not([disabled])").first().click();
  await guest.locator("[data-revote-id]:not([disabled])").first().click();
  await host.locator('button[data-action="submit-revote"]').click();
  await guest.locator('button[data-action="submit-revote"]').click();

  ({ context: hostContext, page: host } = await reopenWithStoredSession(browser, hostContext, "ホスト裁定"));
  await host.locator("[data-host-pick-id]", { hasText: "GuestFlowTest" }).click();
  await host.locator('button[data-action="submit-host-pick"]').click();

  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext, "ラウンド1"));
  await expect(guest.locator("body")).toContainText("票数内訳");

  await hostContext.close();
  await guestContext.close();
});
