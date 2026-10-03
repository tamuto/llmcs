# embedding-server

文をベクトルにする HTTP サーバです。sentence-transformers を Docker の中で動かし、
OpenAI と同じ形の `/v1/embeddings` で返します。

依存とモデルの版をコンテナの中に閉じ込め、呼ぶ側からは URL とモデル名だけが見えるように
してあります。GPU のマシンや既製のサーバへ置き換えても、呼ぶ側は変わりません。

読み込むモデルは `models.json` で Hugging Face のコミットに固定しています。返すベクトルは
長さ1にそろえてあり、応答にはどのモデルのどの版で作ったかが入ります。
