// popup.js
// ポップアップのUIロジックを担当するスクリプト
// background.js（Service Worker）とメッセージを介して通信する

document.addEventListener('DOMContentLoaded', () => {
  // --- DOM要素の取得 ---
  const keywordInput  = document.getElementById('keyword');
  const startRankInput = document.getElementById('startRank');
  const endRankInput  = document.getElementById('endRank');
  const fetchBtn      = document.getElementById('fetchBtn');
  const copyBtn       = document.getElementById('copyBtn');
  const progress      = document.getElementById('progress');
  const progressText  = document.getElementById('progressText');
  const status        = document.getElementById('status');
  const resultArea    = document.getElementById('resultArea');
  const resultCount   = document.getElementById('resultCount');
  const urlList       = document.getElementById('urlList');

  // 取得済みURLを保持する配列
  let fetchedUrls = [];

  // -------------------------------------------------------
  // 「URLを取得」ボタンの処理
  // -------------------------------------------------------
  fetchBtn.addEventListener('click', async () => {
    const keyword  = keywordInput.value.trim();
    const startRank = parseInt(startRankInput.value, 10);
    const endRank   = parseInt(endRankInput.value, 10);

    // --- 入力バリデーション ---
    if (!keyword) {
      showStatus('error', '検索キーワードを入力してください。');
      return;
    }
    if (isNaN(startRank) || isNaN(endRank) || startRank < 1 || endRank < startRank) {
      showStatus('error', '順位の範囲が正しくありません。開始 ≤ 終了 で入力してください。');
      return;
    }

    // --- 取得開始前のUI初期化 ---
    setFetching(true);
    hideStatus();
    hideResults();
    fetchedUrls = [];

    // --- background.js へメッセージを送信 ---
    // 進捗テキストはbackground.jsからのメッセージで随時更新される
    try {
      const response = await sendMessageToBackground({
        action: 'fetchSERP',
        keyword,
        startRank,
        endRank,
      });

      if (response.error) {
        // エラーが返ってきた場合
        showStatus('error', `エラー: ${response.error}`);
      } else {
        // 成功: URL一覧を表示
        fetchedUrls = response.urls || [];
        renderResults(fetchedUrls);

        // デバッグ情報があれば件数の後ろに付記（0件の場合は特に詳細を表示）
        if (fetchedUrls.length === 0 && response.debugInfo) {
          showStatus('error',
            `0件でした。詳細: ${response.debugInfo}\n` +
            `※ Service Worker のコンソールも確認してください（chrome://extensions）`
          );
        } else {
          showStatus('success', `${fetchedUrls.length} 件のURLを取得しました。`);
        }
      }
    } catch (err) {
      showStatus('error', `通信エラー: ${err.message}`);
    } finally {
      setFetching(false);
    }
  });

  // -------------------------------------------------------
  // 「クリップボードにコピー」ボタンの処理
  // -------------------------------------------------------
  copyBtn.addEventListener('click', async () => {
    if (fetchedUrls.length === 0) return;

    // 改行区切りのプレーンテキストに変換（NotebookLM貼り付け用）
    const text = fetchedUrls.join('\n');

    try {
      await navigator.clipboard.writeText(text);
      showStatus('success', `✓ コピーしました（${fetchedUrls.length}件）`);
      // フラッシュアニメーションを起動（再トリガーのため一旦クラスを外す）
      status.classList.remove('flash');
      // reflow を強制してアニメーションをリセット
      void status.offsetWidth;
      status.classList.add('flash');
    } catch (err) {
      showStatus('error', `コピーに失敗しました: ${err.message}`);
    }
  });

  // -------------------------------------------------------
  // 進捗メッセージを background.js から受け取るリスナー
  // -------------------------------------------------------
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'progress') {
      progressText.textContent = message.text;
    }
  });

  // -------------------------------------------------------
  // ユーティリティ関数
  // -------------------------------------------------------

  /**
   * background.js へメッセージを送り、Promiseで応答を受け取る
   * @param {object} message
   * @returns {Promise<object>}
   */
  function sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * 取得中のUI状態を切り替える
   * @param {boolean} isFetching
   */
  function setFetching(isFetching) {
    fetchBtn.disabled = isFetching;
    copyBtn.disabled  = isFetching || fetchedUrls.length === 0;
    progress.classList.toggle('hidden', !isFetching);
    if (isFetching) {
      progressText.textContent = '取得中...';
    }
  }

  /**
   * 取得結果をリストとして描画する
   * @param {string[]} urls
   */
  function renderResults(urls) {
    urlList.innerHTML = '';
    urls.forEach((url, index) => {
      const li = document.createElement('li');
      li.textContent = `${index + 1}. ${url}`;
      li.title = url;
      urlList.appendChild(li);
    });
    resultCount.textContent = `取得件数: ${urls.length} 件`;
    resultArea.classList.remove('hidden');
    copyBtn.disabled = urls.length === 0;
  }

  /**
   * ステータスメッセージを表示する
   * @param {'success'|'error'} type
   * @param {string} message
   */
  function showStatus(type, message) {
    status.textContent = message;
    status.className = type; // 'hidden' を外し、type クラスを付与
  }

  /** ステータスメッセージを非表示にする */
  function hideStatus() {
    status.textContent = '';
    status.className = 'hidden';
  }

  /** 結果エリアを非表示にする */
  function hideResults() {
    urlList.innerHTML = '';
    resultArea.classList.add('hidden');
    copyBtn.disabled = true;
  }
});
