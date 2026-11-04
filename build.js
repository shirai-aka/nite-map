#!/usr/bin/env node
// data/books/*.yaml を読んで prototype/books.json を生成する。
// 依存なし。YAML は SCHEMA.md の2階層・スカラー値のみという書式を前提にした
// 限定パーサ(tools/yaml-lite.js。tools/validate.js と共用)で読む。
// 「_」始まりのファイル(テンプレート・サンプル)は無視する。
//
//   node build.js                     # 通常(キーは環境変数か --env-file=.env から)
//   node build.js --no-maps           # 地図キーなしの確認用。config.js に noMaps を書き、
//                                     # index.html は地図の代わりに引用の一覧を出す
//   node build.js --retry-misses      # 楽天で「見つからず」だった本をもう一度取りに行く
const fs = require("fs");
const path = require("path");
const { parseYaml } = require("./tools/yaml-lite");

const ARGS = new Set(process.argv.slice(2));
const NO_MAPS = ARGS.has("--no-maps");
const RETRY_MISSES = ARGS.has("--retry-misses");
for (const a of ARGS) {
  if (!a.startsWith("--") || !["--no-maps", "--retry-misses"].includes(a)) {
    console.error(`不明な引数: ${a}(使えるのは --no-maps / --retry-misses)`);
    process.exit(2);
  }
}

const BOOKS_DIR = path.join(__dirname, "data", "books");
const OUT = path.join(__dirname, "prototype", "books.json");

// サイトが壊れる最低限だけここで止める。細かい検証は tools/validate.js(CI でも走る)
function validate(rec, file) {
  const errs = [];
  const text = v => typeof v === "string" && v.trim() !== "";
  if (!text(rec.title)) errs.push("title がない");
  if (!text(rec.author)) errs.push("author がない");
  if (!rec.atogaki || !text(rec.atogaki.quote)) errs.push("atogaki.quote がない");
  if (!rec.place || !text(rec.place.name)) errs.push("place.name がない");
  const p = rec.place || {};
  if (p.precision === "unmappable") {
    if (p.lat != null || p.lng != null) errs.push("unmappable なのに lat/lng がある");
  } else {
    if (p.lat == null || p.lng == null) {
      errs.push("座標がない(unmappable でないのに lat/lng が null)");
    } else if (typeof p.lat !== "number" || typeof p.lng !== "number" ||
               Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
      errs.push(`座標が不正(lat=${JSON.stringify(p.lat)} lng=${JSON.stringify(p.lng)})`);
    }
  }
  const isbn = rec.book && rec.book.isbn;
  if (isbn != null && isbn !== "" && !(typeof isbn === "string" && /^\d{13}$/.test(isbn))) {
    errs.push(`isbn はハイフンなし13桁の文字列(引用符で囲む): ${JSON.stringify(isbn)}`);
  }
  if (rec.atogaki && typeof rec.atogaki.date === "number") {
    errs.push(`atogaki.date は文字列にする(引用符で囲む): "${rec.atogaki.date}"`);
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
  return `https://www.amazon.co.jp/dp/${isbn10}` + (AMAZON_TAG ? `?tag=${encodeURIComponent(AMAZON_TAG)}` : "");
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

  // キャッシュの値が null なのは「取りに行ったが見つからなかった」印。
  // 毎回取り直すと2往復+待ち時間を無駄にするので、--retry-misses のときだけ再挑戦する
  let fetched = 0, failed = 0, skippedMisses = 0;
  const done = new Set(); // 同じ ISBN が複数ファイルにあっても(上下巻など)1回だけ取りに行く
  for (const rec of records) {
    const isbn = rec.book && rec.book.isbn;
    if (!isbn) continue;
    const known = Object.prototype.hasOwnProperty.call(cache, isbn);
    if (!done.has(isbn) && (!known || (cache[isbn] === null && RETRY_MISSES))) {
      done.add(isbn);
      try {
        cache[isbn] = await fetchRakuten(rec);
        fetched++;
      } catch (e) {
        console.warn(`楽天: ${isbn} 取得失敗 (${e.message})`);
        failed++;
      }
      await sleep(1200); // 短時間の連続アクセスは制限されるため間隔を空ける
    } else if (known && cache[isbn] === null && !done.has(isbn)) {
      done.add(isbn);
      skippedMisses++;
    }
    const hit = cache[isbn];
    if (hit) { rec.links.rakuten_url = hit.url; rec.cover = hit.cover; }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1), "utf8");
  console.log(`楽天: 新規取得 ${fetched} 件 / 失敗 ${failed} 件 (キャッシュ ${Object.keys(cache).length} 件)` +
              (skippedMisses ? ` / 見つからず済み ${skippedMisses} 件は再取得せず(--retry-misses で再挑戦)` : ""));
}

// 地図のキーはブラウザに渡す必要があるが、リポジトリには置かない。
// .env から読んで config.js を書き出す(config.js は .gitignore 済み)
// --no-maps のときはキーを書かず noMaps: true だけを渡す。index.html はこれを見て
// 地図を読み込まずに引用の一覧を出すので、キーが無い環境でも中身を確かめられる
function writeConfig() {
  const cfg = NO_MAPS
    ? { googleMapsKey: "", googleMapsMapId: "", noMaps: true }
    : {
        googleMapsKey: process.env.GOOGLE_MAPS_KEY || "",
        googleMapsMapId: process.env.GOOGLE_MAPS_MAP_ID || ""
      };
  fs.writeFileSync(
    path.join(__dirname, "prototype", "config.js"),
    "window.NITE_CONFIG = " + JSON.stringify(cfg) + ";\n",
    "utf8"
  );
  if (NO_MAPS) console.log("地図: --no-maps(地図なしで一覧だけ出す設定を config.js に書いた)");
  else if (cfg.googleMapsKey) console.log("地図: キーを config.js に書き出した");
  else console.log("地図: キー未設定(config.js は空。確認用なら --no-maps)");
}

async function main() {
  writeConfig();
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
