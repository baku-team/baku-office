// テスト起動前に解決フックを登録（node --import ./test/_cf-register.mjs）。
import { register } from "node:module";
register("./_cf-hooks.mjs", import.meta.url);
