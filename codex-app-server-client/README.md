# Codex App Server client

`codex app-server` を stdio の JSON-RPC で叩く Python クライアント。認証は `codex login`、
モデルは既定で Codex の設定を継承します。

minamo / shexa から共通で使うライブラリです。アプリ固有のプロンプト・スキーマ・収集処理は
ここに置きません。

## 使い方

uv の git 依存で、llmcs リポジトリの `codex-app-server-client/` を参照します。タグで版を固定してください
（`uv.lock` がコミットまで記録します）。llmcs には複数のパッケージがあるので、タグはパッケージ名を
頭に付けた `codex-app-server-client-v<版>` にします。

```toml
[project]
dependencies = ["codex-app-server-client"]

[tool.uv.sources]
codex-app-server-client = { git = "https://github.com/tamuto/llmcs", subdirectory = "codex-app-server-client", tag = "codex-app-server-client-v0.2.0" }
```

手元でこのライブラリと利用側を同時に直すときは、一時的にローカルのパスへ向けます
（`uv add --editable ../llmcs/codex-app-server-client`）。コミットする前に git 依存へ戻してください。

```python
from codex_app_server_client import CodexAppServerClient, LLMError

with CodexAppServerClient() as client:
    data = client.generate_json(instructions=..., prompt=..., schema={...})
    images = client.generate_image(
        instructions=...,
        prompt="この部屋に人物を一人足す",
        extra_input=({"type": "image", "url": "data:image/png;base64,..."},),
    )
    open("out.png", "wb").write(images[0].data)
```

クライアントはプロセス、JSON-RPC、構造化出力、再試行、承認要求の拒否、予期しないツール利用の
中断を担当します。read-only sandbox は完全なツール無効化ではありません。利用側も入力を資料として
扱う指示を渡してください。

## 許すツール

既定ではターン中にツールが動き出した時点で打ち切ります。未信頼の文章を読ませる用途の前提です。

- **画像生成**: `generate_image` を呼んだときだけ `imageGeneration` を許します。作られた画像は
  `GeneratedImage.data`（バイト列）で返り、codex が保存した場所は `saved_path` に残ります。
  画像を作らずに文章だけ返した場合は `LLMError(kind="no-image")` になります。
- **web 検索**: `web_search="live"` と `allowed_item_types=RESEARCH_ITEM_TYPES` を渡すと
  web 検索だけを許可できます。何を検索したかは `last_web_searches` に残ります。
  **入力が未信頼でないことを確かめた呼び出しだけ**で使ってください。
- **シェルの開始だけ許して断る**: `decline_item_types=RESEARCH_DECLINE_TYPES` を渡すと、
  承認要求を `decline` で断ったうえでターンを継続させます。**実行そのものは許しません。**
  断る前に実行まで進んだ場合と、`max_declines` を超えて繰り返す場合はターンを打ち切ります。
  何を試そうとしたかは `last_declined` に残ります。

## 開発

```bash
uv sync
uv run pytest        # 偽の codex (tests/fake_codex.py) で JSON-RPC のやりとりを確かめる
uv run ruff check .
```

版を上げるときは `pyproject.toml` と `__init__.py` の `__version__` を揃え、`vX.Y.Z` のタグを打ちます。

## 変更履歴

- **0.2.0**: 画像生成（`generate_image`、`GeneratedImage`、`IMAGE_ITEM_TYPES`）を追加。
  `last_images` / `last_message` を追加。既存の `generate_json` の振る舞いは変えていない。
- **0.1.0**: minamo の kumu 向けに作った版。
