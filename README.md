# omojan / おもじゃん Prototype

スマホ向け Web ボードゲーム「おもじゃん」の試作置き場です。

## 主なファイル

- `omojan_flow_prototype.html`
  - ロビーから提出、投票、再投票、ホスト裁定、総合優勝まで通して触れる簡易プロトタイプ
- `omojan_phase_prototype.html`
  - API を優先しつつ、使えないときは fixture にフォールバックして room 状態から画面を導出する phase 駆動の試作
- `omojan_submit_prototype.html`
  - ワード提出 UI の集中試作
- `omojan_wireframe.html`
  - 全体ワイヤーフレーム
- `omojan_wireframe_notes.md`
  - ルールや画面設計の補足メモ

## 開発ドキュメント

- `omojan_game_rules.md`
  - ゲーム企画・ルール定義書
- `omojan_requirements.md`
  - 要件定義書
- `omojan_screen_flow.md`
  - 画面要件・画面遷移書
- `omojan_basic_design.md`
  - 基本設計書
- `omojan_api_spec.md`
  - API 仕様書
- `omojan_dynamodb_design.md`
  - DynamoDB テーブル設計書
- `omojan_test_plan.md`
  - テスト計画書
- `mock_api/`
  - API 実装前に使うモックデータ
- `backend/lambda/api/`
  - Lambda 本実装の入口。現在は lobby 系 API を DynamoDB で扱う
- `infra/sam/`
  - Lambda + API Gateway + DynamoDB の AWS 雛形

## 開き方

静的確認だけならブラウザで各 HTML ファイルをそのまま開けば見られます。

phase 駆動プロトタイプを API 付きで確認したい場合は、別ターミナルで以下を起動します。

```bash
npm install
python3 -m http.server 8000
npm run start:mock-api
```

そのうえで以下を開くと、`http://127.0.0.1:8787/v1` の開発 API を優先して読み込みます。

```txt
http://127.0.0.1:8000/omojan_phase_prototype.html
```

ページ上部の `ライブデモを始める` から、ロビー -> 提出 -> 投票 -> ホスト裁定 までを API 経由で進められます。

Lambda 実装寄りのローカル API で確認したい場合は、代わりに以下を起動します。

```bash
npm install
python3 -m http.server 8000
npm run start:lambda-api
```

そのうえで以下を開くと、`http://127.0.0.1:8788/v1` の Lambda API に接続します。phase プロトタイプ側で開発用 bot を自動参加させるので、1ブラウザでもロビー -> 提出 -> 投票 -> 結果まで確認できます。

```txt
http://127.0.0.1:8000/omojan_phase_prototype.html?data=auto&apiBaseUrl=http://127.0.0.1:8788/v1
```

fixture 固定で見たい場合は、以下のように `?data=fixture` を付けます。

```txt
http://127.0.0.1:8000/omojan_phase_prototype.html?data=fixture
```

## テスト

```bash
npm run test:mock-api
npm run test:lambda-api
npm run test:e2e:phase
```

## 補足

スクリーンショット類や検証用の一時ファイルは Git 管理対象から外しています。
