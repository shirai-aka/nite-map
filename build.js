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

fs.writeFileSync(OUT, JSON.stringify(records, null, 1), "utf8");
console.log(`${records.length} 冊 -> ${path.relative(__dirname, OUT)}`);
