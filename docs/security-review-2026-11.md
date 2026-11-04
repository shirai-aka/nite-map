# セキュリティ・プライバシー点検(2026-11)

対象: `main` の 54251d5 と、PR「品質向上パス」(ブランチ `fix/cloud-quality-pass-2026-11`)の差分。
行番号は PR 適用後のもの。値(キーそのもの)はこの文書に書かない。

分類: **重大**(いますぐ対処)/ **要対応**(近いうちに)/ **情報**(把握しておく)。
この PR で直したものは「→ 対応済み」と記す。

## 結論

- **重大: なし。** API キーや `.env` は git 履歴にも現在のツリーにも入っていない。
- **要対応: 4 件**(うち 3 件はこの PR で対応済み。残り 1 件は Google Cloud 側の設定)。
- **情報: 8 件。**

---

## (1) API キーの公開面

| 判定 | 内容 | 根拠 |
|---|---|---|
| 情報 | **Google Maps のキーは公開サイトに必ず載る。** `build.js` が `prototype/config.js` に `window.NITE_CONFIG = {"googleMapsKey": ...}` を書き、`index.html` がそれを `<script src>` の URL に入れて読み込む。Maps JavaScript API の仕組み上これは避けられない。守りはキー側の制限で行う | `build.js:217-228`、`prototype/index.html:758-790` |
| 要対応 | **「API の制限」が README に書かれていなかった。** 「ウェブサイトの制限」と「1日の割り当て」は書いてあるが、キーを Maps JavaScript API だけに絞る設定が無い。流出・流用されたときに Geocoding や Places など別の課金 API を叩かれるのを防ぐ。→ README に追記(対応済み)。**Google Cloud コンソール側の設定は手で確認が必要** | `README.md` 「地図について」節 |
| 要対応 | **Referer パターンの書き方。** ブラウザの既定(`strict-origin-when-cross-origin`)では他ドメインへの要求にオリジンまでしか Referer を付けない。制限に `https://shirai-aka.github.io/nite-map/*` のようにパスまで書くと一致せず弾かれる場合がある。`https://shirai-aka.github.io/*` を推奨。→ README に追記(対応済み)。**現状で地図が出ているなら設定は合っているので、変更は不要** | `README.md:33,45` |
| 情報 | **楽天のキーはビルド時にしか使わず、出力には出ない。** `applicationId` / `accessKey` / `affiliateId` は `build.js` が楽天 API を呼ぶときだけ使う。`books.json` と `config.js` には書かれない(全文 grep で確認)。GitHub Actions では Secrets から渡し、ログにも出していない | `build.js:104-109`、`.github/workflows/pages.yml` ビルド手順 |
| 情報 | **Map ID は秘密ではない**(スタイル識別子)。公開されて問題ない | `prototype/index.html:528` |

## (2) git 履歴の混入

| 判定 | 内容 | 根拠 |
|---|---|---|
| 情報 | `git log -p --all` を次のパターンで走査: `AIza…`(Google キー)、`applicationId=数字`、`RAKUTEN_*=値`、`GOOGLE_MAPS_*=値`、`accessKey: "…"`、`AMAZON_TAG=値`。**一致したのは README と build.js のコメント内のプレースホルダ(`xxx` / `...` / `…`)だけ**で、実値は 0 件 | 走査結果(2026-11-04) |
| 情報 | 追加されたことのあるファイルに `.env`、`prototype/config.js`、`prototype/books.json` は無い(`.env.example` のみ)。`.gitignore` も 3 つを除外している | `.gitignore:6,9,12` |

## (3) `data/rakuten-cache.json`

| 判定 | 内容 | 根拠 |
|---|---|---|
| 情報 | 中身は ISBN をキーに `cover`(書影 URL)、`url`(楽天アフィリエイト URL)、`matched_by`、`matched_title` の 4 項目だけ。ホストは `thumbnail.image.rakuten.co.jp` と `hb.afl.rakuten.co.jp` の 2 つ。個人情報は無い | ファイル全体を機械的に確認 |
| 情報 | **アフィリエイト URL にはアフィリエイト ID が含まれる**(`/hgc/<ID>/` の部分)。これは公開ページのリンクに載る前提の識別子なので秘密ではないが、「アプリ ID / アクセスキー」とは別物であることは把握しておく。キャッシュに入っているのはリンクだけで、API の資格情報は入っていない | `data/rakuten-cache.json` の `url` |

## (4) `prototype/index.html` の XSS

| 判定 | 内容 | 根拠 |
|---|---|---|
| 要対応 | **YAML 由来の文字列を生のまま `innerHTML` に入れていた。** `main` では引用(`displayQuote`)、書名、著者、訳者、地名、「地図の外」の見出しがエスケープなしでテンプレート文字列に埋められていた。データは管理人が書くものなので第三者による注入経路は無いが、書名に `<` や `&` が入れば崩れ、将来 `contributor` 投稿を受け付けるようになれば XSS になる。→ すべて `esc()` を通す(対応済み、コミット cad71bf) | `prototype/index.html:337-379, 414, 467, 593, 728` |
| 要対応 | **外部 URL のスキーム。** `href` と `src` に入る楽天 URL・Amazon URL・書影 URL は API やキャッシュ由来で、`main` では検査せず埋めていた。`javascript:` などが混ざる経路は現状無いが、`https://` で始まるものだけ通す `safeUrl()` を入れた(対応済み) | `prototype/index.html:351-354, 357-363, 371` |
| 情報 | 残る `innerHTML` の挿入点は、固定の SVG(330)、エスケープ済みの文字列を受ける `setPanel` / `setNotice`(383, 396)、`location.origin`(773)で、生のデータは入らない。`e.message` も `esc()` を通している | `prototype/index.html:330, 383, 396, 773` |
| 情報 | 外部リンクは `target="_blank" rel="noopener"` 済み(`window.opener` 経由の乗っ取り対策) | `prototype/index.html:362-363, 445` |

## (5) 外部スクリプト・SRI・CSP

| 判定 | 内容 | 根拠 |
|---|---|---|
| 情報 | 読み込む外部資源: Google Maps JS(`maps.googleapis.com`、そこから `maps.gstatic.com` など)、Google Fonts(`fonts.googleapis.com` → `fonts.gstatic.com`)、openBD(`api.openbd.jp`、書影は `cover.openbd.jp`)、楽天の書影(`thumbnail.image.rakuten.co.jp`)。Leaflet / OSM タイルは README に残っているが **現在のページでは使っていない** | `prototype/index.html:27, 310, 781`、`README.md` 「以前の基盤地図について」 |
| 情報 | **SRI は付けられない。** Google Maps のローダは版ごと・言語ごとに中身が変わる動的スクリプトで、Google Fonts の CSS もブラウザごとに異なる。固定ハッシュで検証する SRI の対象にならない。付けられるのは自前の静的ファイルだけで、同一オリジン配信なので意味が薄い | 同上 |
| 情報 | **全面的な CSP は見送り。** `script-src` を書くには Google Maps が使う `*.googleapis.com` `*.gstatic.com` `*.google.com`、`blob:` ワーカー、インラインスクリプト(`'unsafe-inline'` かハッシュ)を列挙する必要があり、GitHub Pages ではヘッダを付けられないので `<meta>` で入れることになる。実機で Google の地図を出して確認できない環境では、誤ると地図が消えるので入れていない。代わりに、使っていない機構だけ閉じる最小の CSP(`base-uri 'none'; object-src 'none'; form-action 'none'`)を `<meta>` で入れた(対応済み)。全面的に入れるときの案: <br>`default-src 'self'; script-src 'self' 'unsafe-inline' https://*.googleapis.com https://*.gstatic.com https://*.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com https://api.openbd.jp data: blob:; worker-src blob:; frame-src https://*.google.com; base-uri 'none'; object-src 'none'; form-action 'none'` を入れ、実機で地図・栞・書影・フォントを確認してから残す | `prototype/index.html` `<head>` |

## (6) GitHub Actions

| 判定 | 内容 | 根拠 |
|---|---|---|
| 要対応 | **権限がワークフロー全体に付いていた。** `contents: read` + `pages: write` + `id-token: write` が build ジョブにも及んでいた。build は読み取りだけでよいので、既定を `permissions: {}` にしてジョブごとに最小化した(対応済み)。`validate.yml` は `contents: read` のみ | `.github/workflows/pages.yml:10-13`(変更前)、`validate.yml:11-12` |
| 情報 | **サードパーティ action は `actions/*` 公式のみ**で、メジャー版タグ(`@v4` / `@v3`)で固定。タグは動くので、より厳密にはコミット SHA で固定する(`actions/checkout@<sha> # v4.x`)。この環境からは SHA を照合できなかったので変更していない。やるなら Dependabot(`.github/dependabot.yml` の `package-ecosystem: github-actions`)で追従させる | `pages.yml:24-26, 53, 65`、`validate.yml:18-20` |
| 情報 | `pull_request_target` は使っていない。`validate.yml` は PR で動くが Secrets を使わないので、フォークからの PR でも秘密は漏れない。ビルドのキー確認手順は値を出さず有無だけ見ている | `pages.yml` 「地図のキーが入ったか確認」、`validate.yml` |
| 情報 | 配信物(`prototype/`)に `config.js`(地図キー入り)が含まれるのは設計どおり。`.env` や楽天キーは含まれない | `pages.yml` upload-pages-artifact |

## (7) アフィリエイトとプライバシー表記

| 判定 | 内容 | 根拠 |
|---|---|---|
| 情報 | **Amazon アソシエイトの必須文言はある**(「Amazonのアソシエイトとして、「〇〇にて」は適格販売により収入を得ています」)。楽天アフィリエイトへの参加も明記 | `prototype/index.html:437-438` |
| 情報 | **第三者送信の説明が無い。** 地図(Google)、フォント(Google)、書影(楽天・openBD)の読み込みで、閲覧者の IP アドレスなどが各社に送られる。アフィリエイトリンクをクリックすると楽天・Amazon が Cookie を発行する。日本の法令上、個人運営の静的サイトで義務にはなりにくいが、「この地図について」に一文(例: 「地図・書体・書影の表示のため、Google・楽天・openBD のサーバーに閲覧者のアクセス情報が送られます」)を足すとよい。文章はオーナーの判断なので、この PR では変えていない | `prototype/index.html:417-446` |
| 情報 | サイト自体はアクセス解析や Cookie を使っていない(`localStorage` も不使用) | `prototype/index.html` 全体 |

## 点検の手順(再現用)

```bash
# 履歴のキー走査(値は出さない)
git log -p --all | grep -cE 'AIza[0-9A-Za-z_-]{20,}|applicationId=[0-9]{10,}'
git log --all --diff-filter=A --name-only -- '.env*' 'prototype/config.js' 'prototype/books.json'
# 出力物にキーが無いこと
node build.js && grep -cE 'applicationId|accessKey' prototype/books.json   # 0
# HTML の挿入点
grep -nE 'innerHTML|href="\$\{|src="\$\{' prototype/index.html
```
