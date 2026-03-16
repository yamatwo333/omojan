# omojan / おもじゃん Prototype

スマホ向け Web ボードゲーム「おもじゃん」の試作置き場です。

## 主なファイル

- `omojan_app.html`
  - 実 API に直接つなぐ本番用の最小フロント。ルーム作成、招待参加、提出、投票、総合優勝までを 1 本で扱う
- `omojan_admin.html`
  - 共通パスコードで `default` デッキを編集する簡易管理画面。追加、更新、削除、有効切替を 1 画面で扱う
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
  - `build_bundle.sh` で deploy 用の最小 bundle を生成
- `infra/sam/`
  - Lambda + API Gateway + DynamoDB の AWS 雛形
  - `deploy_dev.sh` で dev 環境をそのままデプロイ可能

## 開き方

静的確認だけならブラウザで各 HTML ファイルをそのまま開けば見られます。

公開中の最小アプリは次です。

```txt
https://main.dr94wxwisw55z.amplifyapp.com/omojan_app.html
```

公開中のデッキ管理画面は次です。

```txt
https://main.dr94wxwisw55z.amplifyapp.com/omojan_admin.html
```

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

AWS 上の dev API は次です。

```txt
https://nglzfg3co5.execute-api.ap-northeast-1.amazonaws.com/dev/v1
```

公開中の Amplify 版から phase 駆動プロトタイプを開く場合は、次をそのまま開けば AWS dev API に自動接続します。

```txt
https://main.dr94wxwisw55z.amplifyapp.com/omojan_phase_prototype.html
```

Lambda 実装寄りのローカル API で確認したい場合は、代わりに以下を起動します。

```bash
npm install
python3 -m http.server 8000
ADMIN_SHARED_PASSCODE=your-passcode \
npm run start:lambda-api
```

そのうえで以下を開くと、`http://127.0.0.1:8788/v1` の Lambda API に接続します。phase プロトタイプ側で開発用 bot を自動参加させるので、1ブラウザでもロビー -> 提出 -> 投票 -> 結果まで確認できます。

```txt
http://127.0.0.1:8000/omojan_phase_prototype.html?data=auto&apiBaseUrl=http://127.0.0.1:8788/v1
```

同じローカル API を使うデッキ管理画面は次です。

```txt
http://127.0.0.1:8000/omojan_admin.html?apiBaseUrl=http://127.0.0.1:8788/v1
```

fixture 固定で見たい場合は、以下のように `?data=fixture` を付けます。

```txt
http://127.0.0.1:8000/omojan_phase_prototype.html?data=fixture
```

## テスト

```bash
npm run test:mock-api
npm run test:lambda-api
npm run build:lambda-bundle
npm run test:e2e:phase
npm run test:e2e:app
npm run test:e2e:admin
```

## 補足

スクリーンショット類や検証用の一時ファイルは Git 管理対象から外しています。
