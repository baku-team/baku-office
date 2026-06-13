// クラウドのKV書き込み回数を自前で日次カウントする。
// WHY: Cloudflare は実行時にKV書込回数を出さない（Analytics APIは非移植・要トークン）ため、
// 全書込を本ヘルパに通して自前集計し、無料枠（1名前空間あたり1日1000書込・UTC0時リセット）への
// 接近を「使用量」画面で可視化する（§使用量画面・運用クォータ）。
// 計測は op_usage（D1）へ。AI使用量(api_usage)とは別テーブル＝AIの集計を汚さない。
// 計測自体はD1書込でありKV枠を消費しない（測ることで測定対象を消費しない）。

export const KV_WRITE_FREE_LIMIT = 1000; // 無料枠：1名前空間あたり1日

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

// 本日のKV書き込み回数を +n する。失敗は無視（計測のために本処理を止めない）。
export async function recordKvWrite(env: Env, n = 1): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO op_usage (op, day, count) VALUES ('kv_write', ?, ?) ON CONFLICT(op, day) DO UPDATE SET count = count + excluded.count",
    ).bind(todayUtc(), n).run();
  } catch { /* 計測失敗は無視（上限はあくまで概算表示） */ }
}

// 本日のKV書き込み回数を取得。テーブル未作成時等は 0。
export async function kvWritesToday(env: Env): Promise<number> {
  try {
    const r = await env.DB
      .prepare("SELECT count FROM op_usage WHERE op='kv_write' AND day=?")
      .bind(todayUtc())
      .first<{ count: number }>();
    return r?.count ?? 0;
  } catch { return 0; }
}

// KV書き込みの中央ヘルパ。env.LICENSE.put を行いつつ書込回数を計測する。
// 全書込をここに集約することで、自前カウントの取りこぼしを防ぐ。
export async function kvPut(
  env: Env,
  key: string,
  value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
  options?: KVNamespacePutOptions,
): Promise<void> {
  const p = env.LICENSE.put(key, value as never, options);
  await recordKvWrite(env);
  return p;
}
