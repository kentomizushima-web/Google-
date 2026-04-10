// test_extract.js
// background.js の URL抽出ロジックをNode.js環境で検証するテストスクリプト
// 実行: node test_extract.js

// -------------------------------------------------------
// background.js から純粋関数を移植（chrome API依存なし）
// -------------------------------------------------------

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

function isValidExternalUrl(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  for (const excluded of EXCLUDED_DOMAINS) {
    if (hostname === excluded || hostname.endsWith('.' + excluded)) return false;
  }
  if (url.includes('webcache.googleusercontent.com')) return false;
  if (/google\.[a-z.]+\/url\?/.test(url)) return false;
  return true;
}

function extractUrls(html) {
  const seen    = new Set();
  const results = [];

  function tryAdd(rawUrl) {
    if (!rawUrl) return;
    try {
      const normalized = rawUrl.replace(/&amp;/g, '&').replace(/\\u002F/gi, '/');
      const decoded    = decodeURIComponent(normalized);
      if (isValidExternalUrl(decoded) && !seen.has(decoded)) {
        seen.add(decoded);
        results.push(decoded);
      }
    } catch {}
  }

  let m;

  // パターンA: /url?q=https://... 通常形式
  const patA = /href=["']\/url\?(?:[^"']*?&)?q=(https?:\/\/[^"'&\s]+)/gi;
  while ((m = patA.exec(html)) !== null) tryAdd(m[1]);

  // パターンB: /url?q=https%3A%2F%2F... URLエンコード形式
  const patB = /href=["']\/url\?(?:[^"']*?&)?q=(https?%3A%2F%2F[^"'&\s]+)/gi;
  while ((m = patB.exec(html)) !== null) tryAdd(m[1]);

  // パターンC: 直接 href="https://..." or href='https://...'
  const patC1 = /href="(https?:\/\/[^"#\s]{10,})"/g;
  while ((m = patC1.exec(html)) !== null) tryAdd(m[1]);
  const patC2 = /href='(https?:\/\/[^'#\s]{10,})'/g;
  while ((m = patC2.exec(html)) !== null) tryAdd(m[1]);

  // パターンD: data-href="https://..."
  const patD = /data-href=["'](https?:\/\/[^"']+)["']/g;
  while ((m = patD.exec(html)) !== null) tryAdd(m[1]);

  return results;
}

function isBotDetectionPage(html) {
  const indicators = ['unusual traffic','/sorry/index','captcha','recaptcha','automated requests'];
  const lower = html.toLowerCase();
  return indicators.some(ind => lower.includes(ind));
}

// -------------------------------------------------------
// テストユーティリティ
// -------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label, condition, extra = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
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

assert('外部URLを許可',                   isValidExternalUrl('https://www.example.com/page'));
assert('httpも許可',                       isValidExternalUrl('http://example.com/page'));
assert('google.com を除外',               !isValidExternalUrl('https://google.com/'));
assert('www.google.com を除外',           !isValidExternalUrl('https://www.google.com/search'));
assert('www.google.co.jp を除外',         !isValidExternalUrl('https://www.google.co.jp/'));
assert('maps.google.com を除外',          !isValidExternalUrl('https://maps.google.com/maps?q=tokyo'));
assert('accounts.google.com を除外',      !isValidExternalUrl('https://accounts.google.com/login'));
assert('support.google.com を除外',       !isValidExternalUrl('https://support.google.com/chrome'));
assert('gstatic.com を除外',              !isValidExternalUrl('https://www.gstatic.com/image.png'));
assert('googleapis.com を除外',           !isValidExternalUrl('https://www.googleapis.com/api'));
assert('webcache を除外',                 !isValidExternalUrl('https://webcache.googleusercontent.com/search?q=cache:x'));
assert('google.co.jp/url? を除外',        !isValidExternalUrl('https://www.google.co.jp/url?sa=t&url=https://example.com'));
assert('httpスキームなしを除外',          !isValidExternalUrl('/search?q=test'));
assert('ftp:// を除外',                   !isValidExternalUrl('ftp://example.com/file'));

console.log('\n== extractUrls: パターンA（/url?q= 通常形式）のテスト ==');

const htmlA = `
<div id="search">
  <a href="/url?q=https://www.example.com/article&amp;sa=U&amp;ved=xxx">Link1</a>
  <a href="/url?q=https://another.co.jp/blog/post&amp;sa=U">Link2</a>
  <a href="/url?q=https://www.google.co.jp/maps&amp;sa=U">Google Maps（除外）</a>
  <a href="/url?q=https://support.google.com/chrome&amp;sa=U">Support（除外）</a>
</div>
`;
{
  const urls = extractUrls(htmlA);
  assert('パターンA: 2件抽出', urls.length === 2, `実際: ${urls.length} — ${urls}`);
  assert('パターンA: example.com', urls[0] === 'https://www.example.com/article');
  assert('パターンA: another.co.jp', urls[1] === 'https://another.co.jp/blog/post');
}

console.log('\n== extractUrls: パターンB（/url?q= URLエンコード形式）のテスト ==');

const htmlB = `
<a href="/url?q=https%3A%2F%2Fwww.encoded-site.com%2Fpage&amp;sa=U">Encoded</a>
<a href="/url?q=https%3A%2F%2Fwww.google.co.jp%2F&amp;sa=U">Google（除外）</a>
`;
{
  const urls = extractUrls(htmlB);
  assert('パターンB: 1件抽出', urls.length === 1, `実際: ${urls}`);
  assert('パターンB: encoded-site.com', urls[0] === 'https://www.encoded-site.com/page');
}

console.log('\n== extractUrls: パターンC（直接href形式、ダブル・シングルクォート）のテスト ==');

const htmlC = `
<div id="search">
  <!-- 現代のGoogle形式: href に直接外部URL -->
  <a class="yuRUbf" href="https://www.direct-link.com/page" jsname="UWckNb" ping="/url?sa=t">Direct Link</a>
  <a href='https://single-quote.org/article/123' data-ved="xyz">Single Quote</a>
  <!-- Google内部リンク（除外） -->
  <a href="https://www.google.co.jp/search?q=related">Google Search（除外）</a>
  <a href="https://accounts.google.com/login">Google Account（除外）</a>
  <a href="https://www.gstatic.com/images/icons/icon.png">gstatic（除外）</a>
</div>
`;
{
  const urls = extractUrls(htmlC);
  assert('パターンC: 2件抽出', urls.length === 2, `実際: ${urls}`);
  assert('パターンC: direct-link.com', urls.some(u => u.includes('direct-link.com')));
  assert('パターンC: single-quote.org（シングルクォート）', urls.some(u => u.includes('single-quote.org')));
}

console.log('\n== extractUrls: パターンD（data-href形式）のテスト ==');

const htmlD = `
<div data-href="https://www.data-href-site.com/path/to/page">Some element</div>
<div data-href='https://another-data.net/article'>Another</div>
`;
{
  const urls = extractUrls(htmlD);
  assert('パターンD: 2件抽出', urls.length === 2, `実際: ${urls}`);
  assert('パターンD: data-href-site.com', urls.some(u => u.includes('data-href-site.com')));
  assert('パターンD: another-data.net', urls.some(u => u.includes('another-data.net')));
}

console.log('\n== extractUrls: 重複除外テスト ==');

const htmlDup = `
<a href="/url?q=https://example.com/page&amp;sa=U">Link</a>
<a href="https://example.com/page">Same URL again</a>
<a href="https://unique.com/article">Unique</a>
`;
{
  const urls = extractUrls(htmlDup);
  assert('重複除外: 2件（3件→重複1件除外）', urls.length === 2, `実際: ${urls}`);
  assert('重複除外: example.com が1件のみ', urls.filter(u => u.includes('example.com')).length === 1);
}

console.log('\n== extractUrls: HTMLエンティティ・特殊ケーステスト ==');

const htmlEnt = `
<a href="/url?q=https://example.com/path%3Fkey%3Dval%26x%3D1&amp;sa=U">Encoded Query</a>
<a href="/url?q=https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC%E8%AA%9E&amp;sa=U">Japanese Path</a>
`;
{
  const urls = extractUrls(htmlEnt);
  assert('クエリパラメータ付きURLのデコード', urls[0] === 'https://example.com/path?key=val&x=1');
  assert('日本語パスのデコード', urls[1] === 'https://ja.wikipedia.org/wiki/日本語');
}

console.log('\n== extractUrls: 空・URLなしのテスト ==');

{
  const urls = extractUrls('<div>テキストのみ（URLなし）</div>');
  assertDeepEqual('URLなしは空配列', urls, []);
}

console.log('\n== isBotDetectionPage のテスト ==');

assert('CAPTCHA HTMLを検出', isBotDetectionPage('<title>Before you continue</title><form>captcha</form>'));
assert('/sorry/index を検出', isBotDetectionPage('location = "/sorry/index"'));
assert('unusual traffic を検出', isBotDetectionPage('detected unusual traffic from your computer'));
assert('通常HTMLは検出しない', !isBotDetectionPage('<div id="search"><a href="https://example.com">Result</a></div>'));

console.log('\n== ページ計算ロジックのテスト ==');

function calcPageStarts(startRank, endRank) {
  const startOffset = startRank - 1;
  const endOffset   = endRank - 1;
  const pageStarts  = [];
  for (
    let offset = Math.floor(startOffset / 10) * 10;
    offset <= endOffset;
    offset += 10
  ) {
    pageStarts.push(offset);
  }
  return pageStarts;
}

function calcSlice(startRank, endRank) {
  const sliceStart = (startRank - 1) % 10;
  const sliceEnd   = sliceStart + (endRank - startRank + 1);
  return { sliceStart, sliceEnd };
}

{
  assertDeepEqual('51-100位: [50,60,70,80,90]', calcPageStarts(51, 100), [50,60,70,80,90]);
  const s = calcSlice(51, 100);
  assert('51-100位: sliceStart=0', s.sliceStart === 0);
  assert('51-100位: 50件', s.sliceEnd - s.sliceStart === 50);
}
{
  assertDeepEqual('21-50位: [20,30,40]', calcPageStarts(21, 50), [20,30,40]);
  const s = calcSlice(21, 50);
  assert('21-50位: sliceStart=0', s.sliceStart === 0);
  assert('21-50位: 30件', s.sliceEnd - s.sliceStart === 30);
}
{
  assertDeepEqual('5-15位: [0,10]', calcPageStarts(5, 15), [0,10]);
  const s = calcSlice(5, 15);
  assert('5-15位: sliceStart=4', s.sliceStart === 4);
  assert('5-15位: 11件', s.sliceEnd - s.sliceStart === 11);
}
{
  assertDeepEqual('1-10位: [0]', calcPageStarts(1, 10), [0]);
  const s = calcSlice(1, 10);
  assert('1-10位: sliceStart=0', s.sliceStart === 0);
  assert('1-10位: 10件', s.sliceEnd - s.sliceStart === 10);
}

// -------------------------------------------------------
// 結果サマリー
// -------------------------------------------------------

console.log(`\n== テスト結果 ==`);
console.log(`  合格: ${passed} 件`);
console.log(`  失敗: ${failed} 件`);

if (failed > 0) {
  console.error('\n失敗したテストがあります。');
  process.exit(1);
} else {
  console.log('\nすべてのテストが合格しました。');
  process.exit(0);
}
