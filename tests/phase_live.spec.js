const { test, expect } = require("@playwright/test");

async function startLiveGame(page) {
  await page.goto("http://127.0.0.1:8000/omojan_phase_prototype.html?data=api");
  await page.getByRole("button", { name: "ライブデモを始める" }).click();
  await expect(page.getByRole("heading", { name: "ルーム待機中" })).toBeVisible();
  await page.getByRole("button", { name: "この順で開始" }).click();
  await expect(page.getByRole("heading", { name: "東一局" })).toBeVisible();
}

async function submitCurrentRoundVoteHost(page) {
  await page.getByRole("button", { name: "この見た目で提出" }).click();
  await expect(page.getByRole("heading", { name: "このラウンドで一番おもしろいワードに投票" })).toBeVisible();
  await page.locator('[data-vote-id="player_host"]').click();
  await page.getByRole("button", { name: "このワードに投票" }).click();
}

test("live demo can start and reach round result", async ({ page }) => {
  await startLiveGame(page);
  await submitCurrentRoundVoteHost(page);

  await expect(page.getByRole("heading", { name: "ラウンド1" })).toBeVisible();
  await expect(page.getByText("3票 / あなた")).toBeVisible();
  await expect(page.locator("strong").filter({ hasText: "現場猫謝罪会見" }).first()).toBeVisible();
});

test("live demo can reach round 2 host decision", async ({ page }) => {
  await startLiveGame(page);
  await submitCurrentRoundVoteHost(page);
  await page.getByRole("button", { name: "次のラウンドへ" }).click();

  await expect(page.getByRole("heading", { name: "東二局" })).toBeVisible();
  await submitCurrentRoundVoteHost(page);

  await expect(page.getByRole("heading", { name: "再投票" })).toBeVisible();
  await page.locator('[data-revote-id="player_host"]').click();
  await page.getByRole("button", { name: "このワードに再投票" }).click();

  await expect(page.getByRole("heading", { name: "ホスト裁定" })).toBeVisible();
  await page.locator('[data-host-pick-id="player_tanaka"]').click();
  await page.getByRole("button", { name: "このワードで確定" }).click();

  await expect(page.getByRole("heading", { name: "ラウンド2" })).toBeVisible();
  await expect(page.locator("strong").filter({ hasText: "薄ラーメン" }).first()).toBeVisible();
});

test("live demo can reach final host decision", async ({ page }) => {
  await startLiveGame(page);
  await submitCurrentRoundVoteHost(page);
  await page.getByRole("button", { name: "次のラウンドへ" }).click();

  await submitCurrentRoundVoteHost(page);
  await page.locator('[data-revote-id="player_host"]').click();
  await page.getByRole("button", { name: "このワードに再投票" }).click();
  await page.locator('[data-host-pick-id="player_tanaka"]').click();
  await page.getByRole("button", { name: "このワードで確定" }).click();
  await page.getByRole("button", { name: "次のラウンドへ" }).click();

  await expect(page.getByRole("heading", { name: "東三局" })).toBeVisible();
  await submitCurrentRoundVoteHost(page);
  await expect(page.getByRole("heading", { name: "ラウンド3" })).toBeVisible();
  await page.getByRole("button", { name: "最終投票へ進む" }).click();

  await expect(page.getByRole("heading", { name: "最終投票" })).toBeVisible();
  await page.locator('[data-final-vote-id="final_round2"]').click();
  await page.getByRole("button", { name: "このワードに投票" }).click();

  await expect(page.getByRole("heading", { name: "最終再投票" })).toBeVisible();
  await page.locator('[data-final-vote-id="final_round2"]').click();
  await page.getByRole("button", { name: "このワードに再投票" }).click();

  await expect(page.getByRole("heading", { name: "最終ホスト裁定" })).toBeVisible();
  await page.locator('[data-final-pick-id="final_round3"]').click();
  await page.getByRole("button", { name: "このワードで確定" }).click();

  await expect(page.getByRole("heading", { name: "総合優勝" })).toBeVisible();
  await expect(page.locator(".champion-stage").getByText("現場大洪水")).toBeVisible();
});
