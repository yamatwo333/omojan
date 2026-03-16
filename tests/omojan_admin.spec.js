const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ADMIN_PASSCODE = "test-admin-passcode";
const STATIC_PORT = 8001;
const API_PORT = 8789;
const STATIC_URL = `http://127.0.0.1:${STATIC_PORT}/omojan_admin.html?apiBaseUrl=${encodeURIComponent(`http://127.0.0.1:${API_PORT}/v1`)}`;

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

test.beforeAll(async () => {
  await startServers();
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
