// 契約テスト（キーレスWIF P2）：mintSaTokenWif の4ホップを検証（ネットワークはモック）。
// aud0(scheme有)・STS audience(`//`形式)・signJwt payload(DWDクレーム)・exp上限・ホップ順を確認。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintSaTokenWif, type WifConfig } from "../src/lib/google-sa.ts";

const decodeJwtPayload = (jwt: string) => {
  const seg = jwt.split(".")[1];
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((seg.length + 3) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
};

const CFG: WifConfig = {
  sa_email: "bot@proj.iam.gserviceaccount.com",
  client_id: "123456789",
  project_number: "987654321",
  pool: "baku-pool",
  provider: "baku-prov",
  issuer: "https://tenant.example.workers.dev",
};

// fetch をモックし、各ホップの URL・body を捕捉する。signOidc は引数のクレームをそのまま JWT 風に符号化。
function harness() {
  const calls: { url: string; body: Record<string, string>; headers: Record<string, string>; json?: unknown }[] = [];
  const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const signOidc = async (claims: Record<string, unknown>) => `h.${b64url(JSON.stringify(claims))}.sig`;
  const fetchMock = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const rec: (typeof calls)[number] = { url, body: {}, headers };
    if (typeof init.body === "string" && headers["content-type"]?.includes("json")) rec.json = JSON.parse(init.body);
    else rec.body = Object.fromEntries(new URLSearchParams(init.body as string));
    calls.push(rec);
    if (url.startsWith("https://sts.googleapis.com")) return new Response(JSON.stringify({ access_token: "FED_TOKEN" }), { status: 200 });
    if (url.includes(":signJwt")) return new Response(JSON.stringify({ signedJwt: "SIGNED_DWD_JWT" }), { status: 200 });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "USER_TOKEN", expires_in: 3600 }), { status: 200 });
    return new Response("unexpected", { status: 500 });
  };
  return { calls, signOidc, fetchMock };
}

test("mintSaTokenWif：4ホップが正しい順・形式で呼ばれ、対象ユーザーのトークンを返す", async () => {
  const { calls, signOidc, fetchMock } = harness();
  const orig = globalThis.fetch;
  globalThis.fetch = fetchMock as never;
  try {
    const res = await mintSaTokenWif(CFG, "user@tenant.co.jp", "https://www.googleapis.com/auth/calendar.events", signOidc);
    assert.equal(res.ok, true);
    assert.equal(res.token, "USER_TOKEN");
    assert.equal(res.expiresIn, 3600);
  } finally {
    globalThis.fetch = orig;
  }

  // ホップ順：STS → signJwt → DWD token
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.startsWith("https://sts.googleapis.com"), "1番目はSTS");
  assert.ok(calls[1].url.includes(":signJwt"), "2番目はsignJwt");
  assert.ok(calls[2].url.startsWith("https://oauth2.googleapis.com/token"), "3番目はDWDトークン");

  const providerRes = "projects/987654321/locations/global/workloadIdentityPools/baku-pool/providers/baku-prov";

  // ホップ0（STSに渡す subject_token）：aud は **スキーム有り**、sub=baku-office、exp-iat≤300。
  const oidc = decodeJwtPayload(calls[0].body.subject_token);
  assert.equal(oidc.aud, `https://iam.googleapis.com/${providerRes}`, "OIDC aud はスキーム有り");
  assert.equal(oidc.iss, CFG.issuer);
  assert.equal(oidc.sub, "baku-office");
  assert.ok(oidc.exp - oidc.iat <= 300, "OIDC JWT は短命（≤5分）");

  // ホップ1（STS body）：audience は **先頭`//`・スキーム無し**（最頻バグ）。subject_token_type=id_token。
  assert.equal(calls[0].body.audience, `//iam.googleapis.com/${providerRes}`, "STS audience は //（スキーム無し）");
  assert.equal(calls[0].body.grant_type, "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(calls[0].body.subject_token_type, "urn:ietf:params:oauth:token-type:id_token");
  assert.equal(calls[0].body.scope, "https://www.googleapis.com/auth/cloud-platform");

  // ホップ2（signJwt）：Bearer=フェデレーショントークン、payload は DWD クレーム（aud=oauth2 token・exp≤iat+3600）。
  assert.equal(calls[1].headers.authorization, "Bearer FED_TOKEN");
  assert.ok(calls[1].url.includes(encodeURIComponent(CFG.sa_email)), "signJwt URL に SA email");
  const payload = JSON.parse((calls[1].json as { payload: string }).payload);
  assert.equal(payload.iss, CFG.sa_email);
  assert.equal(payload.sub, "user@tenant.co.jp");
  assert.equal(payload.aud, "https://oauth2.googleapis.com/token");
  assert.equal(payload.scope, "https://www.googleapis.com/auth/calendar.events");
  assert.ok(payload.exp - payload.iat <= 3600, "DWDクレーム exp≤iat+3600");

  // ホップ3（DWDトークン）：grant_type=jwt-bearer、assertion=signJwt の signedJwt。
  assert.equal(calls[2].body.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(calls[2].body.assertion, "SIGNED_DWD_JWT");
});

test("mintSaTokenWif：STS 失敗時はエラーを返し後続ホップを呼ばない", async () => {
  const { signOidc } = harness();
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://sts.googleapis.com")) return new Response("denied", { status: 403 });
    return new Response("{}", { status: 200 });
  }) as never;
  try {
    const res = await mintSaTokenWif(CFG, "user@tenant.co.jp", "scope", signOidc);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /STS/);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls.length, 1, "STS失敗で打ち切り（signJwt/DWDは呼ばない）");
});

test("mintSaTokenWif：設定不足は即エラー（ネットワークを叩かない）", async () => {
  const { signOidc } = harness();
  const res = await mintSaTokenWif({ ...CFG, project_number: "" }, "u@x", "scope", signOidc);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /不足/);
});
