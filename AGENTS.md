# syabere — Discord 会議録 Bot

Discord ボイスチャンネル内の発話をユーザーごとに分離して文字起こしし、同じ VC 内のテキストチャットも併せて Google ドキュメントに追記する Bot。`/stop` 時に Gemini で要約をドキュメント先頭に prepend する。

## 構成

```
Discord VC (per-user opus)
  → @discordjs/voice receiver.subscribe(userId)
  → OggOpusMuxer (自前, pure JS)   [src/ogg-opus.ts]
  → prism-media FFmpeg (ffmpeg-static)
  → 16 kHz mono s16le PCM
  → giziroku /stream/transcribe (per-user WebSocket)    [src/giziroku.ts]
  → Meeting.addUtterance                                [src/meeting.ts]
  → MeetingDoc (Google Docs API, 10s 間隔 batchUpdate)  [src/docs.ts]
  → /stop: Gemini 2.5 Flash 要約を index=1 に prepend   [src/gemini.ts]
```

- Discord 側で既にユーザーごとにストリームが分かれているので、giziroku 側は話者分離 **なし** (`/stream/transcribe`) を使用している。話者分離 AI は使わない。
- Google Docs は呼び出したユーザー個人の Drive に作成される（所有者はそのユーザー）。サービスアカウントは使わない。

## ランタイム

- **Bun** 1.2.x（Node 互換レイヤ + Bun.serve）
- TypeScript（strict、`moduleResolution: bundler`、`verbatimModuleSyntax`）
- `bun run start` — 起動＋ slash コマンド登録を自動
- `bun run dev` — watch モード
- `bun run typecheck` — tsc --noEmit

## ファイル責務

| ファイル | 責務 |
|---|---|
| `src/index.ts` | Discord client、slash コマンドハンドラ、OAuth server 起動、SIGINT/SIGTERM |
| `src/commands.ts` | slash コマンド定義（`/login` `/logout` `/start` `/stop` `/folder`） |
| `src/config.ts` | 環境変数の読み込み・検証。`TOKEN_ENCRYPTION_KEY` は 32 bytes base64 必須 |
| `src/meeting.ts` | 1 会議のオーケストレータ。voice + テキストチャット取り込み → 要約までの一連 |
| `src/voice.ts` | `VoiceBridge`。ユーザーごとに opus → OGG → ffmpeg → giziroku を張る |
| `src/ogg-opus.ts` | 自前の Ogg Opus muxer（後述の制約のため prism-media のは使わない） |
| `src/ogg-crc.ts` | OGG の CRC32 (RFC 3533) 純 JS 実装。libogg の crc_table と一致を検証済 |
| `src/giziroku.ts` | giziroku `/stream/transcribe` WebSocket クライアント。open 前の send をバッファ、flush → final 待ち → close |
| `src/docs.ts` | 1 会議分の Docs 書き込み。10s 間隔の buffered `insertText` flush、finalize で index=1 に要約 prepend、オプションで Drive フォルダへ移動 |
| `src/gemini.ts` | Gemini 2.5 Flash による要約生成 |
| `src/oauth.ts` | OAuth2 URL 発行、state 照合（`timingSafeEqual`）、トークン交換、`getUserAuth` で自動 refresh 対応の client 生成 |
| `src/oauth-server.ts` | `Bun.serve` で `/oauth/callback` のみ受ける。既定 127.0.0.1 bind |
| `src/token-store.ts` | AES-256-GCM で refresh_token を暗号化してファイル永続化。AAD = Discord userId |
| `src/crypto.ts` | AES-GCM の seal/open、`safeEqual` |
| `src/drive-folder.ts` | Drive 共有 URL/raw ID のパーサ |

## Slash コマンド

| コマンド | 動作 |
|---|---|
| `/login` | Google OAuth URL を ephemeral で返信。state は 256 bit 乱数、TTL 10 分、一回限り |
| `/logout` | Google 側で refresh_token を revoke → ローカルから削除 |
| `/start` | 呼び出したユーザー自身の VC に参加、本人の Drive に Doc 作成、giziroku へストリーミング |
| `/stop` | Meeting を終了、Gemini 要約を追加、Doc URL を返信。**開始したユーザーのみ停止可** |
| `/folder set url:<URL or ID>` | 保存先 Drive フォルダをユーザー単位で設定 |
| `/folder show` | 個人設定 / サーバー既定 / 実効フォルダを表示 |
| `/folder clear` | 個人設定をクリア |

保存先の優先順位: **ユーザー個人設定 > `GOOGLE_DOCS_FOLDER_ID` > Drive ルート**。

## 環境変数

`.env.example` が真実。主要項目のみ:

- `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` — Bot 基本
- `DISCORD_GUILD_ID` — 設定するとそのギルド限定でコマンド登録（開発用）、未設定でグローバル
- `GIZIROKU_WS_URL` / `GIZIROKU_API_KEY` / `GIZIROKU_LANGUAGE` / `GIZIROKU_INITIAL_PROMPT`
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI`
- `OAUTH_SERVER_HOST` (既定 127.0.0.1) / `OAUTH_SERVER_PORT` (既定 3000)
- `TOKEN_STORE_PATH` (既定 `./.data/google-tokens.json`)
- **`TOKEN_ENCRYPTION_KEY`** — 32 bytes base64、必須。生成: `bun -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- `DOCS_FLUSH_INTERVAL_MS` (既定 10000)
- `GOOGLE_DOCS_FOLDER_ID` — サーバー全体の保存先デフォルト（オプション）
- `GEMINI_API_KEY` / `GEMINI_MODEL` (既定 `gemini-2.5-flash`)
- `GIZIROKU_DEBUG=1` — デバッグ用、giziroku から返る全メッセージを stdout に流す

## Discord 側セットアップ

### Privileged Gateway Intents（Developer Portal）

- **Message Content Intent: ON（必須）** — VC テキストチャットの `message.content` を読むため
- Server Members Intent: OFF（`members.fetch()` は REST で動くので不要）
- Presence Intent: OFF

### Bot 権限（招待 URL の permissions）

最小構成: **チャンネルを表示 / メッセージを送る / 接続 / 発言** の 4 つだけでよい。integer: `3147776`。

### OAuth スコープ（招待）

- `bot`
- `applications.commands`

## Google Cloud 側セットアップ

1. OAuth Client を **Web application** 種別で作成し、redirect URI を `GOOGLE_OAUTH_REDIRECT_URI` と完全一致させる
2. 同プロジェクトで **Google Docs API** と **Google Drive API** を有効化
3. OAuth consent screen の Scopes に以下を追加:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/drive.file`（ユーザーの既存 Drive には触らない）
4. 本番運用では external user type で verification を受けるか、test users に対象 Discord 利用者の Google アカウントを追加

## セキュリティ設計

- refresh_token は **AES-256-GCM** で at-rest 暗号化。AAD に Discord userId を bind しているので store 内の record swap は復号時点で弾く
- token ファイル `0600`、親ディレクトリ `0700`、temp file + rename で atomic 書き込み
- `.data/` は `.gitignore` 済
- OAuth scopes は **`documents`** + **`drive.file`** + `openid`/`email` のみ。`drive.file` は本アプリが作成したファイルのみ触れる = ユーザーの既存 Drive は不可視
- `/login` の OAuth URL 返信は ephemeral。state は `randomBytes(32)` hex、TTL 10 分、one-shot、`timingSafeEqual` で照合
- OAuth callback server は既定 `127.0.0.1` bind、`/oauth/callback` 以外は 404、エラー文言に code/state/token を反射しない、`X-Frame-Options: DENY` など defensive header
- callback 成功画面に紐付いた Google email を表示 → 意図しないアカウント連携の検知
- `/stop` は **開始したユーザーのみ** 停止可

## マルチギルド対応

- `meetings: Map<guildId, Meeting>` で 1 ギルド 1 会議、複数ギルド同時 OK
- `joinVoiceChannel({ guildId, channelId })` と `receiver.subscribe(userId)` はコネクション単位
- `messageCreate` ハンドラは `m.channelId !== voiceChannel.id` で厳格フィルタ
- OAuth トークンは Discord userId 単位（guild 非依存）、一度 `/login` すれば全ギルドで有効

## Bun 固有の罠と設計判断（重要）

このプロジェクトの opus デコード経路は **何度も踏み直した** ので、以下の前提はそのまま維持すること。

1. **`@discordjs/opus`（native）** — Bun の Node ABI (v127) に対応する prebuild が無く、node-gyp ビルドも安定しない。使わない。
2. **`opusscript`（pure JS）** — Discord の特定 Opus パケットで C アサーション abort (`endband` 関連)。使わない。
3. **`opus-decoder`（WASM）** — 内部の `simple-yenc` が Bun の文字列処理で WASM バイナリの CRC32 検証に失敗する。使わない。
4. **`prism-media` v2 alpha の `OggLogicalBitstream`** — `node-crc` を lazy require するが、node-crc は napi-rs 製で Rust toolchain が必要。加えて opus 特化サブクラスが **ctor 内で即座に header pages を書き出す** ため、サブクラスで `calculateCRC` を上書きしても OpusHead/OpusTags ページの CRC が 0 のままになる。使わない。
5. **`prism-media` の `FFmpeg` クラス** — spawn 時に **最後の引数として常に `pipe:1` を自動付与**する。自分で `pipe:1` を書くと 2 重になり `Unable to find a suitable output format for 'pipe:1'` エラー。args の末尾に `pipe:1` を書かないこと。
6. **`ffmpeg` の出力 codec** — `-f s16le` だけでは ffmpeg 6.0 が出力 codec を推定できずエラー。**`-c:a pcm_s16le` も明示する**。
7. **低レイテンシ ffmpeg flag** — 短いバーストで stdout が遅延しないように `-fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0 -flush_packets 1` を付ける。
8. **OggOpusMuxer の maxPacketsPerPage** — 1 に設定。10 など大きい値にすると ffmpeg に届くまで 200 ms 遅延が入り、giziroku に渡るタイミングが悪化する。

したがって現構成は:

- **自前の `OggOpusMuxer`**（`src/ogg-opus.ts`）で raw Opus → OGG Opus にカプセル化
- **自前の OGG CRC32**（`src/ogg-crc.ts`）を使用（libogg 互換を test vector で検証済）
- **ffmpeg-static** 同梱の ffmpeg で OGG → 16 kHz mono s16le PCM にデコード
- この経路は M1 macOS と Intel Ubuntu の両方で動く

この判断は将来 Bun / opus ライブラリの状況が変わるまでは動かさない。動かすなら上記 8 項目すべてに対する代替解を持ってからにすること。

## giziroku 側のチャンク境界

giziroku `/stream/transcribe` は `STREAM_CHUNK_SECONDS`（既定 5s）で区切って Whisper に渡す。そのため:

- voice session は `EndBehaviorType.Manual` で 1 ユーザー = 1 giziroku WS を会議中ずっと維持する。以前は `AfterSilence` で 2.5s 無音ごとに session を閉じていたが、閉じ切るまでの間に来た発話が `speaking.on("start")` の早期 return で丸ごと捨てられていた（Docs に前半が出ない原因）。Manual にしたので `/stop` の `bridge.shutdown()` で opus stream を `destroy()` → pipeline 'end' → `giziroku.flushAndClose` の順で閉じる
- チャンク境界で単語/文が切れるのは Whisper streaming の性質。完全な文境界が必要なら POST `/transcribe` のファイルモードに切り替える必要がある
- `initial_prompt` に固有名詞を並べると精度が上がる（`GIZIROKU_INITIAL_PROMPT`）

## Docs 書き込みレート

- `DOCS_FLUSH_INTERVAL_MS`（既定 10s）で buffered flush → ~6 req/min/user
- Google Docs の write quota（~60 req/min/user）に対して十分余裕
- flush に失敗した場合は buffer に差し戻して次回リトライ

## 既知の未解決項目

- Gemini の billing 枯渇で 429 → 要約が `(要約の生成に失敗しました)` になる。本体の voice パイプラインには影響しない
- Opus packet の code > 0（複数フレーム /packet）時、granule position の計算が 1 frame 分しか進まない。Discord は常に code=0 なので実害は出ていないが、他用途に転用する場合は `src/ogg-opus.ts` の `samplesPerFrame48k` を拡張する必要がある

## デプロイ先

- 開発: M1 Mac
- 予定: Intel Ubuntu（`ffmpeg-static` が x86_64 Linux バイナリを配布しているので OS 側の追加インストール不要）
