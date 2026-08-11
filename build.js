#!/usr/bin/env node
// data/books/*.yaml を読んで prototype/books.json を生成する。
// 依存なし。SCHEMA.md の2階層・スカラー値のみという書式を前提にした限定パーサ。
// 「_」始まりのファイル(テンプレート・サンプル)は無視する。
const fs = require("fs");
const path = require("path");

const BOOKS_DIR = path.join(__dirname, "data", "books");
const OUT = path.join(__dirname, "prototype", "books.json");

function parseScalar(s) {
  s = s.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseYaml(text, file) {
  const obj = {};
  let section = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();
    const m = line.match(/^([^:]+):(.*)$/);
    if (!m) throw new Error(`${file}: パースできない行: ${line}`);
    const key = m[1].trim();
    const rest = m[2];
    if (indent === 0) {
      if (rest.trim() === "") {
        section = {};
        obj[key] = section;
      } else {
        obj[key] = parseScalar(rest);
        section = null;
      }
    } else {
      if (!section) throw new Error(`${file}: 予期しないインデント: ${line}`);
      section[key] = parseScalar(rest);
    }
  }
  return obj;
}

function validate(rec, file) {
  const errs = [];
  if (!rec.title) errs.push("title がない");
  if (!rec.author) errs.push("author がない");
  if (!rec.atogaki || !rec.atogaki.quote) errs.push("atogaki.quote がない");
  if (!rec.place || !rec.place.name) errs.push("place.name がない");
  const p = rec.place || {};
  if (p.precision !== "unmappable" && (p.lat == null || p.lng == null)) {
    errs.push("座標がない(unmappable でないのに lat/lng が null)");
  }
  if (errs.length) throw new Error(`${file}: ${errs.join(" / ")}`);
}

// Amazonリンクの自動生成。紙書籍のASINはISBN-10と同一なので dp/{ISBN-10} で商品ページに飛べる。
// アソシエイトタグは環境変数で渡す: AMAZON_TAG=xxxx-22 node build.js
const AMAZON_TAG = process.env.AMAZON_TAG || "";

function isbn13to10(isbn13) {
  if (!/^978\d{10}$/.test(isbn13)) return null; // 979始まりはISBN-10が存在しない
  const body = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(body[i]);
  const check = (11 - (sum % 11)) % 11;
  return body + (check === 10 ? "X" : String(check));
}

function amazonUrl(rec) {
  if (rec.links && rec.links.amazon) return rec.links.amazon; // 手動指定を優先
  const isbn10 = rec.book && rec.book.isbn ? isbn13to10(rec.book.isbn) : null;
  if (!isbn10) return null;
  return `https://www.amazon.co.jp/dp/${isbn10}` + (AMAZON_TAG ? `?tag=${AMAZON_TAG}` : "");
}

// 楽天ブックスAPI。表紙画像とアフィリエイトリンクをここ(ビルド時)で取りに行き、
// 結果を data/rakuten-cache.json に貯める。ブラウザから呼ばないのは、
// アプリIDが公開されてしまうのと、閲覧のたびに楽天へ問い合わせないため。
// 資格情報は環境変数で渡す(リポジトリには入れない):
//   RAKUTEN_APP_ID=... RAKUTEN_AFFILIATE_ID=... node build.js
const RAKUTEN_APP_ID = process.env.RAKUTEN_APP_ID || "";
const RAKUTEN_ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY || "";
const RAKUTEN_AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID || "";
// 楽天は Origin / Referer が「許可されたウェブサイト」と一致するか検査する。
// サーバー側(このスクリプト)からの呼び出しでは自動で付かないので明示する
const RAKUTEN_ORIGIN = process.env.RAKUTEN_ORIGIN || "https://shirai-aka.github.io";
const CACHE_FILE = path.join(__dirname, "data", "rakuten-cache.json");
const RAKUTEN_API = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function queryRakuten(params) {
  const url = new URL(RAKUTEN_API);
  url.searchParams.set("format", "json");
  url.searchParams.set("applicationId", RAKUTEN_APP_ID);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (RAKUTEN_AFFILIATE_ID) url.searchParams.set("affiliateId", RAKUTEN_AFFILIATE_ID);

  const headers = { Origin: RAKUTEN_ORIGIN, Referer: RAKUTEN_ORIGIN + "/" };
  if (RAKUTEN_ACCESS_KEY) headers.accessKey = RAKUTEN_ACCESS_KEY;

  const res = await fetch(url, { headers });
  if (res.status === 429) throw new Error("429 リクエスト過多");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()).Items || []).map(x => x.Item).filter(Boolean);
}

// 書名から副題を落とす。楽天側の表記と揺れやすいため
function shortTitle(title) {
  return title.split(/[―──\-—(（]/)[0].trim();
}

// 照合用に記号と空白を落とす。楽天は「ご冗談でしょう，…」のように
// 全角カンマを使うなど、同じ本でも表記が揺れる
function normTitle(s) {
  return s.replace(/[\s　]/g, "")
          .replace(/[，,、。．・：:；;！!？?（）()「」『』〈〉【】\-―──—〜~[\]]/g, "");
}

// 上下巻・巻数を取り違えないための目印
function volumeMark(title) {
  const m = title.match(/[（(]([上中下])[）)]/);
  return m ? m[1] : null;
}

function pickBest(items, rec) {
  const want = normTitle(shortTitle(rec.title));
  const vol = volumeMark(rec.title);
  return items.find(it => {
    if (!normTitle(it.title).includes(want)) return false;
    if (vol && volumeMark(it.title) !== vol) return false;
    return true;
  }) || null;
}

async function fetchRakuten(rec) {
  const isbn = rec.book && rec.book.isbn;
  let items = isbn ? await queryRakuten({ isbn }) : [];
  let it = items[0] || null;
  let matchedBy = "isbn";

  // 絶版・旧版はISBN検索に出てこないので書名で引き直す。
  // 別の版が当たることがあるため、どちらで一致したかを残す
  if (!it) {
    await sleep(1200);
    items = await queryRakuten({ title: shortTitle(rec.title) });
    it = pickBest(items, rec);
    matchedBy = "title";
  }
  if (!it) return null;

  return {
    // 200x200 が最大。書誌欄のサムネイルには十分
    cover: it.largeImageUrl || it.mediumImageUrl || it.smallImageUrl || "",
    url: it.affiliateUrl || it.itemUrl || "",
    matched_by: matchedBy,
    matched_title: it.title
  };
}

async function enrichWithRakuten(records) {
  const cache = loadCache();
  if (!RAKUTEN_APP_ID) {
    // キー未設定でもキャッシュ済みの分は使う(取得済みなら鍵なしでビルドできる)
    let used = 0;
    for (const rec of records) {
      const hit = cache[rec.book && rec.book.isbn];
      if (hit) { rec.links.rakuten_url = hit.url; rec.cover = hit.cover; used++; }
    }
    console.log(`楽天: RAKUTEN_APP_ID 未設定。キャッシュから ${used} 件`);
    return;
  }

  let fetched = 0, failed = 0;
  for (const rec of records) {
    const isbn = rec.book && rec.book.isbn;
    if (!isbn) continue;
    if (!cache[isbn]) {
      try {
        cache[isbn] = await fetchRakuten(rec);
        fetched++;
      } catch (e) {
        console.warn(`楽天: ${isbn} 取得失敗 (${e.message})`);
        failed++;
      }
      await sleep(1200); // 短時間の連続アクセスは制限されるため間隔を空ける
    }
    const hit = cache[isbn];
    if (hit) { rec.links.rakuten_url = hit.url; rec.cover = hit.cover; }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1), "utf8");
  console.log(`楽天: 新規取得 ${fetched} 件 / 失敗 ${failed} 件 (キャッシュ ${Object.keys(cache).length} 件)`);
}

async function main() {
  const records = [];
  for (const name of fs.readdirSync(BOOKS_DIR).sort()) {
    if (!name.endsWith(".yaml") || name.startsWith("_")) continue;
    const text = fs.readFileSync(path.join(BOOKS_DIR, name), "utf8");
    const rec = parseYaml(text, name);
    validate(rec, name);
    rec._file = name;
    rec.links = rec.links || {};
    rec.links.amazon_url = amazonUrl(rec);
    records.push(rec);
  }

  await enrichWithRakuten(records);

  fs.writeFileSync(OUT, JSON.stringify(records, null, 1), "utf8");
  console.log(`${records.length} 冊 -> ${path.relative(__dirname, OUT)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
