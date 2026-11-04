#!/usr/bin/env node
// data/books/*.yaml を SCHEMA.md に照らして機械的に検証する。依存なし(Node のみ)。
//
//   node tools/validate.js            # data/books を検証。エラーがあれば exit 1
//   node tools/validate.js --strict   # 警告も exit 1 にする
//   node tools/validate.js --quiet    # 要確認(情報)を出さない
//   node tools/validate.js path/to/dir
//
// 重さは3段階:
//   ERROR 書式違反。サイトが壊れる・ビルドが通らない・SCHEMA に反する → CI を落とす
//   WARN  疑わしいが判断が要る(座標の桁、signer が引用に無い、など)
//   INFO  人が確認したほうがよい材料(notes の「要確認」、同じ座標で地名の表記が違う、楽天の別版一致)
//
// このスクリプトはデータを書き換えない。
"use strict";
const fs = require("fs");
const path = require("path");
const { parseYamlWithLines, YamlLiteError } = require("./yaml-lite");

const args = process.argv.slice(2);
const STRICT = args.includes("--strict");
const QUIET = args.includes("--quiet");
const dirArg = args.find(a => !a.startsWith("--"));
const ROOT = path.resolve(__dirname, "..");
const BOOKS_DIR = dirArg ? path.resolve(dirArg) : path.join(ROOT, "data", "books");
const CACHE_FILE = path.join(ROOT, "data", "rakuten-cache.json");

// ---- SCHEMA.md の定義 -------------------------------------------------------

const SCHEMA = {
  title: null, author: null, translator: null,
  atogaki: ["type", "nite", "signer", "quote", "page", "date"],
  place: ["name", "lat", "lng", "precision", "kind"],
  book: ["published", "publisher", "isbn", "format"],
  links: ["amazon"],
  meta: ["added", "contributor", "notes"]
};
const ENUM = {
  "atogaki.type": ["author", "translator", "commentary", "title"],
  "place.precision": ["exact", "neighborhood", "city", "region", "country", "unmappable"],
  "book.format": ["print", "ebook", "audiobook"]
};
const THIS_YEAR = new Date().getFullYear();
const TODAY = new Date().toISOString().slice(0, 10);

// ---- 小道具 ---------------------------------------------------------------

const isStr = v => typeof v === "string";
const nonEmpty = v => isStr(v) && v.trim() !== "";
const isInt = v => Number.isInteger(v);

function isbn13Check(isbn) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(isbn[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

// "1998" / "1998-04" / "1998-04-12" を受け付け、実在する日付かも見る
function checkDateString(s) {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
  if (!m) return "書式が YYYY / YYYY-MM / YYYY-MM-DD でない";
  const y = Number(m[1]), mo = m[2] ? Number(m[2]) : null, d = m[3] ? Number(m[3]) : null;
  if (mo !== null && (mo < 1 || mo > 12)) return `月が範囲外(${m[2]})`;
  if (d !== null) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return `存在しない日付(${s})`;
  }
  return null;
}

function decimals(n) {
  const s = String(n);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

// 引用から署名を外す index.html の displayQuote と同じ手順(表示結果を点検するため)
function effectiveSigner(rec) {
  return (rec.atogaki && rec.atogaki.signer) || rec.translator || rec.author;
}

// ---- 1ファイルの検証 ---------------------------------------------------------

function checkRecord(rec, lines, file, report) {
  const E = (k, msg) => report.push({ level: "ERROR", file, line: lines[k], msg });
  const W = (k, msg) => report.push({ level: "WARN", file, line: lines[k], msg });
  const I = (k, msg) => report.push({ level: "INFO", file, line: lines[k], msg });

  // 未知のキー(打ち間違い)
  for (const k of Object.keys(rec)) {
    if (!(k in SCHEMA)) { W(k, `SCHEMA.md にないキー: ${k}`); continue; }
    const sub = SCHEMA[k];
    if (sub) {
      if (rec[k] !== null && (typeof rec[k] !== "object")) { E(k, `${k} はセクション(字下げした項目)にする`); continue; }
      for (const kk of Object.keys(rec[k] || {})) {
        if (!sub.includes(kk)) W(`${k}.${kk}`, `SCHEMA.md にないキー: ${k}.${kk}`);
      }
    }
  }
  for (const k of ["atogaki", "place", "book", "meta"]) {
    if (!rec[k] || typeof rec[k] !== "object") E(k, `${k} セクションがない`);
  }
  const a = rec.atogaki || {}, p = rec.place || {}, b = rec.book || {}, l = rec.links || {}, m = rec.meta || {};

  // 書誌
  if (!nonEmpty(rec.title)) E("title", "title がない(必須)");
  if (!nonEmpty(rec.author)) E("author", "author がない(必須)");
  if (rec.translator !== null && rec.translator !== undefined && !nonEmpty(rec.translator)) {
    E("translator", "translator は null か氏名(空文字は不可)");
  }

  // atogaki
  if (!ENUM["atogaki.type"].includes(a.type)) E("atogaki.type", `atogaki.type が不正: ${JSON.stringify(a.type)}(${ENUM["atogaki.type"].join(" | ")})`);
  if (a.type === "translator" && !nonEmpty(rec.translator)) E("translator", "atogaki.type が translator なのに translator がない");
  if (a.type === "commentary" && !nonEmpty(a.signer)) W("atogaki.signer", "解説(commentary)なのに signer(解説者名)がない。表示時に著者名を除去しようとする");
  if (!("nite" in a)) W("atogaki", "atogaki.nite がない");
  else if (typeof a.nite !== "boolean") E("atogaki.nite", `atogaki.nite は true/false: ${JSON.stringify(a.nite)}`);
  if (!nonEmpty(a.quote)) E("atogaki.quote", "atogaki.quote がない(必須。これが本体)");
  else {
    if (a.quote.length > 80) W("atogaki.quote", `quote が長い(${a.quote.length}文字)。「一行だけ」の原則を確認`);
    if (a.nite === true && !a.quote.includes("にて") && a.type !== "title") W("atogaki.nite", "nite: true だが quote に「にて」がない");
    if (a.nite === false && a.quote.includes("にて")) W("atogaki.nite", "nite: false だが quote に「にて」がある");
    if (nonEmpty(a.signer) && !a.quote.includes(a.signer)) {
      W("atogaki.signer", `signer「${a.signer}」が quote に含まれていない(表示時の除去対象がない。署名者の記録として置くなら問題なし)`);
    }
    // 表示側は signer → translator → author の順で1つだけ除去する。別の名前が残る場合を拾う
    const eff = effectiveSigner(rec);
    for (const [who, name] of [["author", rec.author], ["translator", rec.translator]]) {
      if (nonEmpty(name) && name !== eff && a.quote.includes(name) && !(isStr(eff) && a.quote.includes(eff))) {
        W("atogaki.signer", `quote に ${who}「${name}」が含まれるが、除去されるのは「${eff}」。signer に「${name}」を指定するか確認`);
      }
    }
  }
  if (a.signer !== null && a.signer !== undefined && !nonEmpty(a.signer)) E("atogaki.signer", "signer は null か氏名(空文字は不可)");
  if (a.page !== null && a.page !== undefined && !(isInt(a.page) && a.page > 0)) E("atogaki.page", `page は正の整数か null: ${JSON.stringify(a.page)}`);
  if (a.date !== null && a.date !== undefined) {
    if (typeof a.date === "number") E("atogaki.date", `date は文字列にする(引用符で囲む): ${a.date} → "${a.date}"`);
    else if (!isStr(a.date)) E("atogaki.date", `date が文字列でない: ${JSON.stringify(a.date)}`);
    else {
      const err = checkDateString(a.date);
      if (err) E("atogaki.date", `date: ${err}`);
      else {
        const y = Number(a.date.slice(0, 4));
        if (y < 1800 || y > THIS_YEAR) W("atogaki.date", `date の年が怪しい: ${y}`);
        if (isInt(b.published) && y > b.published) W("atogaki.date", `あとがきの日付(${a.date})が刊行年(${b.published})より後`);
      }
    }
  }

  // place
  if (!nonEmpty(p.name)) E("place.name", "place.name がない(必須)");
  if (!ENUM["place.precision"].includes(p.precision)) E("place.precision", `place.precision が不正: ${JSON.stringify(p.precision)}(${ENUM["place.precision"].join(" | ")})`);
  if (p.precision === "unmappable") {
    if (p.lat !== null && p.lat !== undefined) E("place.lat", "unmappable なのに lat がある(null にする)");
    if (p.lng !== null && p.lng !== undefined) E("place.lng", "unmappable なのに lng がある(null にする)");
    if (!nonEmpty(p.kind)) E("place.kind", "unmappable には kind(「地図の外」の見出し文)が必要");
  } else {
    for (const [k, lo, hi] of [["lat", -90, 90], ["lng", -180, 180]]) {
      const v = p[k];
      if (v === null || v === undefined) { E(`place.${k}`, `${k} がない(unmappable 以外は必須)`); continue; }
      if (typeof v !== "number" || !Number.isFinite(v)) { E(`place.${k}`, `${k} が数値でない: ${JSON.stringify(v)}`); continue; }
      if (v < lo || v > hi) E(`place.${k}`, `${k} が範囲外(${lo}〜${hi}): ${v}`);
      const d = decimals(v);
      if (d < 2) W(`place.${k}`, `${k} の小数が ${d} 桁。粗すぎないか確認(${v})`);
      if (d > 6) W(`place.${k}`, `${k} の小数が ${d} 桁。6桁(約10cm)で十分(${v})`);
    }
    if (p.lat === 0 && p.lng === 0) E("place.lat", "座標が (0, 0)(未記入の疑い)");
    if (p.kind !== null && p.kind !== undefined) W("place.kind", "kind は unmappable のときだけ使う(それ以外は null)");
    if (p.precision === "exact" && typeof p.lat === "number" && (decimals(p.lat) < 4 || decimals(p.lng) < 4)) {
      W("place.precision", "precision: exact なのに座標が4桁未満(約10m の精度に届かない)");
    }
  }

  // book
  if (!isInt(b.published)) E("book.published", `book.published は西暦の整数: ${JSON.stringify(b.published)}`);
  else if (b.published < 1800 || b.published > THIS_YEAR + 1) W("book.published", `刊行年が怪しい: ${b.published}`);
  if (!nonEmpty(b.publisher)) E("book.publisher", "book.publisher がない");
  if (b.isbn === null || b.isbn === undefined || b.isbn === "") {
    W("book.isbn", "isbn が空(書影・購入リンクが付かない)");
  } else if (typeof b.isbn === "number") {
    E("book.isbn", `isbn は文字列にする(引用符で囲む): ${b.isbn} → "${b.isbn}"`);
  } else if (!isStr(b.isbn) || !/^\d{13}$/.test(b.isbn)) {
    E("book.isbn", `isbn はハイフンなし13桁: ${JSON.stringify(b.isbn)}`);
  } else {
    if (!/^97[89]/.test(b.isbn)) E("book.isbn", `isbn の接頭辞が 978/979 でない: ${b.isbn}`);
    const ck = isbn13Check(b.isbn);
    if (ck !== Number(b.isbn[12])) E("book.isbn", `isbn のチェックディジットが合わない: ${b.isbn}(末尾は ${ck} のはず)`);
    if (b.isbn.startsWith("979")) I("book.isbn", "979 始まりの ISBN は ISBN-10 が無いため Amazon リンクが自動生成されない(links.amazon に手動で入れる)");
  }
  if (!("format" in b)) W("book", "book.format がない(print | ebook | audiobook)");
  else if (!ENUM["book.format"].includes(b.format)) E("book.format", `book.format が不正: ${JSON.stringify(b.format)}(${ENUM["book.format"].join(" | ")})`);
  if (b.format === "print" && a.page == null && a.type !== "title") W("atogaki.page", "紙の本(print)なのに page が null");

  // links
  if (l.amazon !== undefined && l.amazon !== null && l.amazon !== "") {
    if (!isStr(l.amazon) || !/^https:\/\/(www\.)?amazon\.(co\.jp|com)\//.test(l.amazon)) E("links.amazon", `links.amazon は空か Amazon の https URL: ${JSON.stringify(l.amazon)}`);
  }

  // meta
  if (m.added === null || m.added === undefined || m.added === "") E("meta.added", "meta.added(採取日)がない");
  else if (!isStr(m.added) || !/^\d{4}-\d{2}-\d{2}$/.test(m.added)) E("meta.added", `meta.added は YYYY-MM-DD: ${JSON.stringify(m.added)}`);
  else {
    const err = checkDateString(m.added);
    if (err) E("meta.added", `meta.added: ${err}`);
    else if (m.added > TODAY) W("meta.added", `meta.added が未来の日付: ${m.added}`);
  }
  if (m.contributor !== null && m.contributor !== undefined && !nonEmpty(m.contributor)) E("meta.contributor", "contributor は null か名前(空文字は不可)");
  if (m.notes !== null && m.notes !== undefined && !isStr(m.notes)) E("meta.notes", "notes は文字列");
  if (isStr(m.notes)) {
    const flag = m.notes.match(/要確認|要精査|要判断|要検討|要調査/);
    if (flag) I("meta.notes", `notes に「${flag[0]}」: ${m.notes}`);
  }
}

// ---- ファイルをまたぐ検証 ----------------------------------------------------

function checkCross(records, report) {
  const I = (file, msg) => report.push({ level: "INFO", file, msg });
  const E = (file, msg) => report.push({ level: "ERROR", file, msg });

  // 同一内容の重複
  const seen = new Map();
  for (const { file, rec } of records) {
    const key = JSON.stringify([rec.title, rec.atogaki && rec.atogaki.quote, rec.atogaki && rec.atogaki.date, rec.book && rec.book.isbn]);
    if (seen.has(key)) E(file, `${seen.get(key)} と同じ採録(書名・引用・日付・ISBN が一致)`);
    else seen.set(key, file);
  }

  // 同じ ISBN が複数ファイル(上下巻・複数の署名行は SCHEMA 上は正当なので情報のみ)
  const byIsbn = new Map();
  for (const { file, rec } of records) {
    const isbn = rec.book && rec.book.isbn;
    if (!isbn) continue;
    (byIsbn.get(isbn) || byIsbn.set(isbn, []).get(isbn)).push(file);
  }
  for (const [isbn, files] of byIsbn) {
    if (files.length > 1) I(files[0], `ISBN ${isbn} が ${files.length} ファイルにある(${files.join(", ")})。引用ごとの分割なら正当`);
  }

  // 同じ座標なのに地名の表記が違う → 地図では1つの栞にまとまり、先頭の名前だけが見出しになる
  const byCoord = new Map();
  const byName = new Map();
  for (const { file, rec } of records) {
    const p = rec.place || {};
    if (typeof p.lat !== "number" || typeof p.lng !== "number") continue;
    const ck = `${p.lat},${p.lng}`;
    (byCoord.get(ck) || byCoord.set(ck, []).get(ck)).push({ file, name: p.name, precision: p.precision });
    if (nonEmpty(p.name)) (byName.get(p.name) || byName.set(p.name, []).get(p.name)).push({ file, ck });
  }
  for (const [ck, list] of byCoord) {
    const names = [...new Set(list.map(x => x.name))];
    if (names.length > 1) I(list[0].file, `座標 ${ck} に地名の表記が ${names.length} 通り(${names.map(n => `「${n}」`).join(" / ")})。地図の見出しは先頭ファイルの「${list[0].name}」になる`);
    const precs = [...new Set(list.map(x => x.precision))];
    if (precs.length > 1) I(list[0].file, `座標 ${ck} で precision が揃っていない(${precs.join(" / ")})。寄る深さは先頭ファイルのものになる`);
  }
  for (const [name, list] of byName) {
    const cks = [...new Set(list.map(x => x.ck))];
    if (cks.length > 1) I(list[0].file, `地名「${name}」に座標が ${cks.length} 通り(${cks.join(" / ")})。別の栞に分かれる`);
  }
}

// 楽天キャッシュとの突き合わせ(書名検索で別の版が当たっていないか)
function checkCache(records, report) {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (e) { return; }
  const I = (file, msg) => report.push({ level: "INFO", file, msg });
  for (const { file, rec } of records) {
    const isbn = rec.book && rec.book.isbn;
    if (!isbn || !(isbn in cache)) continue;
    const hit = cache[isbn];
    if (hit === null) { I(file, `楽天: ISBN ${isbn} はキャッシュ上「見つからず」(書影・楽天リンクなし)`); continue; }
    const urlIsbn = (String(hit.cover || "").match(/\/(97[89]\d{10})[_.]/) || [])[1];
    if (hit.matched_by === "title") {
      I(file, `楽天: ISBN ではなく書名で一致(${hit.matched_title || "?"})。${urlIsbn && urlIsbn !== isbn ? `書影は別の版(${urlIsbn})のもの。` : ""}別の版・別の本でないか確認`);
    } else if (urlIsbn && urlIsbn !== isbn) {
      I(file, `楽天: 書影URLの ISBN(${urlIsbn})がデータの ISBN(${isbn})と違う`);
    }
  }
}

// ---- 実行 ----------------------------------------------------------------------

function main() {
  if (!fs.existsSync(BOOKS_DIR)) { console.error(`ディレクトリがない: ${BOOKS_DIR}`); process.exit(2); }
  const report = [];
  const records = [];
  const names = fs.readdirSync(BOOKS_DIR).sort();
  for (const name of names) {
    const file = name;
    const full = path.join(BOOKS_DIR, name);
    if (fs.statSync(full).isDirectory()) continue;
    if (!name.endsWith(".yaml")) {
      if (name.endsWith(".yml")) report.push({ level: "ERROR", file, msg: "拡張子は .yaml(.yml は build.js に読まれない)" });
      else if (name !== ".DS_Store") report.push({ level: "WARN", file, msg: "YAML 以外のファイル(build.js は無視する)" });
      continue;
    }
    const text = fs.readFileSync(full, "utf8");
    let parsed;
    try {
      parsed = parseYamlWithLines(text, file);
    } catch (e) {
      if (e instanceof YamlLiteError) report.push({ level: "ERROR", file, line: e.line, msg: e.detail });
      else throw e;
      continue;
    }
    if (name.startsWith("_")) continue; // 雛形・サンプルは構文だけ見る(build.js も無視する)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*\.yaml$/.test(name)) {
      report.push({ level: "WARN", file, msg: "ファイル名は 著者ローマ字-書名スラッグ.yaml(小文字英数とハイフン)" });
    }
    checkRecord(parsed.data, parsed.lines, file, report);
    records.push({ file, rec: parsed.data });
  }
  checkCross(records, report);
  checkCache(records, report);

  // 出力(ファイルごと、ERROR → WARN → INFO の順)
  const order = { ERROR: 0, WARN: 1, INFO: 2 };
  const shown = report.filter(r => !(QUIET && r.level === "INFO"));
  shown.sort((x, y) => x.file.localeCompare(y.file) || order[x.level] - order[y.level] || (x.line || 0) - (y.line || 0));
  let cur = null;
  for (const r of shown) {
    if (r.file !== cur) { cur = r.file; console.log(`\n${r.file}`); }
    console.log(`  ${r.level.padEnd(5)} ${r.line ? `L${r.line}: ` : ""}${r.msg}`);
  }
  const count = lv => report.filter(r => r.level === lv).length;
  console.log(`\n${records.length} 冊を検証: ERROR ${count("ERROR")} / WARN ${count("WARN")} / INFO ${count("INFO")}`);
  if (count("ERROR") > 0 || (STRICT && count("WARN") > 0)) process.exit(1);
}

main();
