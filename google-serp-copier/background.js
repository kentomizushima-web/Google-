// background.js
// Service Worker として動作するバックグラウンドスクリプト
// Content Script を使わず、fetchでGoogle検索結果を取得してポップアップに返す
// ※ Service Worker 内では document が存在しないため、HTMLパースは正規表現で行う

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

/** 各ページ取得間のディレイ（ミリ秒）。CAPTCHA回避のため1.5秒 */
const FETCH_DELAY_MS = 1500;

/** 1ページあたりの検索結果数（Google標準） */
const RESULTS_PER_PAGE = 10;

/**
 * 除外するドメインのリスト（部分一致）
 * Google内部リンク・広告・Googleサービスページを弾く
 */
const EXCLUDED_DOMAINS = [
  'google.com',
  'google.co.jp',
  'google.com.br',
  'google.co.uk',
  'googleapis.com',
  'googleusercontent.com',
  'googlevideo.com',
  'gstatic.com',
  'goo.gl',
  'accounts.google',
  'support.google',
  'policies.google',
  'myaccount.google',
];

// -------------------------------------------------------
// メッセージリスナー
// -------------------------------------------------------

/**
 * popup.js からのメッセージを受信し、SERP取得処理を起動する
 * message.action === 'fetchSERP' の場合に処理する
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchSERP') {
    // async関数はリスナー内で直接 await できないため即時実行関数で対処
    (async () => {
      try {
        const result = await fetchAllPages(
          message.keyword,
          message.startRank,
          message.endRank
        );
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();

    // 非同期でsendResponseを呼ぶためにtrueを返す（チャネルを維持）
    return true;
  }
});

// -------------------------------------------------------
// メイン取得ロジック
// -------------------------------------------------------

/**
 * 指定された順位範囲のGoogle検索結果URLを全ページ分取得する
 *
 * @param {string} keyword   - 検索キーワード
 * @param {number} startRank - 取得開始順位（1始まり）
 * @param {number} endRank   - 取得終了順位（1始まり）
 * @returns {Promise<{urls: string[], debugInfo: string}>}
 */
async function fetchAllPages(keyword, startRank, endRank) {
  const startOffset = startRank - 1;
  const endOffset   = endRank - 1;

  // 取得するページのstartパラメータ一覧を生成
  const pageStarts = [];
  for (
    let offset = Math.floor(startOffset / RESULTS_PER_PAGE) * RESULTS_PER_PAGE;
    offset <= endOffset;
    offset += RESULTS_PER_PAGE
  ) {
    pageStarts.push(offset);
  }

  const totalPages = pageStarts.length;
  const allUrls    = [];
  const seenUrls   = new Set();
  const debugLines = []; // デバッグ情報（Service Workerコンソール + ポップアップに表示）

  for (let i = 0; i < pageStarts.length; i++) {
    const pageStart = pageStarts[i];

    notifyProgress(`ページ ${i + 1}/${totalPages} を取得中...`);

    const { html, finalUrl, status } = await fetchGooglePage(keyword, pageStart);

    // デバッグ用: HTMLの先頭2000字をService Workerコンソールに出力
    // chrome://extensions → Service Worker を検査 → Consoleタブで確認できる
    if (i === 0) {
      console.log(`[SERP Copier] HTML先頭2000字:\n${html.substring(0, 2000)}`);
    }

    // ボット・CAPTCHA検出
    if (isBotDetectionPage(html)) {
      throw new Error(
        'Googleがbotとして検出しました（CAPTCHA）。\n' +
        'しばらく待ってから再試行してください。'
      );
    }

    // 同意ページへのリダイレクト検出
    if (finalUrl.includes('consent.google') || finalUrl.includes('/sorry/')) {
      throw new Error(
        'Googleの同意/ブロックページにリダイレクトされました。\n' +
        'ブラウザでGoogle検索を一度開いてから再試行してください。'
      );
    }

    const urls = extractUrls(html);

    // デバッグ情報を記録（ページごと）
    const debugMsg = `p${i + 1}: HTML=${html.length}B, 抽出=${urls.length}件, status=${status}`;
    debugLines.push(debugMsg);
    console.log(`[SERP Copier] ${debugMsg}`);

    for (const url of urls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        allUrls.push(url);
      }
    }

    if (i < pageStarts.length - 1) {
      await delay(FETCH_DELAY_MS);
    }
  }

  // 指定順位範囲に対応する部分を切り出す
  const sliceStart = startOffset % RESULTS_PER_PAGE;
  const sliceEnd   = sliceStart + (endRank - startRank + 1);
  const urls       = allUrls.slice(sliceStart, sliceEnd);

  console.log(`[SERP Copier] 完了: allUrls=${allUrls.length}件 → slice(${sliceStart},${sliceEnd})=${urls.length}件`);

  return {
    urls,
    debugInfo: debugLines.join(' | '),
  };
}

// -------------------------------------------------------
// ページ取得
// -------------------------------------------------------

/**
 * Google検索結果ページをfetchして生HTML・最終URL・ステータスを返す
 *
 * @param {string} keyword - 検索キーワード
 * @param {number} start   - 検索結果の開始インデックス（0始まり）
 * @returns {Promise<{html: string, finalUrl: string, status: number}>}
 */
async function fetchGooglePage(keyword, start) {
  // pws=0: パーソナライズ無効  filter=0: 類似結果フィルタ無効
  const url = (
    `https://www.google.co.jp/search` +
    `?q=${encodeURIComponent(keyword)}` +
    `&start=${start}` +
    `&num=${RESULTS_PER_PAGE}` +
    `&hl=ja` +
    `&pws=0` +
    `&filter=0`
  );

  const response = await fetch(url, {
    // User-Agent はChromeが自動付与するため指定不要
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      // Referer を付与することでブラウザの通常ナビゲーションに見せる
      'Referer': 'https://www.google.co.jp/',
    },
    // 'include' にしてChromeのGoogleセッションCookieを送る
    // 'omit' だとCookieなしリクエストとなり、Google側が同意ページや
    // 通常と異なるHTML形式を返す場合があり、URL抽出が0件になる原因となる
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`HTTPエラー: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return { html, finalUrl: response.url, status: response.status };
}

// -------------------------------------------------------
// URLの抽出（正規表現ベース・複数パターン同時実行）
// -------------------------------------------------------

/**
 * Google検索結果HTMLからオーガニック検索結果のURLを抽出する
 *
 * 抽出パターン（全パターンを同時実行、Setで重複排除）:
 *   A: href="/url?q=https://..."  通常形式（ダブル・シングルクォート両対応）
 *   B: href="/url?q=https%3A%2F%2F..."  URLエンコード形式
 *   C: href="https://..."  直接リンク形式（ダブル・シングルクォート両対応）
 *   D: data-href="https://..."  data属性形式
 *   E: "url":"https://..."  JSON/JS埋め込みデータ形式（Google現行SERP対応）
 *   F: "https:\/\/..."  バックスラッシュエスケープされたURL（JSソース内）
 *
 * @param {string} html - Google検索結果ページのHTMLテキスト
 * @returns {string[]} - 外部URLの配列（重複・Google内部リンク除外済み）
 */
function extractUrls(html) {
  const seen    = new Set();
  const results = [];

  /**
   * URLを正規化・検証してリストに追加するヘルパー
   * @param {string} rawUrl - 未デコードのURL文字列
   */
  function tryAdd(rawUrl) {
    if (!rawUrl) return;
    try {
      // HTMLエンティティ(&amp;)を戻してからURLデコード
      const normalized = rawUrl.replace(/&amp;/g, '&').replace(/\\u002F/gi, '/');
      const decoded    = decodeURIComponent(normalized);
      // クリーンなURLを取得（余分なGoogleトラッキングパラメータ等は isValidExternalUrl で除外）
      if (isValidExternalUrl(decoded) && !seen.has(decoded)) {
        seen.add(decoded);
        results.push(decoded);
      }
    } catch {
      // デコード失敗はスキップ
    }
  }

  let m;

  // --- パターンA: href="/url?q=https://..." （通常形式、ダブル・シングルクォート両対応） ---
  // (?:[^"']*?&)? で "q=" より前のパラメータ（sa=U& 等）をオプションで読み飛ばす
  const patA = /href=["']\/url\?(?:[^"']*?&)?q=(https?:\/\/[^"'&\s]+)/gi;
  while ((m = patA.exec(html)) !== null) tryAdd(m[1]);

  // --- パターンB: href="/url?q=https%3A%2F%2F..." （URLエンコード形式） ---
  const patB = /href=["']\/url\?(?:[^"']*?&)?q=(https?%3A%2F%2F[^"'&\s]+)/gi;
  while ((m = patB.exec(html)) !== null) tryAdd(m[1]);

  // --- パターンC: href="https://..." または href='https://...' （直接リンク形式） ---
  // ダブルクォート版
  const patC1 = /href="(https?:\/\/[^"#\s]{10,})"/g;
  while ((m = patC1.exec(html)) !== null) tryAdd(m[1]);
  // シングルクォート版
  const patC2 = /href='(https?:\/\/[^'#\s]{10,})'/g;
  while ((m = patC2.exec(html)) !== null) tryAdd(m[1]);

  // --- パターンD: data-href="https://..." 属性 ---
  const patD = /data-href=["'](https?:\/\/[^"']+)["']/g;
  while ((m = patD.exec(html)) !== null) tryAdd(m[1]);

  // --- パターンE: JSON/JS内の "url":"https://..." 形式 ---
  // 現代のGoogle SERPはscriptタグ内のJSONにURLを埋め込む場合がある
  // 例: {"url":"https://example.com/","title":"..."}
  const patE = /"(?:url|href|link|canonicalUrl|originalUrl|targetUrl)"\s*:\s*"(https?:\/\/[^"\\]{10,})"/gi;
  while ((m = patE.exec(html)) !== null) tryAdd(m[1]);

  // --- パターンF: バックスラッシュエスケープURL "https:\/\/..." 形式 ---
  // JSソース内で \/ エスケープされたURLを拾う（バックスラッシュを除去して正規化）
  const patF = /"(https?:\\\/\\\/[^"\\]{10,})"/g;
  while ((m = patF.exec(html)) !== null) tryAdd(m[1].replace(/\\\//g, '/'));

  console.log(`[SERP Copier] extractUrls: ${results.length}件抽出`);

  return results;
}

/**
 * URLが有効な外部リンクかどうかを判定する
 * Google内部リンク・広告・無効な形式を除外する
 *
 * @param {string} url
 * @returns {boolean}
 */
function isValidExternalUrl(url) {
  // http/https スキームのみ許可
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return false;
  }

  // URLからドメイン部分を取り出す
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false; // 不正なURLは除外
  }

  // 除外ドメインリストに一致するものを弾く
  for (const excluded of EXCLUDED_DOMAINS) {
    if (hostname === excluded || hostname.endsWith('.' + excluded)) {
      return false;
    }
  }

  // Googleキャッシュリンクを除外
  if (url.includes('webcache.googleusercontent.com')) {
    return false;
  }

  // Googleリダイレクタ経由リンクを除外（/url?... 形式で残るもの）
  if (/google\.[a-z.]+\/url\?/.test(url)) {
    return false;
  }

  return true;
}

/**
 * ページがCAPTCHA/ボット検出ページかどうかを判定する
 * @param {string} html
 * @returns {boolean}
 */
function isBotDetectionPage(html) {
  const indicators = [
    'unusual traffic',
    '/sorry/index',
    'captcha',
    'recaptcha',
    'automated requests',
    'detected unusual',
    'www.google.com/sorry',
  ];
  const lower = html.toLowerCase();
  return indicators.some(indicator => lower.includes(indicator));
}

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

/**
 * 進捗メッセージをポップアップへ送信する
 * @param {string} text
 */
function notifyProgress(text) {
  chrome.runtime.sendMessage({ action: 'progress', text }).catch(() => {});
}

/**
 * 指定ミリ秒だけ待機するPromiseを返す
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
