"""LLM の抽象。

意図的に1メソッドしか持たない。利用側が LLM に求めるのは
「指示とテキストを渡してスキーマ通りの JSON を返してもらう」だけ。
これ以上増やすと差し替えが難しくなる。
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


class LLMError(RuntimeError):
    """LLM 呼び出しの失敗。"""

    def __init__(self, message: str, *, retryable: bool = False, kind: str = "other") -> None:
        super().__init__(message)
        self.kind = kind
        """失敗の種類。投げ直す回数を種類ごとに変えるのに使う。"""

        self.retryable = retryable
        """時間を置けば直る種類の失敗か。

        モデルの一時的な混雑や接続断はこちら。認証エラーや入力が長すぎる
        といった、待っても直らないものは含めない。
        """


@runtime_checkable
class LLMClient(Protocol):
    @property
    def fingerprint(self) -> str:
        """モデルの同一性を表す文字列。

        recipe fingerprint に混ざるので、これが変われば artifact は再生成される。
        """

    def generate_json(
        self,
        *,
        instructions: str,
        prompt: str,
        schema: dict,
    ) -> dict:
        """schema に従った JSON を返す。"""

    def close(self) -> None:
        """リソースを解放する。"""
