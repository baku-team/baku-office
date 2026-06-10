// 適合性テスト（P0-5）：ファイル本体の保存時暗号化（encryptBytes/decryptBytes）の往復と鍵分離。
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptBytes, decryptBytes, encryptField, decryptField, generateMasterKey } from "@baku-office/shared";

const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const str = (b: ArrayBuffer) => new TextDecoder().decode(b);

test("encryptBytes→decryptBytes：往復で原本に戻る／暗号文は原本と異なる", async () => {
  const mk = generateMasterKey();
  const plain = bytes("領収書PDFのバイト列（機微）");
  const enc = await encryptBytes(mk, plain, "files");
  assert.notEqual(str(enc), str(plain), "暗号文が平文と同一ではない");
  assert.ok(enc.byteLength > plain.byteLength, "IV+タグの分だけ増える");
  const dec = await decryptBytes(mk, enc, "files");
  assert.equal(str(dec), "領収書PDFのバイト列（機微）");
});

test("鍵分離：domain が違うと復号できない", async () => {
  const mk = generateMasterKey();
  const enc = await encryptBytes(mk, bytes("secret"), "files");
  await assert.rejects(() => decryptBytes(mk, enc, "api-keys"), "別domainの鍵では復号失敗");
});

test("別MASTER_KEYでは復号できない", async () => {
  const enc = await encryptBytes(generateMasterKey(), bytes("secret"), "files");
  await assert.rejects(() => decryptBytes(generateMasterKey(), enc, "files"));
});

// P2-2 回帰防止：大きな値の encryptField/decryptField 往復（toB64 のチャンク化でスタック上限を回避）。
test("encryptField：数MB相当でも往復で原本に戻る（toB64チャンク化）", async () => {
  const mk = generateMasterKey();
  const big = "あ".repeat(1_000_000); // UTF-8で約3MB
  const enc = await encryptField(mk, big, "api-keys");
  const dec = await decryptField(mk, enc, "api-keys");
  assert.equal(dec, big);
});
