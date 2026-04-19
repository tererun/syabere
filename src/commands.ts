import { InteractionContextType, SlashCommandBuilder } from "discord.js";

const guildOnly = [InteractionContextType.Guild];

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("login")
    .setDescription("Google アカウントと連携します（議事録の保存先 Drive を紐付け）")
    .setContexts(guildOnly),
  new SlashCommandBuilder()
    .setName("logout")
    .setDescription("Google アカウントの連携を解除します")
    .setContexts(guildOnly),
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("参加中のボイスチャンネルで議事録を開始します")
    .setContexts(guildOnly),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("議事録を終了し、Gemini の要約をドキュメントに追記します")
    .setContexts(guildOnly),
  new SlashCommandBuilder()
    .setName("folder")
    .setDescription("議事録の保存先 Drive フォルダを管理します")
    .setContexts(guildOnly)
    .addSubcommand((sc) =>
      sc
        .setName("set")
        .setDescription("保存先フォルダを設定します")
        .addStringOption((o) =>
          o
            .setName("url")
            .setDescription("Drive のフォルダ共有リンクまたは ID")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName("show").setDescription("現在の保存先を表示します"),
    )
    .addSubcommand((sc) =>
      sc
        .setName("clear")
        .setDescription("保存先をクリアします（Drive のルートに保存）"),
    ),
].map((c) => c.toJSON());
