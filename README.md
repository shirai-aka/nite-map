# 〇〇にて — あとがきの地図

本のあとがきの「〇〇にて」を採取し、書かれた場所を地図にマッピングするキュレーションメディア。

## 構成

- `data/books/*.yaml` — 1冊=1ファイルの採取データ。**これが資産のすべて**。書式は [SCHEMA.md](SCHEMA.md)
- `build.js` — YAML を `prototype/books.json` に変換(依存なし、Node で実行)
- `prototype/index.html` — 地図プロトタイプ(Leaflet + 国土地理院淡色地図 + openBD表紙)

## 1冊追加する手順

1. `data/books/_template.yaml` をコピーして記入(ファイル名は `著者-書名スラッグ.yaml`)
2. 変換を実行:

```bash
node build.js
```

アソシエイトタグ付きのAmazonリンクを生成する場合:

```bash
AMAZON_TAG=あなたのタグ-22 node build.js
```

3. プレビューで確認(ローカルサーバー経由。file:// では books.json が読めない):

```bash
python3 -m http.server 8776 --directory prototype
```

## 既知の課題

- 表紙画像は openBD 頼みでカバー率が低い。候補は楽天ブックスAPI(無料アプリID登録のみ)か
  Amazon PA-API(過去30日以内の発送済み売上が必要 → 2026-08 時点で要件未達のため保留)
- Amazonリンクは build.js が ISBN-10 変換で自動生成する(PA-API不要)。
  YAML の links.amazon に手動URLを書けばそちらが優先される
- 国会図書館の書影APIは自ドメイン以外の Referer を 403 で弾くため使えない(2026-08 時点)
- `precision: unmappable`(機上にて等)の「地図の外」コーナーは未実装
- 穂高養生園の座標は概算(要精査)
