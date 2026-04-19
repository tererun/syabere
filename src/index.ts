import {
  Client,
  Events,
  GatewayIntentBits,
  ChannelType,
  MessageFlags,
} from "discord.js";
import type { Interaction, VoiceBasedChannel } from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { commandDefinitions } from "./commands.ts";
import { config } from "./config.ts";
import { Meeting } from "./meeting.ts";
import { buildAuthUrl, getUserAuth, revokeUser } from "./oauth.ts";
import { startOAuthServer } from "./oauth-server.ts";
import { getTokens, setFolderId } from "./token-store.ts";
import { parseFolderInput } from "./drive-folder.ts";
import {
  brandEmbed,
  errorEmbed,
  infoEmbed,
  successEmbed,
  warningEmbed,
} from "./embeds.ts";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

/**
 * Active meetings, keyed by guildId. The map scopes one meeting per guild
 * which means this bot can serve many guilds concurrently — each with its
 * own voice connection, WS streams, and (now) the starter's own Google Doc.
 */
const meetings = new Map<string, Meeting>();

client.once(Events.ClientReady, async (c) => {
  console.log(`[discord] logged in as ${c.user.tag}`);
  try {
    // Idempotent: Discord accepts the same payload and returns the existing
    // commands unchanged when nothing has diverged.
    if (config.discord.guildId) {
      const guild = await c.guilds.fetch(config.discord.guildId);
      await guild.commands.set(commandDefinitions);
      console.log(`[discord] registered ${commandDefinitions.length} command(s) to guild ${guild.id}`);
    } else {
      await c.application.commands.set(commandDefinitions);
      console.log(`[discord] registered ${commandDefinitions.length} global command(s)`);
    }
  } catch (err) {
    console.error("[discord] failed to register commands:", err);
  }
});

client.on(Events.InteractionCreate, async (ix: Interaction) => {
  if (!ix.isChatInputCommand() || !ix.guild) return;

  try {
    switch (ix.commandName) {
      case "login":
        return void (await cmdLogin(ix));
      case "logout":
        return void (await cmdLogout(ix));
      case "start":
        return void (await cmdStart(ix));
      case "stop":
        return void (await cmdStop(ix));
      case "folder":
        return void (await cmdFolder(ix));
    }
  } catch (err) {
    console.error(`[command ${ix.commandName}] unhandled:`, err);
    const embed = errorEmbed(
      "⚠ コマンドの処理に失敗しました",
      "ログを確認してください。",
    );
    if (ix.deferred || ix.replied) {
      await ix.editReply({ embeds: [embed] }).catch(() => undefined);
    } else {
      await ix
        .reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }
});

async function cmdLogin(ix: import("discord.js").ChatInputCommandInteraction) {
  const url = buildAuthUrl(ix.user.id);
  // Ephemeral: only the invoking user sees this URL. State is single-use and
  // expires in 10 minutes.
  const embed = infoEmbed(
    "🔗 Google アカウントを連携",
    `[こちらのリンクから認可してください](${url})`,
  ).addFields(
    { name: "有効期限", value: "10 分（一回限り）", inline: true },
    { name: "表示範囲", value: "あなたのみ", inline: true },
    {
      name: "許可される権限",
      value:
        "・Google ドキュメントの作成・編集\n・**このボットが作成したファイルのみ** の Drive 操作",
    },
  );
  await ix.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function cmdLogout(ix: import("discord.js").ChatInputCommandInteraction) {
  await ix.deferReply({ flags: MessageFlags.Ephemeral });
  const removed = await revokeUser(ix.user.id);
  const embed = removed
    ? successEmbed(
        "✓ 連携を解除しました",
        "Google 側で refresh_token を revoke し、ローカルの資格情報を削除しました。",
      )
    : infoEmbed(
        "連携情報は見つかりませんでした",
        "すでに解除済み、または未連携です。",
      );
  await ix.editReply({ embeds: [embed] });
}

async function cmdStart(ix: import("discord.js").ChatInputCommandInteraction) {
  if (!ix.guild) return;

  if (meetings.has(ix.guild.id)) {
    await ix.reply({
      embeds: [
        warningEmbed(
          "すでに記録中です",
          "このサーバーの議事録は進行中です。終了するには `/stop` を実行してください。",
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const auth = await getUserAuth(ix.user.id);
  if (!auth) {
    await ix.reply({
      embeds: [
        warningEmbed(
          "Google アカウントが未連携です",
          "先に `/login` を実行してアカウントを連携してください。",
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await ix.guild.members.fetch(ix.user.id);
  const vc = member.voice.channel as VoiceBasedChannel | null;
  if (!vc || vc.type !== ChannelType.GuildVoice) {
    await ix.reply({
      embeds: [
        warningEmbed(
          "ボイスチャンネルに参加してください",
          "議事録を開始するには、あなた自身がボイスチャンネルに入っている必要があります。",
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Reply ephemerally — the doc URL is personal to the starter's Drive.
  await ix.deferReply({ flags: MessageFlags.Ephemeral });

  const connection = joinVoiceChannel({
    channelId: vc.id,
    guildId: ix.guild.id,
    adapterCreator: ix.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error("[voice] failed to enter ready state:", err);
    try { connection.destroy(); } catch {}
    await ix.editReply({
      embeds: [
        errorEmbed(
          "ボイスチャンネルへの接続に失敗しました",
          "時間をおいて再度お試しください。",
        ),
      ],
    });
    return;
  }

  const tokens = await getTokens(ix.user.id);
  const folderId = tokens?.folderId ?? config.docs.defaultFolderId ?? null;
  const meeting = new Meeting(
    ix.guild,
    vc,
    connection,
    ix.user.id,
    auth.client,
    folderId,
  );
  meetings.set(ix.guild.id, meeting);

  try {
    const url = await meeting.start();
    const embed = successEmbed(
      "🎙 議事録の記録を開始しました",
      `[ドキュメントを開く](${url})`,
    ).addFields(
      { name: "チャンネル", value: vc.name, inline: true },
      {
        name: "保存先",
        value: folderId ? `\`${folderId}\`` : "Drive のルート",
        inline: true,
      },
    );
    if (auth.email) {
      embed.addFields({ name: "アカウント", value: auth.email, inline: true });
    }
    await ix.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("[meeting] start failed:", err);
    meetings.delete(ix.guild.id);
    try { connection.destroy(); } catch {}
    await ix.editReply({
      embeds: [
        errorEmbed(
          "議事録の初期化に失敗しました",
          "Google アカウントの権限や API の有効化状況を確認してください。",
        ),
      ],
    });
  }
}

async function cmdFolder(ix: import("discord.js").ChatInputCommandInteraction) {
  const sub = ix.options.getSubcommand();
  const tokens = await getTokens(ix.user.id);
  if (!tokens) {
    await ix.reply({
      embeds: [
        warningEmbed(
          "Google アカウントが未連携です",
          "先に `/login` を実行してアカウントを連携してください。",
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "show") {
    const configured = tokens.folderId;
    const fallback = config.docs.defaultFolderId;
    const effective = configured ?? fallback ?? null;
    const embed = brandEmbed(
      "📁 保存先フォルダ",
      "`/start` で作成される議事録ドキュメントの保存先です。",
    ).addFields(
      {
        name: "あなたの設定",
        value: configured ? `\`${configured}\`` : "未設定",
      },
      {
        name: "サーバー既定値",
        value: fallback ? `\`${fallback}\`` : "なし",
      },
      {
        name: "実効フォルダ",
        value: effective ? `\`${effective}\`` : "なし（Drive のルートに保存）",
      },
    );
    await ix.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === "clear") {
    await setFolderId(ix.user.id, null);
    await ix.reply({
      embeds: [
        successEmbed(
          "✓ 個人設定をクリアしました",
          "以降はサーバー既定値（未設定なら Drive のルート）に保存されます。",
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "set") {
    const input = ix.options.getString("url", true);
    const folderId = parseFolderInput(input);
    if (!folderId) {
      await ix.reply({
        embeds: [
          errorEmbed(
            "フォルダを認識できませんでした",
            "`https://drive.google.com/drive/folders/<id>` 形式のリンク、または raw ID を渡してください。",
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await setFolderId(ix.user.id, folderId);
    await ix.reply({
      embeds: [
        successEmbed(
          "✓ 保存先を設定しました",
          `次回 \`/start\` から有効です。書き込み権限があることを確認してください。`,
        ).addFields({ name: "フォルダ ID", value: `\`${folderId}\`` }),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}

async function cmdStop(ix: import("discord.js").ChatInputCommandInteraction) {
  if (!ix.guild) return;

  const meeting = meetings.get(ix.guild.id);
  if (!meeting) {
    await ix.reply({
      embeds: [
        infoEmbed(
          "議事録は開始されていません",
          "このサーバーには進行中の議事録がありません。",
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Only the user who started the meeting can stop it — prevents a third
  // party from terminating someone else's recording prematurely.
  if (meeting.ownerUserId !== ix.user.id) {
    await ix.reply({
      embeds: [
        warningEmbed(
          "停止できません",
          "この議事録を終了できるのは開始したユーザーのみです。",
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  meetings.delete(ix.guild.id);
  await ix.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { url } = await meeting.stop();
    await ix.editReply({
      embeds: [
        successEmbed(
          "📝 議事録を終了しました",
          `要約をドキュメントの先頭に追記しました。\n[ドキュメントを開く](${url})`,
        ),
      ],
    });
  } catch (err) {
    console.error("[meeting] stop failed:", err);
    await ix.editReply({
      embeds: [
        errorEmbed(
          "終了処理中にエラーが発生しました",
          "ログを確認してください。",
        ),
      ],
    });
  }
}

const shutdown = async (signal: string) => {
  console.log(`[system] received ${signal}, stopping meetings...`);
  const all = [...meetings.values()];
  meetings.clear();
  await Promise.allSettled(all.map((m) => m.stop()));
  await client.destroy();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

startOAuthServer();
await client.login(config.discord.token);
