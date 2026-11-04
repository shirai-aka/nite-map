// data/books/*.yaml 用の限定 YAML パーサ。依存なし。
// SCHEMA.md の書式(トップレベルのスカラー、またはスカラーだけを持つ1段のセクション)だけを扱う。
// build.js と tools/validate.js の両方から使う。
//
// 扱うもの:  key: value / key:(セクション開始) / 2スペース等のインデント / # コメント(行全体・行末)
//            "二重引用符" と '単一引用符' / null, ~, true, false / 数値
// 扱わないもの: 配列(- 項目)、3階層以上、複数行文字列、アンカー。見つけたら例外にする。
"use strict";

class YamlLiteError extends Error {
  constructor(file, line, message) {
    super(`${file}:${line}: ${message}`);
    this.file = file;
    this.line = line;
    this.detail = message;
  }
}

// 行末コメントを落とし、引用符を外して値にする。
// YAML では「空白 + #」からがコメント。引用符の中の # はコメントではない
function parseValue(raw, file, lineNo) {
  let s = raw.trim();
  if (s === "") return null;

  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    let i = 1, out = "";
    for (; i < s.length; i++) {
      const c = s[i];
      if (q === '"' && c === "\\") {
        const n = s[i + 1];
        const map = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/" };
        if (n in map) { out += map[n]; i++; continue; }
        out += c;
        continue;
      }
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") { out += "'"; i++; continue; } // '' は ' のエスケープ
        break;
      }
      out += c;
    }
    if (i >= s.length) throw new YamlLiteError(file, lineNo, `引用符が閉じていない: ${raw.trim()}`);
    const rest = s.slice(i + 1).trim();
    if (rest !== "" && !rest.startsWith("#")) {
      throw new YamlLiteError(file, lineNo, `引用符の後ろに余計な文字がある: ${raw.trim()}`);
    }
    return out; // 引用符付きは常に文字列(数値や null にしない)
  }

  // 引用符なし: 行末コメントを除く
  s = s.replace(/\s+#.*$/, "").trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("- ") || s === "-") throw new YamlLiteError(file, lineNo, `配列(- 項目)は使えない: ${raw.trim()}`);
  return s;
}

// 戻り値: { data, lines } 。lines は "key" / "section.key" → 行番号(1始まり)。
function parseYamlWithLines(text, file = "(yaml)") {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const data = {};
  const lines = {};
  let pendingKey = null;   // 「key:」だけの行を見た直後。子が来たらセクションにする
  let section = null;      // いま子を受け取っているセクション
  let sectionKey = null;
  let childIndent = null;  // そのセクションの子のインデント幅

  const src = text.split(/\r?\n/);
  for (let idx = 0; idx < src.length; idx++) {
    const lineNo = idx + 1;
    const raw = src[idx];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const lead = raw.match(/^[ \t]*/)[0];
    if (lead.includes("\t")) throw new YamlLiteError(file, lineNo, "インデントにタブは使えない(スペースにする)");
    const indent = lead.length;

    const m = trimmed.match(/^([^:#"']+?)\s*:(?:\s+(.*)|\s*)$/);
    if (!m) {
      if (trimmed.startsWith("-")) throw new YamlLiteError(file, lineNo, `配列(- 項目)は使えない: ${trimmed}`);
      throw new YamlLiteError(file, lineNo, `パースできない行(「key: value」の形にする): ${trimmed}`);
    }
    const key = m[1].trim();
    const rest = m[2] === undefined ? "" : m[2];

    if (indent === 0) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        throw new YamlLiteError(file, lineNo, `キーが重複している: ${key}`);
      }
      section = null; sectionKey = null; childIndent = null; pendingKey = null;
      lines[key] = lineNo;
      if (rest.trim() === "" || rest.trim().startsWith("#")) {
        // 「key:」だけ。次の行が字下げされていればセクション、されていなければ null
        data[key] = null;
        pendingKey = key;
      } else {
        data[key] = parseValue(rest, file, lineNo);
      }
      continue;
    }

    // 字下げされた行 = セクションの子
    if (!section) {
      if (!pendingKey) throw new YamlLiteError(file, lineNo, `予期しないインデント: ${trimmed}`);
      section = {};
      sectionKey = pendingKey;
      data[sectionKey] = section;
      childIndent = indent;
      pendingKey = null;
    }
    if (indent !== childIndent) {
      throw new YamlLiteError(file, lineNo,
        indent > childIndent ? `3階層以上の入れ子は使えない: ${trimmed}` : `インデント幅が揃っていない: ${trimmed}`);
    }
    if (Object.prototype.hasOwnProperty.call(section, key)) {
      throw new YamlLiteError(file, lineNo, `キーが重複している: ${sectionKey}.${key}`);
    }
    if (rest.trim() === "" || rest.trim().startsWith("#")) {
      section[key] = null;
    } else {
      section[key] = parseValue(rest, file, lineNo);
    }
    lines[`${sectionKey}.${key}`] = lineNo;
  }
  return { data, lines };
}

function parseYaml(text, file) {
  return parseYamlWithLines(text, file).data;
}

module.exports = { parseYaml, parseYamlWithLines, parseValue, YamlLiteError };
