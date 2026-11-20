import type { NetworkInterfaceInfo } from 'node:os';

/** Shape of `os.networkInterfaces()`; injected so tests can feed fixed data. */
export type NetworkInterfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

export interface NetworkCandidate {
  /** IPv4 address (or the `HS_PUBLIC_HOST` override) a phone should connect to. */
  address: string;
  /** Interface name, or `HS_PUBLIC_HOST` for the manual override. */
  interface: string;
  /** At most one candidate is recommended; none when every address looks virtual. */
  recommended: boolean;
  /** Looks like Docker, WSL, a VM or a VPN: usually unreachable from a phone on the home network. */
  virtual: boolean;
}

export const PUBLIC_HOST_INTERFACE = 'HS_PUBLIC_HOST';

// Interface names that mean a virtual or tunnel adapter. Names differ per OS and language, so this
// is only one of several signals (see isVirtual).
const VIRTUAL_NAME =
  /^(docker|br-|veth|virbr|vboxnet|vmnet|utun|tun|tap|wg|tailscale|zt|ppp|awdl|llw|bridge\d)|vethernet|hyper-v|wsl|virtualbox|vmware|vpn|tailscale|zerotier|loopback/i;

// MAC prefixes (OUI) of virtualization vendors; they are not localized, unlike interface names.
const VIRTUAL_MAC_PREFIXES = [
  '02:42', // Docker
  '00:15:5d', // Hyper-V, WSL
  '00:50:56', // VMware
  '00:0c:29', // VMware
  '00:05:69', // VMware
  '00:1c:14', // VMware
  '08:00:27', // VirtualBox
  '52:54:00', // QEMU / KVM / libvirt
  '00:16:3e', // Xen
];
const ZERO_MAC = '00:00:00:00:00:00'; // tun/tap and WireGuard adapters have no hardware address

type Octets = [number, number, number, number];

function parseIpv4(address: string): Octets | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? (octets as Octets) : undefined;
}

/** Addresses a phone can never use: loopback, "this host", link-local, multicast and above. */
function isNeverReachable([a, b]: Octets): boolean {
  return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
}

function isVirtual(name: string, mac: string, [a, b]: Octets): boolean {
  const lowerMac = mac.toLowerCase();
  return (
    VIRTUAL_NAME.test(name) ||
    lowerMac === ZERO_MAC ||
    VIRTUAL_MAC_PREFIXES.some((prefix) => lowerMac.startsWith(prefix)) ||
    (a === 172 && b === 17) // Docker default bridge 172.17.0.0/16
  );
}

/** Home networks are mostly 192.168/16, then 10/8, then 172.16/12; anything else ranks last. */
function rangeScore([a, b]: Octets): number {
  if (a === 192 && b === 168) return 12;
  if (a === 10) return 11;
  if (a === 172 && b >= 16 && b <= 31) return 10;
  return 0;
}

const VIRTUAL_PENALTY = 100;

/**
 * LAN address candidates for the pairing QR, best first.
 *
 * Only addresses that can never work are dropped. Everything else stays in the list: suspected
 * virtual adapters are flagged and ranked low instead of removed, so a wrong guess shows an extra
 * candidate rather than hiding the right one. A configured `publicHost` always comes first.
 */
export function listNetworkCandidates(
  interfaces: NetworkInterfaces,
  publicHost?: string,
): NetworkCandidate[] {
  const scored: { candidate: NetworkCandidate; score: number }[] = [];
  const seen = new Set<string>();

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || seen.has(entry.address)) continue;
      const octets = parseIpv4(entry.address);
      if (!octets || isNeverReachable(octets)) continue;
      seen.add(entry.address);

      const virtual = isVirtual(name, entry.mac, octets);
      scored.push({
        candidate: { address: entry.address, interface: name, recommended: false, virtual },
        score: rangeScore(octets) - (virtual ? VIRTUAL_PENALTY : 0),
      });
    }
  }

  scored.sort(
    (x, y) =>
      y.score - x.score ||
      x.candidate.interface.localeCompare(y.candidate.interface, 'en') ||
      x.candidate.address.localeCompare(y.candidate.address, 'en'),
  );
  const candidates = scored.map(({ candidate }) => candidate);

  const best = candidates.find((candidate) => !candidate.virtual);
  if (best) best.recommended = true;

  if (publicHost === undefined) return candidates;
  return [
    { address: publicHost, interface: PUBLIC_HOST_INTERFACE, recommended: true, virtual: false },
    ...candidates
      .filter((candidate) => candidate.address !== publicHost)
      .map((candidate) => ({ ...candidate, recommended: false })),
  ];
}
