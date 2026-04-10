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
 * 除外するURLのプレフィックスリスト
 * Google内部リンクや広告・サービスページを弾く
 */
const EXCLUDED_PREFIXES = [
  'https://www.google.',
  'http://www.google.',
  'https://google.',
  'http://google.',
  'https://accounts.google.',
  'https://support.google.',
  'https://maps.google.',
  'https://play.google.',
  '/search',
  '/maps',
  '/images',
  '/shopping',
  '/news',
  '/finance',
  '/travel',
  '#',
  'javascript:',
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
        const urls = await fetchAllPages(
          message.keyword,
          message.startRank,
          message.endRank
        );
        sendResponse({ urls });
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
 * @returns {Promise<string[]>} - 重複なし外部URLの配列
 */
async function fetchAllPages(keyword, startRank, endRank) {
  // startRankとendRankから必要なページのstart値（0始まり）を算出
  // 例: startRank=51 → startOffset=50, endRank=100 → endOffset=99
  const startOffset = startRank - 1;
  const endOffset   = endRank - 1;

  // ページのstart値リストを生成（10件ずつ）
  // 例: startOffset=50, endOffset=99 → [50, 60, 70, 80, 90]
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
  const seenUrls   = new Set(); // 重複除外用

  for (let i = 0; i < pageStarts.length; i++) {
    const pageStart = pageStarts[i];

    // 進捗をポップアップへ通知
    notifyProgress(`ページ ${i + 1}/${totalPages} を取得中...`);

    const html = await fetchGooglePage(keyword, pageStart);
    const urls = extractUrls(html);

    for (const url of urls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        allUrls.push(url);
      }
    }

    // 最終ページ以外はディレイを挟む
    if (i < pageStarts.length - 1) {
      await delay(FETCH_DELAY_MS);
    }
  }

  // startRank〜endRankの範囲内にあるURLのみを切り出す
  // （ページ境界をまたぐ場合、前後に余分な結果が含まれることがある）
  const sliceStart = startOffset % RESULTS_PER_PAGE;
  const sliceEnd   = sliceStart + (endRank - startRank + 1);
  return allUrls.slice(sliceStart, sliceEnd);
}

// -------------------------------------------------------
// ページ取得
// -------------------------------------------------------

/**
 * Google検索結果ページをfetchして生HTMLを返す
 *
 * @param {string} keyword - 検索キーワード
 * @param {number} start   - 検索結果の開始インデックス（0始まり）
 * @returns {Promise<string>} - レスポンスHTMLテキスト
 */
async function fetchGooglePage(keyword, start) {
  const url = `https://www.google.co.jp/search?q=${encodeURIComponent(keyword)}&start=${start}&num=${RESULTS_PER_PAGE}&hl=ja`;

  const response = await fetch(url, {
    // User-Agent はChromeが自動付与するため指定不要
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
    },
    credentials: 'omit', // クッキーを送らない（セッション汚染防止）
  });

  if (!response.ok) {
    throw new Error(`HTTPエラー: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

// -------------------------------------------------------
// URLの抽出（正規表現ベース）
// -------------------------------------------------------

/**
 * Google検索結果HTMLからオーガニック検索結果のURLを抽出する
 * Service WorkerではDOMParserが使えないため正規表現を使用
 *
 * @param {string} html - Google検索結果ページのHTMLテキスト
 * @returns {string[]} - 外部URLの配列（広告・重複・内部リンクを除外済み）
 */
function extractUrls(html) {
  const urls = [];

  // Googleはオーガニック結果のリンクを
  // <a href="/url?q=実際のURL&..." または <a href="https://..."> の形で出力する
  // パターン1: /url?q=... 形式（多くのオーガニック結果）
  const urlQPattern = /href="\/url\?q=(https?:\/\/[^"&]+)/g;
  let match;
  while ((match = urlQPattern.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (isValidExternalUrl(decoded)) {
        urls.push(decoded);
      }
    } catch {
      // デコードに失敗したURLはスキップ
    }
  }

  // パターン2: data-href や jsname 属性に含まれる直接URLも補完で拾う
  // （パターン1で拾えなかった場合のフォールバック）
  if (urls.length === 0) {
    const directPattern = /href="(https?:\/\/(?!www\.google\.|google\.)[^"]+)"/g;
    while ((match = directPattern.exec(html)) !== null) {
      try {
        const decoded = decodeURIComponent(match[1]);
        if (isValidExternalUrl(decoded)) {
          urls.push(decoded);
        }
      } catch {
        // スキップ
      }
    }
  }

  return urls;
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

  // 除外プレフィックスに一致するものを弾く
  for (const prefix of EXCLUDED_PREFIXES) {
    if (url.startsWith(prefix)) {
      return false;
    }
  }

  // Googleキャッシュリンクを除外
  if (url.includes('webcache.googleusercontent.com')) {
    return false;
  }

  // Googleトラッキングパラメータのみのリンクを除外
  if (url.includes('google.com/url?') || url.includes('google.co.jp/url?')) {
    return false;
  }

  return true;
}

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

/**
 * 進捗メッセージをポップアップへ送信する
 * @param {string} text
 */
function notifyProgress(text) {
  // popup が開いていない場合はエラーになるが無視してよい
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
