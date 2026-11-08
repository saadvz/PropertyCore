import { createServer, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { calendarUrlAllowed } from "../src/hub/fetchLimits";
import { fetchMetadataDocument, publicOnlyLookup, readCapped, type Resolve } from "../src/mcp/oauth/clients";
import { isPrivateAddress } from "../src/net/addresses";

const INTERNAL = [
  "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.9", "169.254.169.254", "100.64.0.1", "100.100.100.200", "0.0.0.0",
  "::", "::1", "fe80::1", "fd00::1", "fc00::1",
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "0:0:0:0:0:ffff:7f00:1",
  "64:ff9b::a9fe:a9fe", "::ffff:0:7f00:1", "2002:a9fe:a9fe::", "2001:0:a9fe::1", "fec0::1",
];
const PUBLIC = ["8.8.8.8", "93.184.215.14", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];

describe("outbound address guard", () => {
  it("treats loopback, link-local, private, shared and unspecified addresses as internal, in every IPv6 spelling", () => {
    for (const address of INTERNAL) expect(isPrivateAddress(address), address).toBe(true);
    for (const address of PUBLIC) expect(isPrivateAddress(address), address).toBe(false);
  });

  it("refuses calendar links to an internal address however it is written", () => {
    for (const address of INTERNAL) {
      const host = address.includes(":") ? `[${address}]` : address;
      expect(calendarUrlAllowed(`https://${host}/feed.ics`), host).toBe(false);
    }
    for (const host of ["localhost.", "app.localhost.", "metadata.google.internal.", "printer.local."]) expect(calendarUrlAllowed(`https://${host}/feed.ics`), host).toBe(false);
    expect(calendarUrlAllowed("https://[2606:4700:4700::1111]/feed.ics")).toBe(true);
    expect(calendarUrlAllowed("https://8.8.8.8/feed.ics")).toBe(true);
    expect(calendarUrlAllowed("https://calendar.example.com/feed.ics")).toBe(true);
  });
});

describe("client metadata fetch", () => {
  const resolveTo = (...addresses: string[]): Resolve & { calls: number } => {
    const resolve = async () => {
      resolve.calls += 1;
      return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    };
    resolve.calls = 0;
    return resolve;
  };

  const lookupWith = (resolve: Resolve, options: { all?: boolean }) =>
    new Promise<{ err: NodeJS.ErrnoException | null; result: unknown }>((done) =>
      publicOnlyLookup(resolve)("client.example.com", options, (err, result) => done({ err, result })),
    );

  it("hands the connection only addresses it checked, resolving once", async () => {
    const resolve = resolveTo("93.184.215.14");
    const { err, result } = await lookupWith(resolve, { all: true });
    expect(err).toBeNull();
    expect(result).toEqual([{ address: "93.184.215.14", family: 4 }]);
    expect(resolve.calls).toBe(1);
  });

  it("fails the connection when any resolved address is internal", async () => {
    for (const addresses of [["127.0.0.1"], ["93.184.215.14", "::ffff:169.254.169.254"]]) {
      const { err } = await lookupWith(resolveTo(...addresses), { all: true });
      expect(err?.message, addresses.join()).toMatch(/public address/);
    }
    const { err } = await lookupWith(resolveTo("10.0.0.5"), {});
    expect(err?.message).toMatch(/public address/);
  });

  it("never opens a connection when the host resolves to an internal address", async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    try {
      const resolve = resolveTo("127.0.0.1");
      await expect(fetchMetadataDocument(`https://client.example.com:${port}/oauth/client.json`, { resolve })).rejects.toThrow(/public address/);
      expect(resolve.calls).toBe(1);
      expect(connections).toBe(0);
    } finally {
      server.close();
    }
  });

  it("stops reading a response body once it passes the size limit", async () => {
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 1024;
        this.push(Buffer.alloc(1024, "a"));
      },
    });
    await expect(readCapped(endless, 5 * 1024)).resolves.toBeUndefined();
    expect(produced).toBeLessThan(64 * 1024);
    expect(endless.destroyed).toBe(true);
    await expect(readCapped(Readable.from([Buffer.from('{"client_id":'), Buffer.from('"x"}')]), 5 * 1024)).resolves.toBe('{"client_id":"x"}');
  });
});
