# シャドーイング練習アプリ

自分で入力した英語の例文・表現をもとに、ElevenLabsのAPIで音声を生成してシャドーイングを練習するための個人用Webアプリです。ビルド不要・サーバー不要の静的サイトで、GitHub Pagesで公開してスマートフォンから使えます。

公開URL: https://yukify9926-svg.github.io/test/

## 主な機能

**練習**
- 再生中に読んでいる単語をハイライト表示(ElevenLabsの文字単位タイムスタンプを使用)
- 単語をタップするとその位置から再生
- スクリプトの日本語訳を英文と併記表示 / 非表示(自分で用意した和訳、またはClaude APIで生成)
- 単語を長押しすると、その文脈での意味・品詞・使い方・例文を表示
- 5秒戻る / 5秒進む、シークバー、0.5〜1.25倍の速度調整
- リピート再生と、聞き取りにくい箇所を繰り返すA-B区間リピート
- 練習回数と最終練習日の記録、前後のスクリプトへの移動

**スクリプト管理**
- 英文と和訳を1つの欄にまとめて貼り付けると、対応させて登録し練習画面に併記表示(和訳を用意していればClaude APIは不要)
- 長い文章を貼り付けると文ごとに分割して登録
- メモ・タグの付与、キーワード検索
- JSONでの書き出し / 読み込み

**その他**
- 生成した音声と単語タイミングを端末内(IndexedDB)に保存するため、同じスクリプトを再生してもAPIを消費しない
- ホーム画面に追加すると全画面のアプリとして起動(PWA)
- ダークモード対応

## 使い方

1. 公開URLをブラウザで開く
2. 「設定」タブでElevenLabsのAPI KeyとVoice IDを入力して保存
   - API Key: https://elevenlabs.io/app/settings/api-keys で発行。権限は「テキスト読み上げ」のみで動作します
   - Voice ID: ElevenLabsの **My Voices** にある音声のIDを使用してください。無料プランではVoice Libraryの音声をAPIから利用できません
   - APIキーはこの端末のブラウザ(localStorage)にのみ保存され、リポジトリには含まれません
3. 日本語訳と語彙解説も使う場合は、同じ画面でAnthropic API Keyを入力(https://platform.claude.com/settings/keys で発行)。空のままでも音声機能は使えます
   - Claude Opus 5 を使用。1回あたりの目安は翻訳が約0.7円、語彙が約1.2円(入力 $5/100万トークン、出力 $25/100万トークン)。結果は端末に保存されるため、同じ文・同じ単語で再課金されません
4. 「スクリプト」タブで練習したい英文を追加
5. 「練習する」→「音声を生成」で再生開始

## スクリプトの入力形式

「スクリプト」タブの入力欄に、**英文の次の行に和訳**を書いて貼り付けます。ペアの間の空行は入れても入れなくても構いません。

```
I've been meaning to reach out to you.
ずっと連絡しようと思っていました。

Let's circle back next week.
来週また改めて話しましょう。
```

- **和訳は省略可**。英文だけの行はそのまま登録され、あとからClaude APIで翻訳できます
- **英文から始める**必要があります(日本語の行は直前の英文に紐づくため)
- 和訳が長くて2行に分かれている場合は、続く日本語の行がまとめて1つの訳になります
- 英文をすべて並べたあとに同じ数の和訳を並べる書き方も認識します
- 1行に複数の文が入っている場合は、「1行に複数の文があるときは文ごとに分ける」をオンにすると英日それぞれ文ごとに分割して対応させます(数が合わない場合はエラーになります)

行が言語の区切りになるため、英文・和訳のどちらにも改行を含めないでください。

## データの保存

スクリプトはブラウザのlocalStorage、生成音声はIndexedDBに保存されます。別の端末に移したい場合は「設定」タブからJSONを書き出し、移行先で読み込んでください。

## ローカルでの実行

```bash
python3 -m http.server 8000
# http://localhost:8000 を開く
```

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面構造 |
| `style.css` | スタイル(モバイル向けレイアウト、ダークモード) |
| `app.js` | 再生・ハイライト・データ管理 |
| `manifest.json` | ホーム画面に追加するためのPWA設定 |
| `vendor/anthropic.js` | Anthropic公式SDKをブラウザ向けにバンドルしたもの |
| `data/scripts.sample.json` | サンプルスクリプト |

### vendor/anthropic.js の更新

日本語訳と語彙解説は[Anthropic公式TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)を使っています。アプリ自体はビルド不要にしたいので、SDKだけを事前にバンドルして同梱しています。更新するときは以下を実行してください(現在同梱しているのは v0.117.1)。

```bash
npm install @anthropic-ai/sdk esbuild
echo 'export { default } from "@anthropic-ai/sdk";' > entry.js
npx esbuild entry.js --bundle --format=esm --platform=browser \
  --conditions=browser,import --external:node:* --minify --outfile=vendor/anthropic.js
```
