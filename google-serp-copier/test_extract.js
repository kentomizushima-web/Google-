// test_extract.js
// background.js の URL抽出ロジックをNode.js環境で検証するテストスクリプト
// 実行: node test_extract.js

// -------------------------------------------------------
// background.js から純粋関数を移植（chrome API依存なし）
// -------------------------------------------------------

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

function isValidExternalUrl(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  for (const prefix of EXCLUDED_PREFIXES) {
    if (url.startsWith(prefix)) return false;
  }
  if (url.includes('webcache.googleusercontent.com')) return false;
  if (url.includes('google.com/url?') || url.includes('google.co.jp/url?')) return false;
  return true;
}

function extractUrls(html) {
  const urls = [];

  // パターン1: /url?q=... 形式
  const urlQPattern = /href="\/url\?q=(https?:\/\/[^"&]+)/g;
  let match;
  while ((match = urlQPattern.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (isValidExternalUrl(decoded)) {
        urls.push(decoded);
      }
    } catch {
      // スキップ
    }
  }

  // パターン2: 直接href形式（フォールバック）
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

// -------------------------------------------------------
// テストユーティリティ
// -------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function assertDeepEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    期待値: ${JSON.stringify(expected)}`);
    console.error(`    実際値: ${JSON.stringify(actual)}`);
    failed++;
  }
}

// -------------------------------------------------------
// テストケース
// -------------------------------------------------------

console.log('\n== isValidExternalUrl のテスト ==');

assert('外部URLを許可', isValidExternalUrl('https://www.example.com/page'));
assert('httpも許可', isValidExternalUrl('http://example.com/page'));
assert('Google.comを除外', !isValidExternalUrl('https://www.google.com/search'));
assert('Google.co.jpを除外', !isValidExternalUrl('https://www.google.co.jp/maps'));
assert('Google.co.jpトップも除外', !isValidExternalUrl('https://www.google.co.jp/'));
assert('accounts.googleを除外', !isValidExternalUrl('https://accounts.google.com/login'));
assert('support.googleを除外', !isValidExternalUrl('https://support.google.com/chrome'));
assert('webcacheを除外', !isValidExternalUrl('https://webcache.googleusercontent.com/search?q=cache:example.com'));
assert('google.com/url? を除外', !isValidExternalUrl('https://www.google.com/url?q=https://example.com'));
assert('google.co.jp/url? を除外', !isValidExternalUrl('https://www.google.co.jp/url?sa=t&url=https://example.com'));
assert('# を除外', !isValidExternalUrl('#section'));
assert('javascript: を除外', !isValidExternalUrl('javascript:void(0)'));
assert('httpスキームなしを除外', !isValidExternalUrl('/search?q=test'));

console.log('\n== extractUrls: パターン1（/url?q= 形式）のテスト ==');

const html1 = `
<div id="search">
  <div class="g">
    <a href="/url?q=https://www.example.com/article%3Fid%3D1&amp;sa=U&amp;ved=xxx">Example 1</a>
    <a href="/url?q=https://www.another-site.com/blog/post&amp;sa=U">Another Site</a>
    <a href="/url?q=https://www.third.co.jp/page&amp;sa=U">Third</a>
  </div>
  <!-- Googleサービスリンク（除外対象） -->
  <a href="/url?q=https://www.google.co.jp/maps&amp;sa=U">Maps</a>
  <a href="/search?q=related+query">Related</a>
  <a href="/url?q=https://support.google.com/chrome&amp;sa=U">Support</a>
  <!-- Googleトップ（除外対象） -->
  <a href="/url?q=https://www.google.com/&amp;sa=U">Google Top</a>
</div>
`;

{
  const urls = extractUrls(html1);
  assert('3件の外部URLを抽出', urls.length === 3);
  assert('1件目: example.com', urls[0] === 'https://www.example.com/article?id=1');
  assert('2件目: another-site.com', urls[1] === 'https://www.another-site.com/blog/post');
  assert('3件目: third.co.jp', urls[2] === 'https://www.third.co.jp/page');
  assert('google.co.jp/maps を除外', !urls.some(u => u.includes('google.co.jp/maps')));
  assert('support.google.com を除外', !urls.some(u => u.includes('support.google.com')));
}

console.log('\n== extractUrls: パターン2（直接href形式）のフォールバックテスト ==');

const html2 = `
<div id="search">
  <a href="https://www.example.com/page1">Example</a>
  <a href="https://blog.example.org/article/123">Blog Post</a>
  <a href="https://www.google.co.jp/search?q=test">Google検索（除外）</a>
  <a href="https://accounts.google.com/login">Googleアカウント（除外）</a>
  <a href="https://webcache.googleusercontent.com/search?q=cache:x">キャッシュ（除外）</a>
</div>
`;

{
  const urls = extractUrls(html2);
  assert('2件の外部URLを抽出（フォールバック）', urls.length === 2);
  assert('example.com が含まれる', urls.some(u => u.includes('www.example.com')));
  assert('blog.example.org が含まれる', urls.some(u => u.includes('blog.example.org')));
}

console.log('\n== extractUrls: エンコードされたURLのデコードテスト ==');

const html3 = `
<a href="/url?q=https://example.com/path%3Fparam%3Dvalue%26key%3D123&amp;sa=U">Link</a>
<a href="/url?q=https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC%E8%AA%9E&amp;sa=U">Wikipedia</a>
`;

{
  const urls = extractUrls(html3);
  assert('クエリパラメータ付きURLをデコード', urls[0] === 'https://example.com/path?param=value&key=123');
  assert('日本語パスをデコード', urls[1] === 'https://ja.wikipedia.org/wiki/日本語');
}

console.log('\n== extractUrls: 重複・空のケーステスト ==');

const html4 = `<div>テキストのみ（URLなし）</div>`;
{
  const urls = extractUrls(html4);
  assertDeepEqual('URLなしの場合は空配列', urls, []);
}

const html5 = `
<a href="/url?q=https://example.com/page&amp;sa=U">Link1</a>
<a href="/url?q=https://example.com/page&amp;sa=U">Link2（重複）</a>
<a href="/url?q=https://unique.com/&amp;sa=U">Unique</a>
`;
{
  // extractUrls 自体は重複を許す（dedup は fetchAllPages の Set で行う）
  const urls = extractUrls(html5);
  assert('extractUrls は3件返す（重複dedup は呼び出し側）', urls.length === 3);
}

console.log('\n== ページ計算ロジックのテスト ==');

function calcPageStarts(startRank, endRank) {
  const RESULTS_PER_PAGE = 10;
  const startOffset = startRank - 1;
  const endOffset = endRank - 1;
  const pageStarts = [];
  for (
    let offset = Math.floor(startOffset / RESULTS_PER_PAGE) * RESULTS_PER_PAGE;
    offset <= endOffset;
    offset += RESULTS_PER_PAGE
  ) {
    pageStarts.push(offset);
  }
  return pageStarts;
}

function calcSlice(startRank, endRank) {
  const RESULTS_PER_PAGE = 10;
  const startOffset = startRank - 1;
  const sliceStart = startOffset % RESULTS_PER_PAGE;
  const sliceEnd = sliceStart + (endRank - startRank + 1);
  return { sliceStart, sliceEnd };
}

{
  // 51〜100位（デフォルト）
  const ps = calcPageStarts(51, 100);
  assertDeepEqual('51-100位: ページstart=[50,60,70,80,90]', ps, [50, 60, 70, 80, 90]);
  const { sliceStart, sliceEnd } = calcSlice(51, 100);
  assert('51-100位: sliceStart=0', sliceStart === 0);
  assert('51-100位: sliceEnd=50', sliceEnd === 50);
}

{
  // 21〜50位
  const ps = calcPageStarts(21, 50);
  assertDeepEqual('21-50位: ページstart=[20,30,40]', ps, [20, 30, 40]);
  const { sliceStart, sliceEnd } = calcSlice(21, 50);
  assert('21-50位: sliceStart=0', sliceStart === 0);
  assert('21-50位: sliceEnd=30', sliceEnd === 30);
}

{
  // 5〜15位（ページ境界またぎ）
  const ps = calcPageStarts(5, 15);
  assertDeepEqual('5-15位: ページstart=[0,10]', ps, [0, 10]);
  const { sliceStart, sliceEnd } = calcSlice(5, 15);
  assert('5-15位: sliceStart=4', sliceStart === 4);
  assert('5-15位: sliceEnd=15', sliceEnd === 15);
  assert('5-15位: 切り出し件数=11', (sliceEnd - sliceStart) === 11);
}

{
  // 1〜10位（1ページのみ）
  const ps = calcPageStarts(1, 10);
  assertDeepEqual('1-10位: ページstart=[0]', ps, [0]);
  const { sliceStart, sliceEnd } = calcSlice(1, 10);
  assert('1-10位: sliceStart=0', sliceStart === 0);
  assert('1-10位: sliceEnd=10', sliceEnd === 10);
}

// -------------------------------------------------------
// 結果サマリー
// -------------------------------------------------------

console.log(`\n== テスト結果 ==`);
console.log(`  合格: ${passed} 件`);
console.log(`  失敗: ${failed} 件`);

if (failed > 0) {
  console.error('\n失敗したテストがあります。background.js を修正してください。');
  process.exit(1);
} else {
  console.log('\nすべてのテストが合格しました。');
  process.exit(0);
}
