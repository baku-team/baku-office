// 環境Profile の検出（移植性アーキ §6）。
// 完全な Profile A/B/C 切替（D1↔SQLite・Workers↔Node）は deploy 時の構成選択だが、
// 1つの Workers バイナリ内でも実行時に選べる軸（AI=cloud/local・storage=r2/kv・鍵=secret/kv）を可視化する。
export type ProfileInfo = {
  id: "A" | "C";        // A=フルクラウド寄り / C=オフライン寄り（ローカルLLM）
  label: string;
  ai: "cloud" | "local";
  storage: "r2" | "kv";
  keyStore: "secret" | "kv-autogen" | "missing-prod";
};

export function detectProfile(env: Env): ProfileInfo {
  const ai: ProfileInfo["ai"] = env.LOCAL_AI_BASE_URL ? "local" : "cloud";
  const storage: ProfileInfo["storage"] = env.MEDIA_R2 ? "r2" : "kv";
  // 本番(ENVIRONMENT=production)でsecret未投入は暗号処理ブロック中＝"missing-prod"（§10.1）。
  const keyStore: ProfileInfo["keyStore"] = env.MASTER_KEY
    ? "secret"
    : env.ENVIRONMENT === "production"
      ? "missing-prod"
      : "kv-autogen";
  const id: ProfileInfo["id"] = ai === "local" ? "C" : "A";
  const label = id === "C" ? "C: オフライン寄り（ローカルLLM）" : "A: フルクラウド";
  return { id, label, ai, storage, keyStore };
}
