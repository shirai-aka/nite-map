# 〇〇にて — あとがきの地図

本のあとがきの「〇〇にて」を採取し、書かれた場所を地図にマッピングするキュレーションメディア。

## 構成

- `data/books/*.yaml` — 1冊=1ファイルの採取データ。**これが資産のすべて**。書式は [SCHEMA.md](SCHEMA.md)
- `build.js` — YAML を `prototype/books.json` に変換(依存なし、Node で実行)
- `prototype/index.html` — 地図プロトタイプ(Leaflet + OSM日本タイル + openBD表紙)

## 公開(GitHub Pages)

`main` に push すると `.github/workflows/pages.yml` が動き、ビルドしてから
`prototype/` を配信する。`books.json` と `config.js` はリポジトリに置いていない
(生成物・APIキーを含む)ため、配信前に CI で生成している。

必要な GitHub Secrets(Settings → Secrets and variables → Actions):

| 名前 | 用途 |
|---|---|
| `GOOGLE_MAPS_KEY` | 地図の表示。無いとビルドを失敗させている |
| `GOOGLE_MAPS_MAP_ID` | 栞のピン(Advanced Markers)に必要 |
| `RAKUTEN_APP_ID` / `RAKUTEN_ACCESS_KEY` / `RAKUTEN_AFFILIATE_ID` | 書影とアフィリエイトリンク |
| `AMAZON_TAG` | Amazonアソシエイトのタグ |

楽天は取得済みの分が `data/rakuten-cache.json` にあるため、キーが無くても
既存の本のリンクは生成される(新しく足した本だけ取りに行く)。

公開URL: https://shirai-aka.github.io/nite-map/
このURLを Google の APIキー制限と、楽天の「許可されたウェブサイト」に入れておくこと。

## 地図について(Google Maps)

Maps JavaScript API を使う。キーと Map ID は `.env` に置き、`build.js` が
`prototype/config.js` を書き出してブラウザへ渡す(config.js は .gitignore 済み)。

- 地名は全世界が日本語(`language=ja&region=JP`)
- ピン(栞)は Advanced Markers を使うため **Map ID が必須**
- 日本を中央に置くのは中心経度を138度にするだけでよい(世界が横に繰り返すため)
- 課金対策として、Google Cloud 側で **1日あたりの割り当てを300回程度に制限**している。
  上限に達するとリクエストが止まり、課金には進まない
- キーは「ウェブサイトの制限」で `http://localhost:8776/*` と公開先URLのみ許可

注意: プレビュー枠(Claude Code のブラウザペイン)では requestAnimationFrame が
動かないため、Google の地図は描画されない。確認は通常のブラウザで
`http://localhost:8776` を開いて行う。

## 以前の基盤地図について(参考)

タイルは OSM Foundation Japan の `tile.openstreetmap.jp` をそのまま使う。
地名はその土地の言葉で出る(日本は日本語、セネガルはフランス語、米国は英語)。

一度セピア調フィルタで色を落としたが、陸も海も道も同じ色に潰れて
「静か」ではなく「平坦」になったため撤去した。地図は見慣れた姿のままにする。

Google マップも検討したが、利用開始に Google Cloud の請求先アカウント
(クレジットカード)が必要。月1万回の地図表示までは無料枠に収まる規模なので、
必要になったら移行を検討する。

国土地理院の淡色地図から乗り換えた理由は、地理院タイルが日本国外をほぼ描画しない
ため(ズーム12のダカールで地理院は事実上空白、OSM日本は約68KB)。海外で書かれた本を
扱う以上、拡大したときにその土地の街路が見えることを優先した。

ライセンスは CC-BY で「©OpenStreetMap Contributors」の表示が必須。
無償のコミュニティ運営サーバなので、アクセスが増えた場合は自前配信か
有償サービス(MapTiler 等。全世界日本語表記も可能)への移行を検討する。

## 1冊追加する手順

1. `data/books/_template.yaml` をコピーして記入(ファイル名は `著者-書名スラッグ.yaml`)
2. 変換を実行:

```bash
node build.js
```

### APIキーを使う場合(楽天の書影・アフィリエイト、Amazonタグ)

最初に一度だけ、雛形をコピーしてキーを書き込む:

```bash
cp .env.example .env
```

`.env` を編集して値を入れたら、以降はこのコマンドでビルドする:

```bash
node --env-file=.env build.js
```

`.env` は `.gitignore` 済みなのでコミットされない。
楽天の取得結果は `data/rakuten-cache.json` に貯まり、2回目以降は
新しく足した本だけ取りに行く。キャッシュがあれば `node build.js`
(キーなし)でもビルドできる。

楽天APIの注意点(2026-08 時点):

- `Origin` と `Referer` が「許可されたウェブサイト」と一致しないと 403。
  サーバー側からの呼び出しでは自動で付かないので build.js が明示している
  (既定値は `https://shirai-aka.github.io`。`RAKUTEN_ORIGIN` で変更可)
- アクセスキーはヘッダー名 `accessKey`(`Access-Key` では 400)
- 絶版・旧版はISBN検索に出てこない。書名で引き直すが、別の版が
  当たることがあるためキャッシュに `matched_by` / `matched_title` を残している

3. プレビューで確認(ローカルサーバー経由。file:// では books.json が読めない):

```bash
python3 -m http.server 8776 --directory prototype
```

## 既知の課題

- 表紙画像は openBD 頼みでカバー率が低い(15冊中1冊)。楽天ブックスAPIを
  ビルド時に呼ぶ口は用意済み(上記の環境変数)。鍵を入れれば表紙が埋まる。
  Amazon PA-API は過去30日以内の発送済み売上が必要で、2026-08 時点は要件未達のため保留
- Amazonリンクは build.js が ISBN-10 変換で自動生成する(PA-API不要)。
  YAML の links.amazon に手動URLを書けばそちらが優先される
- 国会図書館の書影APIは自ドメイン以外の Referer を 403 で弾くため使えない(2026-08 時点)
- `precision: unmappable`(機上にて等)の「地図の外」コーナーは未実装
- 穂高養生園の座標は概算(要精査)
