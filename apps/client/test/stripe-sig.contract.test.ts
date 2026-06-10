// 適合性テスト（§5）：Stripe 署名検証を shared に一本化（host/client 共通）。正当な署名で true、
// 改竄・期限切れ・形式不正で false を返すこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyStripeSig } from "@baku-office/shared";

const secret = "whsec_test";
const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
const sign = (t: number, body: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

test("正当な署名（鮮度内）は true", async () => {
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${sign(t, payload)}`;
  assert.equal(await verifyStripeSig(secret, payload, header), true);
});

test("ペイロード改竄は false", async () => {
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${sign(t, payload)}`;
  assert.equal(await verifyStripeSig(secret, "{}", header), false);
});

test("タイムスタンプが許容外（古い）は false", async () => {
  const t = Math.floor(Date.now() / 1000) - 1000;
  const header = `t=${t},v1=${sign(t, payload)}`;
  assert.equal(await verifyStripeSig(secret, payload, header), false);
});

test("形式不正（v1欠落）は false", async () => {
  assert.equal(await verifyStripeSig(secret, payload, "t=123"), false);
});
