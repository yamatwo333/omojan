# おもじゃん API モックデータ

このフォルダは、`おもじゃん` の API 実装前にフロントと設計を揃えるためのモックデータ置き場です。

## 使い方

- `room_scenarios.json`
  - 画面ごとの代表的な room 状態
- `champions_recent.json`
  - 最近の優勝ワード API のモック
- `deck_default.json`
  - 初版 default デッキ API のモック

## 想定用途

- フロントの fetch モック
- 画面確認用の fixture
- Lambda 実装前の契約確認

## シナリオ一覧

- `lobby`
- `round_submit_you`
- `round_submit_wait`
- `round_vote`
- `round_revote`
- `round_host_decide`
- `round_result`
- `final_vote`
- `final_result`
