import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ALEVEL_PAGE_COPY } from "../lib/alevel-page-locale.mjs";

test("limits automatic administrator access to loopback hostnames", async () => {
  const auth = await readFile(new URL("../lib/server/auth.ts", import.meta.url), "utf8");
  assert.match(auth, /hostname === "localhost"/);
  assert.match(auth, /hostname === "127\.0\.0\.1"/);
  assert.match(auth, /hostname === "::1"/);
  assert.match(auth, /hostname\.endsWith\("\.localhost"\)/);
  assert.match(auth, /if \(isLocalRequest\(request\)\)/);
  assert.match(auth, /return LOCAL_ADMIN/);
  assert.match(auth, /INSERT OR IGNORE INTO users/);
});

test("shows local administrator labels without internal account details and hides logout", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const header = await readFile(new URL("../app/components/SiteHeader.tsx", import.meta.url), "utf8");
  assert.equal(ALEVEL_PAGE_COPY.zh.localAdmin, "本地管理员");
  assert.equal(ALEVEL_PAGE_COPY.zh.noLogin, "无需登录");
  assert.equal(ALEVEL_PAGE_COPY.en.localAdmin, "Local Admin");
  for (const copy of Object.values(ALEVEL_PAGE_COPY)) {
    assert.equal("localAdminSuffix" in copy, false);
    assert.equal("loggedInAs" in copy, false);
  }
  // The account chip sits in the shared site header; the home page passes the sign-out button to it.
  assert.match(header, /user\.local \? copy\.localAdmin/);
  assert.match(header, /user\.local \? copy\.noLogin/);
  assert.match(page, /!authUser\.local && <button className="account-button" onClick=\{signOut\}>\{pageCopy\.signOut\}<\/button>/);
  assert.doesNotMatch(page, /pageCopy\.(localAdminSuffix|loggedInAs)/);
  assert.match(page, /question\.createdBy === "local-admin"/);
  assert.match(page, /"Entered by local admin" : "本机管理员 录入"/);
});
