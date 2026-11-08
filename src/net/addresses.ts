import { BlockList, isIP } from "node:net";

/**
 * Addresses an outbound request must never reach: loopback, private, link-local,
 * shared (100.64/10, which holds some cloud metadata services), unspecified,
 * multicast and reserved. BlockList also matches IPv4-mapped IPv6 (::ffff:a.b.c.d,
 * in any spelling) against the IPv4 ranges. IPv6 ranges that carry an IPv4 address
 * inside them (IPv4-compatible, IPv4-translated, NAT64, 6to4, Teredo) are refused whole.
 */
const INTERNAL = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) INTERNAL.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2001::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) INTERNAL.addSubnet(net, bits, "ipv6");

/** True for an IP address an outbound request must not reach. Anything that isn't an IP address is false. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return INTERNAL.check(address, "ipv4");
  if (family === 6) return INTERNAL.check(address, "ipv6");
  return false;
}
