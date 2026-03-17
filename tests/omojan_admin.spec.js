const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ADMIN_PASSCODE = "test-admin-passcode";
const STATIC_PORT = 8001;
const API_PORT = 8789;
const STATIC_URL = `http://127.0.0.1:${STATIC_PORT}/omojan_admin.html?apiBaseUrl=${encodeURIComponent(`http://127.0.0.1:${API_PORT}/v1`)}`;
const API_BASE_URL = `http://127.0.0.1:${API_PORT}/v1`;

const BASE_DECK_PAYLOAD = {
  deckName: "test-default",
  tiles: [
    { tileId: "tile_a", text: "現場猫", enabled: true },
    { tileId: "tile_b", text: "謝罪会見", enabled: true },
    { tileId: "tile_c", text: "深夜テンション", enabled: false }
  ]
};

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
  staticServer = spawn("python3", ["-m", "http.server", String(STATIC_PORT)], {
    cwd: ROOT,
    stdio: "ignore"
  });
  apiServer = spawn("node", ["backend/lambda/api/local_server.js"], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(API_PORT),
      ADMIN_SHARED_PASSCODE: ADMIN_PASSCODE
    }
  });
  await Promise.all([waitForPort(STATIC_PORT), waitForPort(API_PORT)]);
}

async function stopServers() {
  for (const child of [staticServer, apiServer]) {
    if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

async function resetDeck() {
  const response = await fetch(`${API_BASE_URL}/admin/decks/default`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "X-Omojan-Admin-Passcode": ADMIN_PASSCODE
    },
    body: JSON.stringify(BASE_DECK_PAYLOAD)
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload?.error?.message || "Failed to reset deck");
  }
}

test.beforeAll(async () => {
  await startServers();
});

test.beforeEach(async () => {
  await resetDeck();
});

test.afterAll(async () => {
  await stopServers();
});

test("admin page can load and save default deck", async ({ page }) => {
  await page.goto(STATIC_URL);
  await page.fill("#adminPasscode", ADMIN_PASSCODE);
  await page.getByRole("button", { name: "デッキを読む" }).click();

  await expect(page.locator("#deckCard")).toBeVisible();
  await expect(page.locator('[data-tile-text-index="0"]')).toHaveValue("現場猫");

  await page.fill('[data-tile-text-index="0"]', "管理確認ワード");
  await page.getByRole("button", { name: "保存する" }).click();

  await expect(page.locator("#feedback")).toContainText("保存しました。");
  await page.reload();
  await expect(page.locator("#deckCard")).toBeVisible();
  await expect(page.locator('[data-tile-text-index="0"]')).toHaveValue("管理確認ワード");
});

test("admin page supports search, filter, and csv bulk import", async ({ page }) => {
  await page.goto(STATIC_URL);
  await page.fill("#adminPasscode", ADMIN_PASSCODE);
  await page.getByRole("button", { name: "デッキを読む" }).click();

  await expect(page.locator('[data-tile-text-index]')).toHaveCount(3);

  await page.fill("#searchInput", "謝罪");
  await expect(page.locator('[data-tile-text-index]')).toHaveCount(1);
  await expect(page.locator('[data-tile-text-index]')).toHaveValue("謝罪会見");

  await page.fill("#searchInput", "");
  await page.getByRole("button", { name: "無効" }).click();
  await expect(page.locator('[data-tile-text-index]')).toHaveCount(1);
  await expect(page.locator('[data-tile-text-index]')).toHaveValue("深夜テンション");

  await page.getByRole("button", { name: "すべて" }).click();
  await page.getByRole("button", { name: "CSVから追加" }).click();
  await page.locator("#csvFileInput").setInputFiles({
    name: "append.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("text,enabled\n爆笑ラーメン,true\n無言会議,false\n謝罪会見,true\n", "utf8")
  });

  await expect(page.locator("#feedback")).toContainText("3件を追加しました。");
  await expect(page.locator("#feedback")).toContainText("重複ワードを1件自動削除しました。");
  await expect(page.locator('[data-tile-text-index]')).toHaveCount(5);
  await expect(page.locator('[data-tile-text-index="0"]')).toHaveValue("爆笑ラーメン");
  await expect(page.locator('[data-tile-text-index="1"]')).toHaveValue("無言会議");
  await expect(page.locator('[data-tile-text-index="2"]')).toHaveValue("謝罪会見");

  await page.fill("#searchInput", "爆笑");
  await expect(page.locator('[data-tile-text-index]')).toHaveCount(1);
  await expect(page.locator('[data-tile-text-index]')).toHaveValue("爆笑ラーメン");

  await page.fill("#searchInput", "");
  await page.getByRole("button", { name: "CSVで置換" }).click();
  await page.locator("#csvFileInput").setInputFiles({
    name: "replace.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("tileId,text,enabled\nalpha,ラーメン侍,true\nbeta,拍手喝采,false\n", "utf8")
  });

  await expect(page.locator("#feedback")).toContainText("2件で置き換えました。");
  await expect(page.locator('[data-tile-text-index]')).toHaveCount(2);
  await expect(page.locator('[data-tile-text-index="0"]')).toHaveValue("ラーメン侍");
  await expect(page.locator('[data-tile-text-index="1"]')).toHaveValue("拍手喝采");

  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.locator("#feedback")).toContainText("保存しました。");
  await page.reload();

  await expect(page.locator("#deckCard")).toBeVisible();
  await expect(page.locator('[data-tile-text-index]')).toHaveCount(2);
  await expect(page.locator('[data-tile-text-index="0"]')).toHaveValue("ラーメン侍");
  await expect(page.locator('[data-tile-text-index="1"]')).toHaveValue("拍手喝采");

  await page.getByRole("button", { name: "無効" }).click();
  await expect(page.locator('[data-tile-text-index]')).toHaveCount(1);
  await expect(page.locator('[data-tile-text-index]')).toHaveValue("拍手喝采");
});

test("admin page adds a new word at the top", async ({ page }) => {
  await page.goto(STATIC_URL);
  await page.fill("#adminPasscode", ADMIN_PASSCODE);
  await page.getByRole("button", { name: "デッキを読む" }).click();

  await page.getByRole("button", { name: "新しいワードを追加" }).click();
  await expect(page.locator('[data-tile-text-index]')).toHaveCount(4);
  await expect(page.locator('[data-tile-text-index="0"]')).toHaveValue("");

  await page.fill('[data-tile-text-index="0"]', "先頭追加ワード");
  await page.fill('[data-tile-text-index="2"]', "先頭追加ワード");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.locator("#feedback")).toContainText("重複ワードを1件自動削除");
  await page.reload();

  await expect(page.locator('[data-tile-text-index]')).toHaveCount(3);
  await expect(page.locator('[data-tile-text-index="0"]')).toHaveValue("先頭追加ワード");
  await expect(page.locator('[data-tile-text-index="1"]')).toHaveValue("現場猫");
});

test("admin page can review and delete champion history", async ({ page }) => {
  await page.goto(STATIC_URL);
  await page.fill("#adminPasscode", ADMIN_PASSCODE);
  await page.getByRole("button", { name: "デッキを読む" }).click();

  await expect(page.locator("#historyCard")).toBeVisible();
  await expect(page.locator("#historyList .history-row")).toHaveCount(5);
  await expect(page.locator("#historyList")).toContainText("現場大洪水");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-remove-champion-id]").first().click();

  await expect(page.locator("#feedback")).toContainText("総合優勝ワード履歴を削除しました。");
  await expect(page.locator("#historyList .history-row")).toHaveCount(4);
  await expect(page.locator("#historyList")).not.toContainText("現場大洪水");
});
