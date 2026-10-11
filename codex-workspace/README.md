# codex-workspace

`codex app-server` を、渡した作業場所だけをマウントした Docker のコンテナの中で動かし、
Python から操る部品です。コンテナを囲いにするので、Codex には囲いなし（`danger-full-access`）で
コマンドの実行とファイルの書き込みを許します。コンテナから見えるのは、作業場所（`/workspace`）と
認証情報のファイル1つ（`/codex/auth.json`）だけです。

Codex の版は固定しません。イメージは、無いときと、作ってから決まった日数がたったときに作り直し、
そのときの最新の Codex を入れます。

## TypeScript 版との差分（直す予定）

TypeScript 版（`@infodb/codex-workspace`）が先に進んでいて、Python 版にはまだ無い機能があります
（access token での認証、起動し直してスレッドを続ける、ターンの中止など）。一覧と、呼ぶ側で探す箇所は
[DIFFERENCES.md](DIFFERENCES.md) にまとめています。
