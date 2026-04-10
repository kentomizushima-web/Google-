// background.js
// Service Worker として動作するバックグラウンドスクリプト
// Content Script を使わず、fetchでGoogle検索結果を取得してポップアップに返す

// ポップアップからのメッセージを受け取るリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // TODO: 次の指示でメッセージ処理と検索結果取得ロジックを実装する
  return true; // 非同期レスポンスのためにtrueを返す
});
