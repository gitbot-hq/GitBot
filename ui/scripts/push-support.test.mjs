import assert from "node:assert/strict";
import test from "node:test";
import { isIos, pushBlocker } from "../app/lib/push-support.ts";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

test("isIos: iPhone, and iPadOS posing as a Mac, but not a real Mac", () => {
  assert.equal(isIos(IPHONE, "iPhone", 5), true);
  assert.equal(isIos(IPAD_DESKTOP, "MacIntel", 5), true);
  assert.equal(isIos(CHROME_MAC, "MacIntel", 0), false);
  assert.equal(isIos(IPAD_DESKTOP, "MacIntel", 0), false);
});

const env = (over) => ({ secure: true, ios: false, standalone: false, hasApis: true, ...over });

test("pushBlocker: desktop Chrome on localhost or HTTPS can subscribe", () => {
  assert.equal(pushBlocker(env({})), null);
});

test("pushBlocker: a plain-http LAN address can't, whatever the browser", () => {
  assert.equal(pushBlocker(env({ secure: false })), "insecure");
  assert.equal(pushBlocker(env({ secure: false, ios: true, hasApis: false })), "insecure");
});

test("pushBlocker: iOS Safari in a tab is told to add to the Home Screen", () => {
  assert.equal(pushBlocker(env({ ios: true, hasApis: false })), "needs-install");
});

test("pushBlocker: the installed iOS app subscribes, unless iOS is older than 16.4", () => {
  assert.equal(pushBlocker(env({ ios: true, standalone: true })), null);
  assert.equal(pushBlocker(env({ ios: true, standalone: true, hasApis: false })), "ios-too-old");
});

test("pushBlocker: other browsers without Web Push are unsupported", () => {
  assert.equal(pushBlocker(env({ hasApis: false })), "unsupported");
});
