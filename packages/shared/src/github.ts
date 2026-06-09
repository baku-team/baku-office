// 団体ごと公開リポの自動生成（throwaway）／削除（deploy仕様§2.2-2.3）。
// ホスト/申込の両Workerから使うため env 非依存。トークン等は呼び出し側が明示的に渡す。
// 焼き込むのは licenseId 本体ではなく使い捨て deploy_code（nonce）のみ（公開露出の最小化）。

export type GithubOpts = {
  token: string;        // baku-team org の repo 作成（Administration:write）＋Contents:write
  owner: string;        // 例 "baku-team"
  templateRepo: string; // 例 "baku-office-app"（Template repository 化済み）
  hostBaseUrl: string;  // report.json に焼く当社ホストURL
};

const GH = "https://api.github.com";
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "baku-office-provisioner",
  "X-GitHub-Api-Version": "2022-11-28",
  "content-type": "application/json",
});

// テンプレートから団体専用リポを生成し report.json（code/host）を焼き込む。戻り値 "owner/app-<id>"。
export async function provisionRepo(opts: GithubOpts, licenseId: string, code: string): Promise<string> {
  const { owner, templateRepo } = opts;
  const name = "app-" + licenseId;
  const gen = await fetch(`${GH}/repos/${owner}/${templateRepo}/generate`, {
    method: "POST",
    headers: headers(opts.token),
    body: JSON.stringify({ owner, name, private: false, description: "baku-office (auto)" }),
  });
  if (!gen.ok) throw new Error("generate " + gen.status);

  // /generate は非同期：201 直後にテンプレート本体（Initial commit）が後から push され、
  // 先に書いた report.json を上書き消去してしまう。展開完了（既知ファイルが見える）まで待ってから焼く。
  let ready = false;
  for (let i = 0; i < 10; i++) {
    const probe = await fetch(`${GH}/repos/${owner}/${name}/contents/wrangler.jsonc`, { headers: headers(opts.token) });
    if (probe.ok) { ready = true; break; }
    await new Promise((s) => setTimeout(s, 1500));
  }
  if (!ready) throw new Error("template population timeout");

  const content = btoa(unescape(encodeURIComponent(JSON.stringify({ code, host: opts.hostBaseUrl }))));
  for (let i = 0; i < 5; i++) {
    const put = await fetch(`${GH}/repos/${owner}/${name}/contents/report.json`, {
      method: "PUT",
      headers: headers(opts.token),
      body: JSON.stringify({ message: "add report.json", content }),
    });
    if (put.ok) return `${owner}/${name}`;
    await new Promise((s) => setTimeout(s, 1500));
  }
  throw new Error("put report.json failed");
}

// throwaway 削除（deploy_url 受領後／残骸スイープ／解約）。失敗は致命的でないため呼び出し側で握り潰す。
export async function deleteRepo(opts: Pick<GithubOpts, "token" | "owner">, licenseId: string): Promise<void> {
  await fetch(`${GH}/repos/${opts.owner}/app-${licenseId}`, { method: "DELETE", headers: headers(opts.token) });
}

// クライアント報告（エラー/要望）を GitHub Issue として集積する（自己修復の入口）。
// 人間/外部サービスに依存せず、ここに集積された Issue を Claude が巡回・修復する運用。
// 戻り値: 作成された Issue の html_url。失敗時は例外（呼び出し側で握り潰し可）。
export async function createIssue(
  opts: { token: string; owner: string; repo: string },
  issue: { title: string; body: string; labels?: string[] },
): Promise<string> {
  const r = await fetch(`${GH}/repos/${opts.owner}/${opts.repo}/issues`, {
    method: "POST",
    headers: headers(opts.token),
    body: JSON.stringify({ title: issue.title.slice(0, 240), body: issue.body, labels: issue.labels ?? [] }),
  });
  if (!r.ok) throw new Error("createIssue " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
  const j = (await r.json()) as { html_url?: string };
  if (!j.html_url) throw new Error("createIssue: no html_url");
  return j.html_url;
}
