#!/usr/bin/env node
// prototype/index.html をヘッドレスブラウザで開いて壊れていないか確かめる(手元用。CI では走らせない)。
// Google Maps はスタブに差し替えるので、APIキーもネットワークも要らない。
//
//   node build.js && node tools/smoke-prototype.js
//
// Playwright が必要(npm i -D playwright && npx playwright install chromium)。無ければその旨を出して終わる。
// 見るもの: JS の例外が出ない / books.json が無い・空でも断り書きが出る /
//           375px で横スクロールが出ない / 栞・一覧・「この地図について」が動く
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

let chromium;
try { ({ chromium } = require("playwright")); }
catch (e) { console.log("playwright が無いので省略(npm i -D playwright && npx playwright install chromium)"); process.exit(0); }

const ROOT = path.join(__dirname, "..", "prototype");
const BOOKS = path.join(ROOT, "books.json");
if (!fs.existsSync(BOOKS)) { console.error("prototype/books.json が無い。先に node build.js を実行する"); process.exit(2); }

// index.html が使う範囲だけの Google Maps の代役。描画はしない
const MAPS_STUB = `
window.google = { maps: {} };
google.maps.ControlPosition = { RIGHT_BOTTOM: 1 };
google.maps.event = { addListenerOnce(m, ev, fn) { setTimeout(fn, 0); } };
google.maps.Map = class {
  constructor(el, opts) { this.opts = opts; this.zoom = opts.zoom; this.controls = { 1: [] }; this.l = {}; }
  setZoom(z) { this.zoom = z; (this.l.zoom_changed || []).forEach(f => f()); }
  getZoom() { return this.zoom; } panTo() {} setCenter() {} setOptions(o) { Object.assign(this.opts, o); }
  addListener(ev, fn) { (this.l[ev] ||= []).push(fn); }
};
google.maps.AdvancedMarkerElement = class {
  constructor(o) { Object.assign(this, o); this.l = {}; (window.__markers ||= []).push(this); }
  addListener(ev, fn) { (this.l[ev] ||= []).push(fn); }
  fire(ev) { (this.l[ev] || []).forEach(f => f()); }
};
google.maps.importLibrary = async () => ({ AdvancedMarkerElement: google.maps.AdvancedMarkerElement });
setTimeout(() => window.initMap && window.initMap(), 0);
`;

const MODES = {
  normal:     { config: { googleMapsKey: "STUB", googleMapsMapId: "STUB" } },
  nokey:      { config: { googleMapsKey: "", googleMapsMapId: "" } },
  nomaps:     { config: { googleMapsKey: "", googleMapsMapId: "", noMaps: true } },
  nobooks:    { config: { googleMapsKey: "STUB", googleMapsMapId: "STUB" }, books: null },
  emptybooks: { config: { googleMapsKey: "STUB", googleMapsMapId: "STUB" }, books: "[]" }
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" };

function serve(mode) {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    if (p === "/config.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("window.NITE_CONFIG = " + JSON.stringify(mode.config) + ";"); }
    if (p === "/books.json" && "books" in mode) {
      if (mode.books === null) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<h1>404</h1>"); }
      res.writeHead(200, { "content-type": "application/json" }); return res.end(mode.books);
    }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
    res.end(fs.readFileSync(f));
  });
}

(async () => {
  const browser = await chromium.launch();
  let failed = 0;
  for (const [name, mode] of Object.entries(MODES)) {
    const server = serve(mode);
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    for (const width of [1280, 375]) {
      const ctx = await browser.newContext({ viewport: { width, height: width === 375 ? 812 : 800 } });
      const page = await ctx.newPage();
      const problems = [];
      page.on("pageerror", e => problems.push("JS例外: " + e.message));
      page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push("console.error: " + m.text()); });
      await page.route(/maps\.googleapis\.com/, r => r.fulfill({ status: 200, contentType: "text/javascript", body: MAPS_STUB }));
      await page.route(/api\.openbd\.jp/, r => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
      await page.route(/fonts\.(googleapis|gstatic)\.com|rakuten\.co\.jp/, r => r.abort());
      await page.goto(url);
      await page.waitForTimeout(600);

      const st = await page.evaluate(() => {
        const out = [];
        const $ = id => document.getElementById(id);
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push(`横スクロールが出ている(${document.documentElement.scrollWidth}px)`);
        const notice = ($("notice") || {}).textContent || "";
        const panel = $("panel-body").textContent;
        if (/Infinity|NaN|undefined|\[object/.test(panel + document.body.textContent)) out.push("Infinity / NaN / undefined / [object が表示に混ざっている");
        return { out, notice, panel, markers: (window.__markers || []).length, items: document.querySelectorAll("#list .item").length };
      });
      problems.push(...st.out);
      const mobile = width === 375;
      if (name === "nobooks" && !/books\.json/.test(st.notice)) problems.push("books.json が無いのに断り書きが出ない");
      if ((name === "nokey" || name === "nomaps") && !/地図なし/.test(st.notice)) problems.push("地図なしの断り書きが出ない");
      if ((name === "nokey" || name === "nomaps") && st.items === 0) problems.push("地図なしなのに一覧が出ない");
      if (name === "normal" && st.markers === 0) problems.push("栞(マーカー)が1つも作られていない");
      if (name === "normal" && mobile && st.items === 0) problems.push("スマホの一覧が空");
      if (name === "normal" && !mobile && !/引用/.test(st.panel)) problems.push("案内(○の引用)が出ない");

      // ひととおり触る
      const acted = await page.evaluate(() => {
        const done = [];
        try { if (window.__markers && window.__markers[0]) { window.__markers[0].fire("gmp-click"); done.push("栞"); } } catch (e) { done.push("栞でエラー: " + e.message); }
        try { const it = document.querySelector("#list .item[data-key]"); if (it) { it.click(); done.push("一覧"); } } catch (e) { done.push("一覧でエラー: " + e.message); }
        try { const a = document.getElementById("about-link"); if (a) { a.click(); done.push(document.getElementById("back-link") ? "この地図について" : "この地図について(戻るが無い)"); } } catch (e) { done.push("この地図についてでエラー: " + e.message); }
        try { const o = document.getElementById("offmap-link"); if (o && getComputedStyle(o).display !== "none") { o.click(); done.push("地図の外"); } } catch (e) { done.push("地図の外でエラー: " + e.message); }
        return done;
      });
      await page.waitForTimeout(200);
      problems.push(...acted.filter(s => /エラー|無い/.test(s)));

      const ok = problems.length === 0;
      if (!ok) failed++;
      console.log(`${ok ? "ok  " : "NG  "} ${name.padEnd(10)} ${String(width).padStart(4)}px  栞${st.markers} 一覧${st.items}  触った: ${acted.join("・") || "-"}`);
      for (const p of problems) console.log(`       - ${p}`);
      await ctx.close();
    }
    server.close();
  }
  await browser.close();
  console.log(failed ? `\n${failed} 件 NG` : "\nすべて ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
