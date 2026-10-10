import test from "node:test";
import assert from "node:assert/strict";
import { forgedLocalRequest, isPrivateAddress } from "../scripts/lan-guard.mjs";

test("private LAN addresses are recognised in IPv4, IPv4-mapped and IPv6 form", () => {
  for (const address of ["10.0.0.8", "172.16.0.1", "172.31.255.254", "192.168.0.234", "169.254.3.4", "::ffff:192.168.1.20", "fd12:3456::1", "fc00::1", "fe80::1%en0"]) assert.equal(isPrivateAddress(address), true, address);
  for (const address of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "100.64.0.1", "::ffff:8.8.8.8", "2001:db8::1", "fc::1", "fd1::1", "127.0.0.1", "", undefined]) assert.equal(isPrivateAddress(address), false, String(address));
});

test("only this machine may present a loopback host", () => {
  const lan = { remoteAddress: "192.168.0.88", url: "/api/auth/me" };
  assert.equal(forgedLocalRequest({ ...lan, host: "192.168.0.234:3001" }), false);
  for (const host of ["localhost:3001", "LOCALHOST", "127.0.0.1:3001", "127.1.2.3", "[::1]:3001", "mitty.localhost:3001", undefined, "", "bad host%"]) {
    assert.equal(forgedLocalRequest({ ...lan, host }), true, String(host));
  }
  assert.equal(forgedLocalRequest({ ...lan, host: "192.168.0.234:3001", url: "http://localhost:3001/api/auth/me" }), true, "absolute request targets are refused");
  for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(forgedLocalRequest({ remoteAddress, host: "localhost:3001", url: "/" }), false);
});
