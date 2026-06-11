// フォールバック付きモデル：主モデル（Gemini/Claude）が通信制限/障害（turn が error を返す）になったら、
// 副モデル（Workers AI）へ自動切替し、最初に事情を一言説明させて一時対応する。
// 一度切り替えたら以降の同一ジョブは副モデルを使い続ける（再失敗を避ける）。
import type { ChatModel } from "../ai.ts";

const NOTE =
  "【システム注記】通常のAI（Gemini/Claude）が一時的に利用できません（混雑または利用制限）。" +
  "そのため軽量AI（Cloudflare Workers AI）が代わりに応答します。回答の冒頭で一言その事情を簡潔に伝えてから、" +
  "できる範囲で手伝ってください。会計登録・検索などのツール操作は一時的に行えない点にも触れてください。";

export function fallbackChatModel(
  primary: ChatModel,
  fallback: ChatModel,
  onSwitch?: (e: { status?: number; message: string }) => void,
): ChatModel {
  let switched = false;
  return {
    name: primary.name + "+fallback",
    async turn(system, history, tools) {
      if (!switched) {
        const res = await primary.turn(system, history, tools);
        if (!res.error) return res;
        switched = true;
        onSwitch?.(res.error);
      }
      return fallback.turn(NOTE + "\n\n" + system, history, tools);
    },
  };
}
