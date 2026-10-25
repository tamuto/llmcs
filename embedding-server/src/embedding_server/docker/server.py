"""文をベクトルにする HTTP サーバ。

OpenAI と同じ形の `/v1/embeddings` を出す。呼ぶ側は URL とモデル名だけを知っていればよく、
裏を GPU のマシンや既製のサーバ (Text Embeddings Inference、llama-server) に替えても
呼ぶ側は変わらない。

読み込むモデルは models.json で Hugging Face のコミットに固定する。返すベクトルは
長さ1にそろえてある (内積がそのままコサイン類似度になる)。どのモデルのどの版で
作ったかを応答に入れて返すので、呼ぶ側はベクトルと一緒に保存しておく。
違うモデルや違う版のベクトル同士は比べられない。

入力はそのままモデルに渡す。ruri-v3 の「トピック: 」のような接頭辞は、何に使うかを
知っている呼ぶ側が付ける。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODELS_FILE = Path(os.environ.get("MODELS_FILE", Path(__file__).with_name("models.json")))
MAX_INPUTS = int(os.environ.get("MAX_INPUTS", "512"))
"""1回で受け取る文の数の上限。題名なら数百件をまとめて送れる。"""


def load_models() -> dict[str, dict]:
    """models.json のうち、環境変数 MODELS に挙げたものを読み込む (未指定なら全部)。"""
    catalog = {entry["name"]: entry for entry in json.loads(MODELS_FILE.read_text())["models"]}
    wanted = [name.strip() for name in os.environ.get("MODELS", "").split(",") if name.strip()]
    unknown = set(wanted) - set(catalog)
    if unknown:
        raise SystemExit(f"models.json に無いモデルです: {sorted(unknown)}")
    loaded = {}
    for name in wanted or list(catalog):
        entry = catalog[name]
        model = SentenceTransformer(entry["repo"], revision=entry["revision"], device=_device())
        loaded[name] = {**entry, "model": model}
    return loaded


def _device() -> str:
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


class EmbeddingRequest(BaseModel):
    model: str
    input: str | list[str]


app = FastAPI(title="embedding-server")
MODELS = load_models()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "device": _device(), "models": list(MODELS)}


@app.get("/v1/models")
def models() -> dict:
    return {
        "object": "list",
        "data": [
            {
                "id": name,
                "object": "model",
                "repo": entry["repo"],
                "revision": entry["revision"],
                "dimensions": entry["model"].get_sentence_embedding_dimension(),
                "max_seq_length": entry["model"].max_seq_length,
                "normalized": True,
            }
            for name, entry in MODELS.items()
        ],
    }


@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest) -> dict:
    entry = MODELS.get(request.model)
    if entry is None:
        raise HTTPException(404, f"読み込んでいないモデルです: {request.model} ({', '.join(MODELS)})")
    texts = [request.input] if isinstance(request.input, str) else request.input
    if not texts or any(not isinstance(text, str) or not text.strip() for text in texts):
        raise HTTPException(400, "input は空でない文字列か、その配列にしてください")
    if len(texts) > MAX_INPUTS:
        raise HTTPException(400, f"input は1回に{MAX_INPUTS}件までです: {len(texts)}件")

    model = entry["model"]
    vectors = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
    tokens = sum(len(ids) for ids in model.tokenizer(texts)["input_ids"])
    return {
        "object": "list",
        "model": request.model,
        # OpenAI の形には無い。ベクトルと一緒に保存して、版の違うもの同士を比べないために返す。
        "revision": entry["revision"],
        "data": [
            {"object": "embedding", "index": index, "embedding": vector.tolist()}
            for index, vector in enumerate(vectors)
        ],
        "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
    }
