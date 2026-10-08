# codex app-server を、渡した作業場所だけが見えるコンテナの中で動かす。
#
# コンテナそのものを囲いにするので、Codex には danger-full-access (囲いなし) で
# コマンドの実行とファイルの書き込みを許す。コンテナに入れるのは、作業場所 (/workspace) と
# 認証情報のファイル1つ (/codex/auth.json) だけにする (→ codex_workspace)。
# ホストのファイルや、ほかのプロジェクトは見えない。
#
# Codex の版は固定しない。作るたびにその時点の最新を入れる。CODEX_REFRESH を変えると
# Codex を入れる段からやり直すので、日付を渡して作り直せば最新になる (→ ensure_image)。
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep python3 \
    && rm -rf /var/lib/apt/lists/*

ENV CODEX_HOME=/codex \
    CODEX_INSTALL_DIR=/usr/local/bin
ARG CODEX_REFRESH=unset
RUN echo "codex refresh: ${CODEX_REFRESH}" \
    && curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/install.sh \
    && CODEX_NON_INTERACTIVE=1 sh /tmp/install.sh \
    && rm /tmp/install.sh \
    && codex --version

# 認証はファイルに置く (OS の keyring を使わない)。auth.json は実行のときにマウントする。
RUN printf 'cli_auth_credentials_store = "file"\n' > /codex/config.toml

WORKDIR /workspace
ENTRYPOINT ["codex", "app-server"]
