# giziroku API 仕様書

音声ファイル / リアルタイム音声の文字起こしと話者分離を提供する HTTP + WebSocket API。クライアント実装時はこの1ファイルだけ参照すれば足りるように書いている。

- 想定バージョン: giziroku v0.1.x
- ベース URL (例): `http://<host>:8000`
- 文字エンコード: 全エンドポイント UTF-8 / JSON

## 全体像

| 目的 | 方式 | エンドポイント |
|---|---|---|
| ファイル文字起こし (分離なし) | REST (非同期ジョブ) | `POST /transcribe` → `GET /jobs/{id}` |
| ファイル文字起こし (分離あり) | REST (非同期ジョブ) | `POST /transcribe-diarize` → `GET /jobs/{id}` |
| リアルタイム文字起こし (分離なし) | WebSocket | `/stream/transcribe` |
| リアルタイム文字起こし (分離あり) | WebSocket | `/stream/transcribe-diarize` |
| ヘルスチェック | REST | `GET /health` |

GPU は 1 本のロックで直列化される。REST はキュー (FIFO)、WS は割り込み可能だが、GPU 使用中は待たされる設計。

## 認証

- **REST**: HTTP ヘッダ `X-API-Key: <key>`
- **WebSocket**: URL クエリ `?api_key=<key>` または `X-API-Key` ヘッダ

サーバ側で API キーが未設定の場合は認証スキップ (開発モード)。本番では必ず設定される前提で実装すること。

**失敗時:**
- REST: `401 Unauthorized` + `{"detail": "invalid or missing API key"}`
- WS: `accept` せず close code `4401` で切断

## 共通: 言語指定

`language` は次のいずれか:

- ISO 639-1 / faster-whisper のコード (`ja`, `en`, `zh`, `ko`, `fr`, ...)
- `auto` → サーバ側で自動判定
- 省略 → サーバの `DEFAULT_LANGUAGE` (通常 `ja`)

## 共通: initial_prompt

Whisper に固有名詞や文脈のヒントを渡すためのテキスト。**最後の ~224 トークン** しか参照されないので、長大なドキュメントではなく単語リスト程度に留める。

例: `"giziroku, pyannote, faster-whisper, Docker, GTX 1070"`

- 指定なし → サーバの `DEFAULT_INITIAL_PROMPT` (空なら何も付与されない)
- 指定あり → そのリクエストではサーバ側設定より優先

---

# REST エンドポイント

## `POST /transcribe` — 文字起こし (話者分離なし)

音声ファイルをアップロードし、非同期ジョブ ID を受け取る。

### Request

- Content-Type: `multipart/form-data`
- フィールド:

| name | 型 | 必須 | 説明 |
|---|---|---|---|
| `file` | file | ✓ | 音声ファイル。ffmpeg で読める形式なら何でも (wav/mp3/m4a/flac/mp4/ogg 等) |
| `language` | string | | `ja` / `en` / `auto` など |
| `initial_prompt` | string | | 固有名詞ヒント |

### Response (`202 Accepted`)

```json
{
  "job_id": "9f3c2b1a4e5d...",
  "status": "queued",
  "queue_position": 1
}
```

- `queue_position`: 1 から始まる待機番号 (実行中は 0)

### Example

```bash
curl -X POST http://localhost:8000/transcribe \
  -H "X-API-Key: YOUR_KEY" \
  -F "file=@sample.wav" \
  -F "language=ja" \
  -F "initial_prompt=giziroku, pyannote"
```

---

## `POST /transcribe-diarize` — 文字起こし + 話者分離

音声ファイルをアップロードし、話者分離付きのジョブを投入する。

### Request

- Content-Type: `multipart/form-data`
- フィールド:

| name | 型 | 必須 | 説明 |
|---|---|---|---|
| `file` | file | ✓ | 音声ファイル |
| `language` | string | | `ja` / `auto` など |
| `initial_prompt` | string | | 固有名詞ヒント |
| `num_speakers` | int | | 話者数が既知ならこれを指定 (この場合 min/max は無視) |
| `min_speakers` | int | | 話者数下限のヒント |
| `max_speakers` | int | | 話者数上限のヒント |

### Response (`202 Accepted`)

`POST /transcribe` と同じ形式。

### Example

```bash
curl -X POST http://localhost:8000/transcribe-diarize \
  -H "X-API-Key: YOUR_KEY" \
  -F "file=@meeting.m4a" \
  -F "language=ja" \
  -F "min_speakers=2" -F "max_speakers=4"
```

---

## `GET /jobs/{job_id}` — ジョブ状態取得

ジョブの進捗確認。完了時に結果本体を含む。

### Request

- ヘッダ: `X-API-Key: <key>`

### Response (`200 OK`)

共通構造:

```json
{
  "job_id": "9f3c2b1a4e5d...",
  "status": "queued | running | succeeded | failed",
  "queue_position": 0,
  "error": null,
  "result": null
}
```

`status` ごとの具体的なフィールドの状態:

- **`queued`**: `queue_position` に順番。`result` / `error` は `null`
- **`running`**: `queue_position` = 0、`result` / `error` は `null`
- **`succeeded`**: `result` に本体。`error` は `null`
- **`failed`**: `error` にメッセージ文字列。`result` は `null`

### 成功時 `result` の形

**話者分離なし** (`POST /transcribe` 由来):

```json
{
  "language": "ja",
  "language_probability": 0.99,
  "duration": 42.3,
  "text": "こんにちは、今日はよろしくお願いします。...",
  "segments": [
    {"start": 0.00, "end": 3.24, "text": "こんにちは、"},
    {"start": 3.24, "end": 7.10, "text": "今日はよろしくお願いします。"}
  ]
}
```

**話者分離あり** (`POST /transcribe-diarize` 由来):

```json
{
  "language": "ja",
  "duration": 128.5,
  "segments": [
    {"start": 0.00,  "end":  5.20, "speaker": "SPEAKER_00", "text": "はじめまして、田中です。"},
    {"start": 5.50,  "end": 12.80, "speaker": "SPEAKER_01", "text": "こちらこそ、佐藤と申します。"},
    {"start": 13.10, "end": 19.00, "speaker": "SPEAKER_00", "text": "早速ですが本題に入りましょう。"}
  ]
}
```

- 話者ID は `SPEAKER_00`, `SPEAKER_01`, ... の連番
- 同一話者が連続する発話は 1 セグメントにマージ済み
- 実在の人名 (田中, 佐藤) は例示で、実際には匿名IDのみ返す

### 失敗時

```json
{
  "job_id": "9f3c...",
  "status": "failed",
  "queue_position": 0,
  "error": "RuntimeError: ffmpeg failed: ...",
  "result": null
}
```

### 見つからない場合 (`404 Not Found`)

```json
{ "detail": "job not found or expired" }
```

ジョブは完了から `JOB_TTL` 秒 (既定 3600) 経つと削除される。

### ポーリングの目安

- 最初は 2 秒間隔、3 回目以降は 5 秒間隔、上限 60 秒までにバックオフ
- 1 時間経過したらタイムアウトとして扱う
- 24時間スリープしている間にジョブが expire する可能性あり

---

## `GET /health` — ヘルスチェック

認証不要。

### Response (`200 OK`)

```json
{
  "status": "ok",
  "model": "large-v3",
  "device": "cuda",
  "language_default": "ja"
}
```

---

# WebSocket エンドポイント

## `/stream/transcribe` — リアルタイム文字起こし (話者分離なし)

### 接続 URL

```
ws://<host>:8000/stream/transcribe?api_key=<KEY>&language=<LANG>&initial_prompt=<TEXT>
```

- `api_key` は必須 (ヘッダでも可)
- `language` / `initial_prompt` は任意

### クライアント → サーバ

1. **バイナリフレーム** (推奨): 16bit signed little-endian, mono, 16000Hz の**生PCM**
   - WAV ヘッダは付けない
   - サンプル数は任意 (サーバ側で `STREAM_CHUNK_SECONDS` ぶん溜まるまでバッファ)
   - 1秒ぶんなら 16000 サンプル × 2 バイト = 32000 バイト
2. **テキストフレーム** `"flush"` または `"eof"`: 残バッファを強制処理して終了

### サーバ → クライアント (JSON)

サーバは `STREAM_CHUNK_SECONDS` (既定 5 秒) ぶん音声が溜まるたびに以下いずれかを返す。

**(a) 通常 (発話あり):**

```json
{
  "type": "partial",
  "language": "ja",
  "offset": 10.0,
  "text": "こんにちは、今日は",
  "segments": [
    {"start": 10.00, "end": 12.50, "text": "こんにちは、"},
    {"start": 12.50, "end": 14.80, "text": "今日は"}
  ]
}
```

- `offset`: このチャンク開始時点の、ストリーム全体の経過秒数
- `segments[*].start`/`end`: 同じくストリーム頭からの絶対時間

**(b) 無音スキップ:**

```json
{
  "type": "silence",
  "offset": 15.0,
  "duration": 5.0
}
```

RMS が `STREAM_SILENCE_RMS` 未満のチャンクは GPU に投げずこれを返す。クライアントは UI 表示をスキップするだけで OK。

**(c) 終了:**

```json
{ "type": "final" }
```

`flush`/`eof` 受信後、または自然切断時に返り、サーバ側で接続クローズ。

---

## `/stream/transcribe-diarize` — リアルタイム文字起こし + 話者分離

### 接続 URL

```
ws://<host>:8000/stream/transcribe-diarize?api_key=<KEY>&language=<LANG>&initial_prompt=<TEXT>
```

### メッセージプロトコル

送信は `/stream/transcribe` と同一。サーバからのメッセージは以下。

**(a) 通常:**

```json
{
  "type": "partial",
  "language": "ja",
  "offset": 20.0,
  "segments": [
    {"start": 20.00, "end": 23.40, "speaker": "SPEAKER_00", "text": "あれって決まりましたっけ"},
    {"start": 23.60, "end": 25.00, "speaker": "SPEAKER_01", "text": "はい決まりました"}
  ]
}
```

**(b) 無音スキップ** / **(c) 終了**: `/stream/transcribe` と同一。

### ⚠️ 話者IDの注意

pyannote をチャンクごとに呼び直す実装のため、**話者IDはチャンクをまたいで一貫しない**。
チャンクAで `SPEAKER_00` だった人が、チャンクBでは `SPEAKER_01` になることがある。

一貫した話者ラベルが必要なら、リアルタイムではなくファイル経由の `POST /transcribe-diarize` を使うこと。

---

# エラー

| HTTP | 説明 | ボディ |
|---|---|---|
| `401 Unauthorized` | API キー無効/未送信 | `{"detail": "invalid or missing API key"}` |
| `404 Not Found` | `/jobs/{id}` が存在しないか TTL 超過 | `{"detail": "job not found or expired"}` |
| `422 Unprocessable Entity` | form フィールドの型エラー | pydantic 標準形式 |
| `503 Service Unavailable` | キューが満杯 (`MAX_QUEUE_SIZE` 超過) | `{"detail": "queue is full"}` |
| (その他 500 系) | 内部エラー | FastAPI 標準形式 |

**WebSocket エラー:**

| close code | 意味 |
|---|---|
| `1000` | 正常終了 (サーバから `final` 送信後) |
| `1001` / `1006` | クライアント/ネットワーク切断 |
| `4401` | API キー無効 |

ジョブ実行中のエラーは HTTP ではなく `GET /jobs/{id}` で `status=failed` + `error=<message>` として返る。

---

# 音声形式の制約

## REST (ファイルアップロード)

- ffmpeg で読める形式ならほぼ何でも OK (wav, mp3, m4a, flac, ogg, mp4, webm, ...)
- サーバ側で 16kHz mono float32 に正規化してから処理
- サイズ上限は明示的な制限なし (実用上は数百MB程度が目安)

## WebSocket (ストリーミング)

**必須形式:**

| 項目 | 値 |
|---|---|
| エンコード | 16bit signed PCM (little-endian) |
| チャネル数 | 1 (mono) |
| サンプルレート | `STREAM_SAMPLE_RATE` (既定 16000Hz) |
| ヘッダ | **なし** (生サンプルのみ) |

**フロー制御:**

- クライアントは任意のサイズ単位でバイナリフレームを送ってよい
- サーバ側で `STREAM_CHUNK_SECONDS` × `STREAM_SAMPLE_RATE` × 2 バイト ぶん溜まるまでバッファ
- 溜まり次第 GPU で処理 → JSON 1通返す
- 処理中に送られたフレームはバッファに積まれ、次のチャンクに回る

---

# クライアント実装ガイド

## Python (REST)

```python
import time, requests

API = "http://<host>:8000"
KEY = "YOUR_KEY"

def transcribe_file(path: str, diarize: bool = False) -> dict:
    url = f"{API}/{'transcribe-diarize' if diarize else 'transcribe'}"
    with open(path, "rb") as f:
        r = requests.post(url, headers={"X-API-Key": KEY},
                          files={"file": f},
                          data={"language": "ja"})
    r.raise_for_status()
    job_id = r.json()["job_id"]

    delay = 2.0
    while True:
        s = requests.get(f"{API}/jobs/{job_id}", headers={"X-API-Key": KEY}).json()
        if s["status"] == "succeeded":
            return s["result"]
        if s["status"] == "failed":
            raise RuntimeError(s["error"])
        time.sleep(delay)
        delay = min(delay * 1.5, 10.0)
```

## Python (WebSocket)

```python
import asyncio, json, numpy as np, soundfile as sf, websockets

async def stream_file(path: str):
    audio, sr = sf.read(path, dtype="int16")
    assert sr == 16000 and audio.ndim == 1, "16kHz mono required"

    uri = "ws://<host>:8000/stream/transcribe?api_key=YOUR_KEY&language=ja"
    async with websockets.connect(uri, max_size=None) as ws:
        # 1秒ぶんずつ送る
        for i in range(0, len(audio), 16000):
            await ws.send(audio[i:i+16000].tobytes())
        await ws.send("flush")

        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "final":
                break
            if msg["type"] == "silence":
                continue
            for seg in msg["segments"]:
                print(f"[{seg['start']:.2f}] {seg['text']}")
```

## JavaScript (ブラウザ WebSocket)

```javascript
const ws = new WebSocket(
  `ws://<host>:8000/stream/transcribe?api_key=${KEY}&language=ja`
);
ws.binaryType = "arraybuffer";

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "final") return;
  if (msg.type === "silence") return;
  for (const seg of msg.segments) {
    console.log(`[${seg.start.toFixed(2)}] ${seg.text}`);
  }
};

// audioBuffer: Int16Array (16kHz mono PCM)
ws.send(audioBuffer.buffer);
// 終了時
ws.send("flush");
```

ブラウザでマイク入力を流すなら、`AudioContext` + `AudioWorkletNode` で 16kHz にリサンプルし Int16Array に変換する処理が別途必要。

---

# 制約・既知の問題

- **GPU は1リクエスト直列化**: 複数人が同時利用すると待ち時間が積み重なる
- **ジョブ結果は TTL 経過で消える**: 完了後 `JOB_TTL` (既定1時間) までに回収が必要
- **長時間ストリームで状態肥大しない**: サーバは経過時間とチャンクごとの結果を保持しない (クライアント側で蓄積する)
- **リアルタイム話者分離の話者ID不一致**: チャンク跨ぎで同じ人が違うIDになる
- **インメモリキュー**: サーバ再起動でキューとジョブ結果は消失する。長時間の非同期処理はリトライ前提で組むこと
