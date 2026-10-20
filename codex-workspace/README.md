# codex-workspace

`codex app-server` を、渡した作業場所だけをマウントした Docker のコンテナの中で動かし、
Python から操る部品です。コンテナを囲いにするので、Codex には囲いなし（`danger-full-access`）で
コマンドの実行とファイルの書き込みを許します。コンテナから見えるのは、作業場所（`/workspace`）と
認証情報のファイル1つ（`/codex/auth.json`）だけです。

Codex の版は固定しません。イメージは、無いときと、作ってから決まった日数がたったときに作り直し、
そのときの最新の Codex を入れます。

TypeScript 版（[`@infodb/codex-workspace`](../codex-workspace-ts)）と同じ機能・同じイメージ
（`llmcs-codex-workspace:local`）です。名前の対応と、版を上げたときに呼ぶ側で書き換える箇所は
[DIFFERENCES.md](DIFFERENCES.md) にまとめています。

## 使い方

uv の git 依存で、タグ（`codex-workspace-v<版>`）を指定して入れます。

```toml
[project]
dependencies = ["codex-workspace"]

[tool.uv.sources]
codex-workspace = { git = "https://github.com/tamuto/llmcs", subdirectory = "codex-workspace", tag = "codex-workspace-v0.3.1" }
```

```python
from codex_workspace import UsageLimitError, WorkspaceSession, docker_command, ensure_image

ensure_image()  # 無いか1日より古ければ作り直す (最新の Codex を入れる)
command = docker_command("/mnt/usb/assets/kotonoha/graph", auth_volume="denv-cc-remote_codex-state")
with WorkspaceSession(command, model="gpt-6.1-sol", effort="medium") as session:
    usage = session.usage()  # 5時間 (300分) と週 (10080分) の窓の使用率
    if usage.reached:
        raise RuntimeError("使用量の上限です")
    session.start_thread("作業の決まり (developer instructions)")
    result = session.run_turn("inbox/a.md を取り込んでください")
    print(result.changed, result.usage)  # 書き換えたファイルと、使ったトークン
    session.run_turn("次の誤りを直してください …")  # 同じスレッドに続けて頼む
```

- 例外は `WorkspaceError`。使用量の上限に当たったターンは、その派生の `UsageLimitError`
  （待てば戻るが、すぐに頼み直しても同じように失敗するので、続けて頼むのをやめる）。
- `run_turn(text, cancel=event)` — `threading.Event` を set すると `turn/interrupt` を送り、
  `status == "interrupted"` の結果を返す（例外にしない）。
- イメージはパッケージに同梱した Dockerfile から作る。すぐ作り直すには `ensure_image(max_age=timedelta(0))`。
  自分で作るときは `with docker_context() as path:` でそのフォルダ（Dockerfile だけ）を得る。
- コンテナには Codex が作業に使う道具として、`rg` と、`python` / `python3`（同じもの）と PyYAML を入れている。
  YAML は `yaml.safe_load` で読み、変えたいところだけを変えて `yaml.safe_dump` で書ける。
- 作り直すかどうかはイメージの作成日時だけで決める。版を上げてイメージの中身が変わったときは、
  1日待たずに `ensure_image(max_age=timedelta(0))` で作り直す。イメージの名前は TypeScript 版や古い版と同じなので、
  古い版のパッケージで作り直すと、道具も古い版のものに戻る。

## Sign in with ChatGPT（プラン利用）で動かす

[公式の Codex app-server の手順](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)のとおり、
呼ぶ側が Sign in with ChatGPT で得た access token を環境変数で渡し、Codex 自身のサインイン（auth.json）を使わずに動かせます。
サインイン・トークンの保存と更新は呼ぶ側が行います（このパッケージはトークンを扱わない）。

```python
from codex_workspace import ACCESS_TOKEN_ENV, WorkspaceSession, docker_command

# 認証のファイルはマウントしない。-e ACCESS_TOKEN（名前だけ）と、プラン利用の provider の設定（-c）を付ける
command = docker_command("/path/to/workspace", access_token_env=ACCESS_TOKEN_ENV)
# env の値はプロセスの環境で渡す（引数・ログ・例外には出さない）。client_info の name は agent_name_hint と同じに
with WorkspaceSession(
    command,
    env={ACCESS_TOKEN_ENV: access_token},
    client_info={"name": "my_app", "title": "My App", "version": "1.2.3"},
) as session:
    thread = session.start_thread("…")
    session.run_turn("…")

    # トークンを更新したら、起動し直してスレッドを続ける（記録を残すスレッドのとき）
    session.restart(env={ACCESS_TOKEN_ENV: renewed})
    session.resume_thread(thread)
```

- `chatgpt_plan_overrides(env_key)` — プラン利用の provider の設定（`model_provider="openai_chatgpt_plan"` ほか）。`docker_command` が付ける
- 使用量の上限（`subscription_sharing_usage_limit_exceeded`）も `UsageLimitError` にする
- `usage()`（`account/rateLimits/read`）は Codex 自身のサインインが前提なので、この方式では呼ばない
- `start_thread` は記録を残さない（`ephemeral`）スレッドで、`--rm` のコンテナは終わると消えるため、起動し直した後に
  `resume_thread` できるのは記録を残す使い方をしたときだけ

## 開発

```bash
uv run pytest -q     # 偽の app-server (tests/fake_app_server.py) で JSON-RPC のやりとりを確かめる
uv run ruff check .
uv run ruff format --check .
docker build -t llmcs-codex-workspace:local src/codex_workspace/docker   # 手で作り直すとき
```

版を上げるときは `pyproject.toml` の `version` と `session.py` の `CLIENT_VERSION` を揃え、
テストを通してから `codex-workspace-vX.Y.Z` のタグを打ちます。TypeScript 版の振る舞いを変えたときは、
こちらにも同じ変更を入れます。片方にだけ入れたものは [DIFFERENCES.md](DIFFERENCES.md) に書きます。
