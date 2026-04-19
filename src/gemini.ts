import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.ts";

const client = new GoogleGenerativeAI(config.gemini.apiKey);

const PROMPT_HEADER = `あなたは会議の書記です。以下の Discord ミーティング文字起こしを読み、\
ユーザーごとに「決定事項」「次に行うべきToDo（期限があれば明記）」「実施済みのアクション」\
を箇条書きで要約してください。

出力ルール:
- Markdown で出力する
- ユーザー名は「・@ユーザー名」の形式で表す
- 各ユーザーの下に全角スペース1つ+中点でインデントした箇条書きを並べる
- 期限は元の発言に含まれる場合のみ記載し、「MM/ddまでに〇〇を行う」のように書く
- 発言が空のユーザーや雑談しかないユーザーは含めない
- 「## 要約」などの見出し行は出力しない。本文のみを返す

出力例:
・@田中
　・04/25までに設計書をレビューする
　・実装タスクAを完了済み
・@佐藤
　・次回ミーティングまでに議題を整理する

--- 文字起こし ---
`;

export async function summarize(transcript: string): Promise<string> {
  const model = client.getGenerativeModel({ model: config.gemini.model });
  const result = await model.generateContent(PROMPT_HEADER + transcript);
  return result.response.text().trim();
}
