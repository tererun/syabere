#!/usr/bin/env python3
"""Mac マイク入力をリアルタイムで giziroku に流し込むデモ。

使い方:
    python demo_mic.py                          # 文字起こしのみ (ja)
    python demo_mic.py --diarize                # 話者分離あり
    python demo_mic.py --language auto
    python demo_mic.py --device 2               # 入力デバイス指定 (--list で番号確認)
    python demo_mic.py --list                   # 利用可能な入力デバイスを表示して終了

プロトコル:
  16bit / mono / 16kHz の PCM を WS にバイナリで送り、サーバから JSON が返る。
  Ctrl+C で終了 (flush を送ってからクローズ)。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys

import numpy as np
import sounddevice as sd
import websockets

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_SECONDS = 0.5  # マイクから取り込む単位 (短めにして低遅延に)


def list_devices() -> None:
    print(sd.query_devices())


async def run(ws_url: str, device: int | None) -> None:
    loop = asyncio.get_running_loop()
    pcm_queue: asyncio.Queue[bytes] = asyncio.Queue()
    stop_event = asyncio.Event()

    def callback(indata, frames, time_info, status):
        if status:
            print(f"[mic] {status}", file=sys.stderr)
        # indata is float32 mono; convert to s16le bytes
        pcm = (np.clip(indata[:, 0], -1.0, 1.0) * 32767).astype(np.int16).tobytes()
        loop.call_soon_threadsafe(pcm_queue.put_nowait, pcm)

    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="float32",
        blocksize=int(SAMPLE_RATE * BLOCK_SECONDS),
        device=device,
        callback=callback,
    )

    def handle_sigint():
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, handle_sigint)
        except NotImplementedError:
            pass

    print(f"connecting to {ws_url} ...", file=sys.stderr)
    async with websockets.connect(ws_url, max_size=None) as ws:
        print("recording. Ctrl+C to stop.", file=sys.stderr)
        stream.start()

        async def sender():
            while not stop_event.is_set():
                try:
                    chunk = await asyncio.wait_for(pcm_queue.get(), timeout=0.2)
                except asyncio.TimeoutError:
                    continue
                await ws.send(chunk)
            await ws.send("flush")

        async def receiver():
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    print(raw, file=sys.stderr)
                    continue
                if msg.get("type") == "final":
                    print("\n[final]", file=sys.stderr)
                    stop_event.set()
                    return
                if msg.get("type") == "silence":
                    continue
                offset = msg.get("offset", 0.0)
                segments = msg.get("segments", [])
                if not segments:
                    continue
                for seg in segments:
                    s = seg["start"]
                    e = seg["end"]
                    text = seg["text"].strip()
                    if "speaker" in seg:
                        print(f"[{s:7.2f}-{e:7.2f}] {seg['speaker']:>12}: {text}")
                    else:
                        print(f"[{s:7.2f}-{e:7.2f}] {text}")

        try:
            await asyncio.gather(sender(), receiver())
        finally:
            stream.stop()
            stream.close()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--api", default="ws://localhost:8000", help="giziroku WS base URL")
    p.add_argument("--key", default="change-me-please")
    p.add_argument("--language", default="ja", help="ja / en / ... / auto")
    p.add_argument("--initial-prompt", default=None, help="固有名詞の補正ヒント")
    p.add_argument("--diarize", action="store_true")
    p.add_argument("--device", type=int, default=None, help="入力デバイス番号 (sounddevice)")
    p.add_argument("--list", action="store_true", help="入力デバイス一覧を表示")
    args = p.parse_args()

    if args.list:
        list_devices()
        return 0

    from urllib.parse import urlencode
    path = "stream/transcribe-diarize" if args.diarize else "stream/transcribe"
    params = {"api_key": args.key, "language": args.language}
    if args.initial_prompt:
        params["initial_prompt"] = args.initial_prompt
    ws_url = f"{args.api}/{path}?{urlencode(params)}"

    try:
        asyncio.run(run(ws_url, args.device))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
