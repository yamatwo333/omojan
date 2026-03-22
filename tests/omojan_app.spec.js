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
  staticServer = spawn("python3", ["-m", "http.server", "8000", "--bind", "127.0.0.1"], {
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
        sizePreset: "large",
        lineGapPreset: "normal",
        lineMode: "boundary",
        manualBreaks: [],
        renderedLines: hostTiles.map((tile) => tile.text)
      })
    },
    hostToken
  );
  await api(`/rooms/${encodeURIComponent(roomId)}/reveal-close`, { method: "POST", body: JSON.stringify({}) }, hostToken);
  await api(`/rooms/${encodeURIComponent(roomId)}/reveal-close`, { method: "POST", body: JSON.stringify({}) }, guestToken);

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
        sizePreset: "large",
        lineGapPreset: "normal",
        lineMode: "boundary",
        manualBreaks: [],
        renderedLines: guestTiles.map((tile) => tile.text)
      })
    },
    guestToken
  );
  await api(`/rooms/${encodeURIComponent(roomId)}/reveal-close`, { method: "POST", body: JSON.stringify({}) }, hostToken);
  await api(`/rooms/${encodeURIComponent(roomId)}/reveal-close`, { method: "POST", body: JSON.stringify({}) }, guestToken);

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

  await guest.goto(STATIC_URL);
  await guest.evaluate(() => {
    window.localStorage.setItem("omojan-app-last-display-name", "GuestFlowTest");
  });
  await guest.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await expect(guest.getByRole("heading", { name: "このルームに参加" })).toBeVisible();
  await expect(guest.locator("#joinDisplayNameInvite")).toHaveValue("GuestFlowTest");
  await expect(guest.locator("#inviteCode")).toHaveCount(0);
  await guest.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(guest.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();
  await expect(guest.locator("body")).toContainText("GuestFlowTest");

  return { hostContext, guestContext, host, guest };
}

async function submitCurrentDraft(page) {
  const submitButton = page.locator('button[data-action="submit-word"]');
  await expect(submitButton).toBeEnabled();
  await submitButton.click();
  await expect(page.locator("#revealOverlay")).toBeVisible({ timeout: 5000 });
}

async function reconnect(page) {
  await page.reload();
  await expect(page.locator("#statusLabel")).toContainText("接続中");
}

async function acknowledgeRevealOn(page) {
  if (!(await page.locator("#revealOverlay").isVisible())) {
    await reconnect(page);
  }
  await expect(page.locator("#revealOverlay")).toBeVisible({ timeout: 10000 });
  const closeButton = page.locator("#closeRevealBtn");
  await expect(closeButton).toBeEnabled();
  await closeButton.click();
}

async function acknowledgeRevealForAll(pages) {
  for (const page of pages) {
    await acknowledgeRevealOn(page);
  }
  for (const page of pages) {
    await reconnect(page);
    await expect(page.locator("#revealOverlay")).toBeHidden({ timeout: 10000 });
  }
}

async function reopenWithStoredSession(browser, context, expectHeading) {
  const storageState = await context.storageState();
  await context.close();
  const reopenedContext = await browser.newContext({ storageState });
  const page = await reopenedContext.newPage();
  await page.goto(STATIC_URL);
  if (expectHeading) {
    if (typeof expectHeading === "string") {
      await expect(page.getByRole("heading", { name: expectHeading, exact: true })).toBeVisible({ timeout: 10000 });
    } else if (expectHeading.selector) {
      await expect(page.locator(expectHeading.selector)).toBeVisible({ timeout: 10000 });
    } else if (expectHeading.text) {
      await expect(page.locator("body")).toContainText(expectHeading.text, { timeout: 10000 });
    }
  }
  return { context: reopenedContext, page };
}

async function submitCurrentVote(page, action = "submit-vote", targetDisplayName = "") {
  const selector = action === "submit-final-vote" ? "[data-final-vote-id]:not([disabled])" : "[data-vote-id]:not([disabled])";
  const candidate = targetDisplayName
    ? page.locator(selector, { hasText: targetDisplayName }).first()
    : page.locator(selector).first();
  await candidate.click();
  await expect(candidate).toHaveAttribute("aria-pressed", "true");
  const actionButton = page.locator(`button[data-action="${action}"]`);
  await Promise.all([
    page.waitForResponse((response) => {
      if (response.request().method() !== "POST" || response.status() !== 200) {
        return false;
      }
      const url = response.url();
      if (action === "submit-vote") {
        return /\/rounds\/\d+\/vote$/.test(url);
      }
      if (action === "submit-final-vote") {
        return /\/(final-vote|final-revote)$/.test(url);
      }
      return false;
    }),
    actionButton.click()
  ]);
}

async function submitVoteAndWaitForCompletion(page, action = "submit-vote", targetDisplayName = "") {
  await submitCurrentVote(page, action, targetDisplayName);
  await expect(page.getByRole("heading", { name: /投票完了|再投票完了|最終投票完了|最終再投票完了/ })).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".vote-complete-card")).toContainText("投票を受け付けました");
}

async function expectTurnState(host, guest, activeDisplayName) {
  const activePage = activeDisplayName === "HostFlowTest" ? host : guest;
  const waitingPage = activeDisplayName === "HostFlowTest" ? guest : host;

  await expect(activePage.locator('button[data-action="submit-word"]')).toBeVisible({ timeout: 10000 });
  await expect(activePage.locator('button[data-action="submit-word"]')).toBeEnabled({ timeout: 10000 });
  await expect(waitingPage.locator("body")).toContainText(`${activeDisplayName} の手番です。`, { timeout: 10000 });
}

async function completeRoundByHostDecision(host, guest, roundLabel, hostDecisionWinnerName, firstTurnDisplayName = "HostFlowTest") {
  const turnOrder =
    firstTurnDisplayName === "GuestFlowTest"
      ? [
          { page: guest, name: "GuestFlowTest" },
          { page: host, name: "HostFlowTest" }
        ]
      : [
          { page: host, name: "HostFlowTest" },
          { page: guest, name: "GuestFlowTest" }
        ];

  await expectTurnState(host, guest, firstTurnDisplayName);

  await submitCurrentDraft(turnOrder[0].page);
  await acknowledgeRevealForAll([host, guest]);

  await expectTurnState(host, guest, turnOrder[1].name);
  await submitCurrentDraft(turnOrder[1].page);
  await acknowledgeRevealForAll([host, guest]);

  await expect(host.getByRole("heading", { name: "投票" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "投票" })).toBeVisible({ timeout: 10000 });

  await submitCurrentVote(host, "submit-vote", "HostFlowTest");
  await submitCurrentVote(guest, "submit-vote", "GuestFlowTest");

  await reconnect(host);
  await reconnect(guest);
  await expect(host.getByRole("heading", { name: "再投票" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "再投票" })).toBeVisible({ timeout: 10000 });

  await host.locator("[data-revote-id]:not([disabled])", { hasText: "HostFlowTest" }).first().click();
  await guest.locator("[data-revote-id]:not([disabled])", { hasText: "GuestFlowTest" }).first().click();
  await host.locator('button[data-action="submit-revote"]').click();
  await guest.locator('button[data-action="submit-revote"]').click();

  await reconnect(host);
  await expect(host.getByRole("heading", { name: "ホスト裁定" })).toBeVisible({ timeout: 10000 });
  await host.locator("[data-host-pick-id]", { hasText: hostDecisionWinnerName }).click();
  await host.locator('button[data-action="submit-host-pick"]').click();
  await acknowledgeRevealForAll([host, guest]);

  await expect(host.getByRole("heading", { name: `${roundLabel}結果発表` })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: `${roundLabel}結果発表` })).toBeVisible({ timeout: 10000 });
  await expect(host.locator("body")).toContainText(roundLabel);
  await expect(guest.locator("body")).toContainText(roundLabel);
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

  await expect(page.getByRole("heading", { name: "投票" })).toBeVisible();
  const voteCandidate = page.locator("[data-vote-id]:not([disabled])").first();
  await voteCandidate.click();

  await expect(voteCandidate).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('button[data-action="submit-vote"]')).toBeEnabled();
});

test("app shows a vote complete screen and lets the player return to change the vote", async ({ page }) => {
  const session = await setupRoundVoteRoom();

  await page.goto(STATIC_URL);
  await page.evaluate(({ roomId, hostToken }) => {
    window.localStorage.setItem("omojan-app-room-id", roomId);
    window.localStorage.setItem("omojan-app-player-token", hostToken);
  }, session);
  await page.reload();

  await expect(page.getByRole("heading", { name: "投票" })).toBeVisible();
  await submitVoteAndWaitForCompletion(page, "submit-vote", "HostAppTest");
  await page.getByRole("button", { name: "投票画面に戻る" }).click();
  await expect(page.getByRole("heading", { name: "投票" })).toBeVisible();
  await expect(page.locator("[data-vote-id][aria-pressed='true']")).toHaveCount(0);
});

test("app can complete create, join, start, submit, vote, host decision, and show round result", async ({ browser }) => {
  const { hostContext, guestContext, host, guest } = await createTwoPlayerRoom(browser);

  await host.getByRole("button", { name: "この順で開始" }).click();

  await completeRoundByHostDecision(host, guest, "ラウンド1", "GuestFlowTest", "HostFlowTest");

  await hostContext.close();
  await guestContext.close();
});

test("app can complete a full game through final champion and restart", async ({ browser }) => {
  test.setTimeout(60000);

  const { hostContext, guestContext, host, guest } = await createTwoPlayerRoom(browser);

  await host.getByRole("button", { name: "この順で開始" }).click();

  await completeRoundByHostDecision(host, guest, "ラウンド1", "GuestFlowTest", "HostFlowTest");
  await host.getByRole("button", { name: "次のラウンドへ" }).click();
  await reconnect(guest);

  await completeRoundByHostDecision(host, guest, "ラウンド2", "HostFlowTest", "GuestFlowTest");
  await host.getByRole("button", { name: "最終投票へ進む" }).click();
  await reconnect(guest);

  await expect(host.getByRole("heading", { name: "最終投票" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "最終投票" })).toBeVisible({ timeout: 10000 });
  await expect(host.locator("body")).not.toContainText("2人戦なので自分のワードにも投票できます");
  await expect(host.locator("[data-final-vote-id]", { hasText: "HostFlowTest" }).first()).toBeEnabled();
  await expect(guest.locator("[data-final-vote-id]", { hasText: "GuestFlowTest" }).first()).toBeEnabled();
  await submitCurrentVote(host, "submit-final-vote", "HostFlowTest");
  await submitCurrentVote(guest, "submit-final-vote", "GuestFlowTest");

  await reconnect(host);
  await reconnect(guest);
  await expect(host.getByRole("heading", { name: "最終再投票" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "最終再投票" })).toBeVisible({ timeout: 10000 });
  await host.locator("[data-final-vote-id]:not([disabled])", { hasText: "HostFlowTest" }).first().click();
  await guest.locator("[data-final-vote-id]:not([disabled])", { hasText: "GuestFlowTest" }).first().click();
  await host.locator('button[data-action="submit-final-vote"]').click();
  await guest.locator('button[data-action="submit-final-vote"]').click();

  await reconnect(host);
  await expect(host.getByRole("heading", { name: "最終ホスト裁定" })).toBeVisible({ timeout: 10000 });
  const finalPick = host.locator("[data-final-pick-id]").first();
  const championPhrase = (await finalPick.locator(".word-line").allTextContents()).join("");
  await finalPick.click();
  await host.locator('button[data-action="submit-final-host-pick"]').click();

  await expect(host.locator("#revealOverlay")).toBeVisible({ timeout: 10000 });
  await expect(guest.locator("#revealOverlay")).toBeVisible({ timeout: 10000 });
  await host.getByRole("button", { name: "結果一覧を見る" }).click();
  await expect(host.getByRole("heading", { name: "結果一覧" })).toBeVisible({ timeout: 10000 });
  await expect(guest.locator("#revealOverlay")).toBeVisible({ timeout: 10000 });
  await acknowledgeRevealOn(guest);
  await reconnect(guest);
  await expect(guest.getByRole("heading", { name: "結果一覧" })).toBeVisible({ timeout: 10000 });
  await expect(host.locator(".champion-stage .stage-footnote")).not.toContainText("のワード");
  await expect(host.locator(".champion-stage .stage-footnote")).toContainText(/HostFlowTest|GuestFlowTest/);
  await expect(host.locator(".round-winner-card").first().locator("footer")).toContainText(/HostFlowTest|GuestFlowTest/);
  await expect(host.locator("body")).toContainText(championPhrase);
  await expect(guest.locator("body")).toContainText(championPhrase);

  await host.getByRole("button", { name: "もう一度最初から" }).click();
  await reconnect(guest);
  await expect(host.getByRole("heading", { name: "ルーム待機中" })).toBeVisible({ timeout: 10000 });
  await expect(guest.getByRole("heading", { name: "ルーム待機中" })).toBeVisible({ timeout: 10000 });

  await hostContext.close();
  await guestContext.close();
});

test("mobile submit view keeps a floating preview and uses unified reveal labels", async ({ browser }) => {
  test.setTimeout(60000);
  const hostContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto(STATIC_URL);
  await host.fill("#createDisplayName", "HostMobileTest");
  await host.getByRole("button", { name: "2人" }).click();
  await host.getByRole("button", { name: "ルームを作る" }).click();
  await expect(host.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();
  const inviteCode = ((await host.locator(".room-code").textContent()) || "").trim();

  await guest.goto(STATIC_URL);
  await guest.evaluate(() => {
    window.localStorage.setItem("omojan-app-last-display-name", "GuestMobileTest");
  });
  await guest.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await expect(guest.getByRole("heading", { name: "このルームに参加" })).toBeVisible();
  await expect(guest.locator("#joinDisplayNameInvite")).toHaveValue("GuestMobileTest");
  await guest.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(guest.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();

  await host.getByRole("button", { name: "この順で開始" }).click();
  await expect(host.locator(".page-header")).toHaveClass(/is-hidden/);
  await expect(host.locator("body")).toContainText("ワードの間");
  await expect(host.locator("body")).not.toContainText("句間");
  await expect(host.locator(".setting-group", { hasText: "ワードの間" }).locator(".setting-group-value")).toHaveText("なし");

  await host.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await host.waitForTimeout(900);
  const statusBottom = await host.locator(".status-row").evaluate((row) => row.getBoundingClientRect().bottom);
  const previewState = await host.locator(".preview-card").evaluate((card) => ({
    top: card.getBoundingClientRect().top,
    className: card.className
  }));
  expect(previewState.className).toContain("is-sticky");
  expect(previewState.top).toBeLessThanOrEqual(statusBottom + 12);
  const mediumFontSize = await host.locator("#previewWord .word-line").first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  await host.locator('[data-size-preset="large"]').click();
  await host.waitForTimeout(200);
  const largeFontSize = await host.locator("#previewWord .word-line").first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  await host.locator('[data-size-preset="tiny"]').click();
  await host.waitForTimeout(200);
  const smallFontSize = await host.locator("#previewWord .word-line").first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  expect(largeFontSize - mediumFontSize).toBeGreaterThanOrEqual(12);
  expect(mediumFontSize - smallFontSize).toBeGreaterThanOrEqual(12);
  const noOverflow = await host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(noOverflow).toBeTruthy();

  await submitCurrentDraft(host);
  await expect(host.locator("#revealBadge")).toHaveText("ラウンド1");
  await expect(host.locator("#revealMeta")).toHaveText("HostMobileTest");
  await expect(host.locator("#revealCard")).toHaveClass(/is-submission/);

  await hostContext.close();
  await guestContext.close();
});

test("desktop submit view applies a clear difference between large, medium, and small text sizes", async ({ browser }) => {
  const created = await api("/rooms", {
    method: "POST",
    body: JSON.stringify({ displayName: "SizeDesktopHost", playerCount: 2 })
  });
  await api("/rooms/join", {
    method: "POST",
    body: JSON.stringify({ inviteCode: created.room.inviteCode, displayName: "SizeDesktopGuest" })
  });
  await api(
    `/rooms/${encodeURIComponent(created.room.roomId)}/start-player`,
    {
      method: "POST",
      body: JSON.stringify({ startPlayerId: created.room.me.playerId })
    },
    created.playerToken
  );
  await api(
    `/rooms/${encodeURIComponent(created.room.roomId)}/start`,
    {
      method: "POST",
      body: JSON.stringify({ deckId: "default" })
    },
    created.playerToken
  );

  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  await page.goto(STATIC_URL);
  await page.evaluate(({ roomId, playerToken }) => {
    window.localStorage.setItem("omojan-app-room-id", roomId);
    window.localStorage.setItem("omojan-app-player-token", playerToken);
  }, { roomId: created.room.roomId, playerToken: created.playerToken });
  await page.reload();
  await expect(page.locator('button[data-action="submit-word"]')).toBeVisible({ timeout: 10000 });

  const getPreviewFontSize = async () =>
    page.locator("#previewWord .word-line").first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));

  await page.getByRole("button", { name: "大", exact: true }).click();
  await page.waitForTimeout(200);
  const largeSize = await getPreviewFontSize();

  await page.getByRole("button", { name: "中", exact: true }).click();
  await page.waitForTimeout(200);
  const mediumSize = await getPreviewFontSize();

  await page.getByRole("button", { name: "小", exact: true }).click();
  await page.waitForTimeout(200);
  const smallSize = await getPreviewFontSize();

  expect(largeSize - mediumSize).toBeGreaterThanOrEqual(20);
  expect(mediumSize - smallSize).toBeGreaterThanOrEqual(20);

  await page.getByRole("button", { name: "1行で固定" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "大", exact: true }).click();
  await page.waitForTimeout(200);
  const largeSingle = await getPreviewFontSize();
  await page.getByRole("button", { name: "中", exact: true }).click();
  await page.waitForTimeout(200);
  const mediumSingle = await getPreviewFontSize();
  await page.getByRole("button", { name: "小", exact: true }).click();
  await page.waitForTimeout(200);
  const smallSingle = await getPreviewFontSize();

  expect(largeSingle - mediumSingle).toBeGreaterThanOrEqual(20);
  expect(mediumSingle - smallSingle).toBeGreaterThanOrEqual(16);

  await context.close();
});

test("spectators do not receive turns and do not block reveal progression", async ({ browser }) => {
  test.setTimeout(60000);
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const spectatorContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const spectator = await spectatorContext.newPage();

  await host.goto(STATIC_URL);
  await host.fill("#createDisplayName", "SpectatorHost");
  await host.getByRole("button", { name: "2人" }).click();
  await host.getByRole("button", { name: "ルームを作る" }).click();
  await expect(host.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();
  const inviteCode = ((await host.locator(".room-code").textContent()) || "").trim();

  await guest.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await guest.fill("#joinDisplayNameInvite", "SpectatorGuest");
  await guest.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(guest.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();

  await spectator.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await spectator.fill("#joinDisplayNameInvite", "JustWatcher");
  await spectator.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(spectator.locator("#feedbackDock")).toContainText("観戦として参加しました。");
  await expect(spectator.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();
  await expect(spectator.locator("body")).toContainText("観戦");

  await host.reload();
  await host.getByRole("button", { name: "この順で開始" }).click();
  await expect(host.locator('button[data-action="submit-word"]')).toBeVisible({ timeout: 10000 });
  await expect(spectator.locator('button[data-action="submit-word"]')).toHaveCount(0);
  await expect(spectator.locator("body")).toContainText("観戦中");

  await submitCurrentDraft(host);
  await acknowledgeRevealOn(host);
  await acknowledgeRevealOn(guest);
  await reconnect(host);
  await reconnect(guest);
  await reconnect(spectator);

  await expect(host.locator('button[data-action="submit-word"]')).toHaveCount(0);
  await expect(guest.locator('button[data-action="submit-word"]')).toBeVisible({ timeout: 10000 });
  await expect(spectator.locator('button[data-action="submit-word"]')).toHaveCount(0);
  await expect(spectator.locator("#revealOverlay")).toBeHidden();
  await expect(spectator.locator("body")).toContainText("観戦中");

  await hostContext.close();
  await guestContext.close();
  await spectatorContext.close();
});

test("app restores session after reopening the browser context", async ({ browser }) => {
  test.setTimeout(60000);

  let { hostContext, guestContext, host, guest } = await createTwoPlayerRoom(browser);

  await host.getByRole("button", { name: "この順で開始" }).click();
  await expectTurnState(host, guest, "HostFlowTest");

  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext, { text: "HostFlowTest の手番です。" }));

  await submitCurrentDraft(host);
  await acknowledgeRevealForAll([host, guest]);

  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext, { selector: 'button[data-action="submit-word"]' }));
  await submitCurrentDraft(guest);
  await acknowledgeRevealForAll([host, guest]);

  ({ context: hostContext, page: host } = await reopenWithStoredSession(browser, hostContext, "投票"));
  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext, "投票"));

  await submitCurrentVote(host, "submit-vote", "HostFlowTest");
  await submitCurrentVote(guest, "submit-vote", "GuestFlowTest");

  ({ context: hostContext, page: host } = await reopenWithStoredSession(browser, hostContext, "再投票"));
  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext, "再投票"));

  await host.locator("[data-revote-id]:not([disabled])", { hasText: "HostFlowTest" }).first().click();
  await guest.locator("[data-revote-id]:not([disabled])", { hasText: "GuestFlowTest" }).first().click();
  await host.locator('button[data-action="submit-revote"]').click();
  await guest.locator('button[data-action="submit-revote"]').click();

  ({ context: hostContext, page: host } = await reopenWithStoredSession(browser, hostContext, "ホスト裁定"));
  await host.locator("[data-host-pick-id]", { hasText: "GuestFlowTest" }).click();
  await host.locator('button[data-action="submit-host-pick"]').click();
  await acknowledgeRevealForAll([host, guest]);

  ({ context: guestContext, page: guest } = await reopenWithStoredSession(browser, guestContext, "ラウンド1結果発表"));
  await expect(guest.locator("body")).toContainText("ラウンド1");
  await expect(guest.locator("body")).toContainText("票数内訳");

  await hostContext.close();
  await guestContext.close();
});

test("host can transfer host role in the lobby", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const thirdContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const third = await thirdContext.newPage();

  await host.goto(STATIC_URL);
  await host.fill("#createDisplayName", "HostShift");
  await host.getByRole("button", { name: "3人" }).click();
  await host.getByRole("button", { name: "ルームを作る" }).click();
  const inviteCode = ((await host.locator(".room-code").textContent()) || "").trim();

  await guest.goto(STATIC_URL);
  await guest.evaluate(() => {
    window.localStorage.setItem("omojan-app-last-display-name", "GuestShift");
  });
  await guest.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await expect(guest.getByRole("heading", { name: "このルームに参加" })).toBeVisible();
  await expect(guest.locator("#joinDisplayNameInvite")).toHaveValue("GuestShift");
  await guest.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(guest.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();
  await third.goto(STATIC_URL);
  await third.evaluate(() => {
    window.localStorage.setItem("omojan-app-last-display-name", "ThirdShift");
  });
  await third.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await expect(third.getByRole("heading", { name: "このルームに参加" })).toBeVisible();
  await expect(third.locator("#joinDisplayNameInvite")).toHaveValue("ThirdShift");
  await third.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(third.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();

  await expect(host.locator("body")).toContainText("ホスト HostShift");
  await host.locator(".player-card", { hasText: "GuestShift" }).getByRole("button", { name: "ホストにする" }).click();
  await expect(host.locator("body")).toContainText("ホスト GuestShift");
  await expect(host.locator(".player-card", { hasText: "GuestShift" })).toContainText("ホスト");
  await expect(guest.locator("body")).toContainText("ホスト GuestShift");

  await hostContext.close();
  await guestContext.close();
  await thirdContext.close();
});

test("host can reorder lobby player order directly inside the participant list", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const thirdContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const third = await thirdContext.newPage();

  await host.goto(STATIC_URL);
  await host.fill("#createDisplayName", "OrderHost");
  await host.getByRole("button", { name: "3人" }).click();
  await host.getByRole("button", { name: "ルームを作る" }).click();
  const inviteCode = ((await host.locator(".room-code").textContent()) || "").trim();

  await guest.goto(STATIC_URL);
  await guest.evaluate(() => {
    window.localStorage.setItem("omojan-app-last-display-name", "OrderGuest");
  });
  await guest.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await guest.getByRole("button", { name: "この表示名で参加" }).click();

  await third.goto(STATIC_URL);
  await third.evaluate(() => {
    window.localStorage.setItem("omojan-app-last-display-name", "OrderThird");
  });
  await third.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await third.getByRole("button", { name: "この表示名で参加" }).click();

  await host.reload();
  const guestHandle = host
    .locator(".player-card[data-order-player-id]", { hasText: "OrderGuest" })
    .locator("[data-order-grab-player-id]")
    .first();
  const hostCard = host.locator(".player-card[data-order-player-id]", { hasText: "OrderHost" }).first();
  const guestHandleBox = await guestHandle.boundingBox();
  const hostCardBox = await hostCard.boundingBox();
  if (!guestHandleBox || !hostCardBox) {
    throw new Error("Lobby reorder handles are not visible.");
  }
  await host.mouse.move(guestHandleBox.x + guestHandleBox.width / 2, guestHandleBox.y + guestHandleBox.height / 2);
  await host.mouse.down();
  await host.mouse.move(hostCardBox.x + hostCardBox.width / 2, hostCardBox.y + hostCardBox.height / 2, { steps: 12 });
  await host.mouse.up();
  await expect(host.locator(".player-card[data-order-player-id]").first()).toContainText("OrderGuest");
  await expect(host.locator("body")).toContainText("2番手 / OrderHost");

  await hostContext.close();
  await guestContext.close();
  await thirdContext.close();
});

test("host leaving the lobby removes the player and transfers host to the next participant", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto(STATIC_URL);
  await host.fill("#createDisplayName", "LeaveHost");
  await host.getByRole("button", { name: "2人" }).click();
  await host.getByRole("button", { name: "ルームを作る" }).click();
  const inviteCode = ((await host.locator(".room-code").textContent()) || "").trim();

  await guest.goto(`${STATIC_URL}&invite=${encodeURIComponent(inviteCode)}`);
  await guest.fill("#joinDisplayNameInvite", "LeaveGuest");
  await guest.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(guest.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();

  host.once("dialog", (dialog) => dialog.accept());
  await host.getByRole("button", { name: "退出する" }).click();
  await expect(host.getByRole("heading", { name: "ルームを作る" })).toBeVisible({ timeout: 10000 });

  await guest.reload();
  await expect(guest.locator("body")).toContainText("ホスト LeaveGuest", { timeout: 10000 });
  await expect(guest.locator(".player-card")).toHaveCount(1);
  await expect(guest.locator(".player-card").first()).toContainText("LeaveGuest");
  await expect(guest.locator("body")).not.toContainText("LeaveHost");

  await hostContext.close();
  await guestContext.close();
});

test("app shows a friendly message for an invalid invite code", async ({ page }) => {
  await page.goto(`${STATIC_URL}&invite=${encodeURIComponent("OMO-9999")}`);
  await page.fill("#joinDisplayNameInvite", "InvalidGuest");
  await page.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(page.locator("#feedbackDock")).toContainText("招待コードが見つかりません。招待URLかコードをもう一度確認してください。");
  await expect(page.getByRole("heading", { name: "このルームに参加" })).toBeVisible();
  await expect(page.locator("body")).toContainText("OMO-9999");
});

test("app shows a friendly message when the room is full", async ({ page }) => {
  const created = await api("/rooms", {
    method: "POST",
    body: JSON.stringify({ displayName: "HostFull", playerCount: 2 })
  });
  await api("/rooms/join", {
    method: "POST",
    body: JSON.stringify({ inviteCode: created.room.inviteCode, displayName: "GuestFull" })
  });

  await page.goto(STATIC_URL);
  await page.evaluate(() => {
    window.localStorage.setItem("omojan-app-last-display-name", "LateGuest");
  });
  await page.goto(`${STATIC_URL}&invite=${encodeURIComponent(created.room.inviteCode)}`);
  await page.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(page.locator("#feedbackDock")).toContainText("観戦として参加しました。");
  await expect(page.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();
  await expect(page.locator("body")).toContainText("観戦");
});

test("app opens invite join screen and joins after confirming the display name", async ({ page }) => {
  const created = await api("/rooms", {
    method: "POST",
    body: JSON.stringify({ displayName: "HostInvite", playerCount: 2 })
  });

  await page.goto(STATIC_URL);
  await page.evaluate(() => {
    window.localStorage.setItem("omojan-app-last-display-name", "InviteDirect");
  });
  await page.goto(`${STATIC_URL}&invite=${encodeURIComponent(created.room.inviteCode)}`);

  await expect(page.getByRole("heading", { name: "このルームに参加" })).toBeVisible();
  await expect(page.locator("#joinDisplayNameInvite")).toHaveValue("InviteDirect");
  await expect(page.locator("#inviteCode")).toHaveCount(0);
  await page.getByRole("button", { name: "この表示名で参加" }).click();
  await expect(page.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();
  await expect(page.locator("body")).toContainText("InviteDirect");
});

test("app can clear the local room session and return to the welcome screen", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(STATIC_URL);
  await page.fill("#createDisplayName", "LeaveHost");
  await page.getByRole("button", { name: "ルームを作る" }).click();
  await expect(page.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();

  const inviteCode = ((await page.locator(".room-code").textContent()) || "").trim();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "退出する" }).click();

  await expect(page.getByRole("heading", { name: "ルームを作る" })).toBeVisible();
  await expect(page.locator("#feedbackDock")).toContainText("退出しました。");
  await expect(page.locator("#inviteCode")).toHaveValue(inviteCode);

  await context.close();
});

test("app can open and close champion history from the landing screen", async ({ page }) => {
  await page.goto(STATIC_URL);

  await page.getByRole("button", { name: "一覧を見る" }).click();
  await expect(page.locator("#historyOverlay")).toBeVisible();
  await expect.poll(async () => page.locator("#historyDialogBody .history-ranking-card--history").count()).toBeGreaterThanOrEqual(5);
  await expect(page.locator("#historyDialogBody")).not.toContainText("すべての総合優勝ワード");

  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.locator("#historyOverlay")).toBeHidden();
});

test("app can like champion history items and show ranking", async ({ page }) => {
  await page.goto(STATIC_URL);

  await expect(page.getByRole("heading", { name: "いいね数ランキング" })).toBeVisible();
  await page.getByRole("button", { name: "一覧を見る" }).click();
  await expect(page.locator("#historyOverlay")).toBeVisible();

  const firstLikeButton = page.locator("#historyDialogBody [data-action='toggle-champion-like']").first();
  const initialLikeLabel = (await firstLikeButton.textContent()) || "";
  const initialLikeCount = Number((initialLikeLabel.match(/(\d+)/) || [0, "0"])[1]);
  await expect(firstLikeButton).toContainText("♡");
  await firstLikeButton.click({ force: true });
  await expect(firstLikeButton).toContainText(`♡ ${initialLikeCount + 1}`);
  await expect(page.getByRole("heading", { name: "いいね数ランキング" })).toBeVisible();

  const moreButton = page.getByRole("button", { name: "もっと見る" });
  if (await moreButton.count()) {
    await moreButton.click();
    await expect(page.locator("#historyDialogBody .history-ranking-card--history")).toHaveCount(20);
  }
});
