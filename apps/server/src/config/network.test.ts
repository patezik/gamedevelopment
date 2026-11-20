import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { listNetworkCandidates, type NetworkInterfaces } from './network.ts';

/** One IPv4 entry as `os.networkInterfaces()` reports it. */
function v4(address: string, mac: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac,
    internal,
    cidr: `${address}/24`,
  };
}

function v6(address: string, mac: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac,
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

const LOOPBACK = { lo: [v4('127.0.0.1', '00:00:00:00:00:00', true)] };
const WIFI_MAC = 'a4:83:e7:11:22:33';

const summary = (interfaces: NetworkInterfaces, publicHost?: string) =>
  listNetworkCandidates(interfaces, publicHost).map(
    (c) => `${c.interface} ${c.address}${c.recommended ? ' *' : ''}${c.virtual ? ' v' : ''}`,
  );

describe('typical machines', () => {
  it('home Wi-Fi only: the Wi-Fi address is recommended, loopback is dropped', () => {
    expect(summary({ ...LOOPBACK, wlan0: [v4('192.168.1.42', WIFI_MAC)] })).toEqual([
      'wlan0 192.168.1.42 *',
    ]);
  });

  it('Docker bridge next to Wi-Fi: Wi-Fi wins, Docker stays listed as virtual', () => {
    const interfaces = {
      ...LOOPBACK,
      docker0: [v4('172.17.0.1', '02:42:6c:aa:bb:cc')],
      wlan0: [v4('192.168.1.42', WIFI_MAC)],
    };
    expect(summary(interfaces)).toEqual(['wlan0 192.168.1.42 *', 'docker0 172.17.0.1 v']);
  });

  it('WSL / Hyper-V switch next to Ethernet (Windows names)', () => {
    const interfaces = {
      'vEthernet (WSL)': [v4('172.28.64.1', '00:15:5d:01:02:03')],
      Ethernet: [v4('10.0.0.15', 'b0:25:aa:44:55:66')],
    };
    expect(summary(interfaces)).toEqual(['Ethernet 10.0.0.15 *', 'vEthernet (WSL) 172.28.64.1 v']);
  });

  it('VPN tunnel with a 192.168 address loses to a real 10.x LAN (zero MAC, tun name)', () => {
    const interfaces = {
      tun0: [v4('192.168.50.2', '00:00:00:00:00:00')],
      eth0: [v4('10.1.2.3', 'b0:25:aa:44:55:66')],
    };
    expect(summary(interfaces)).toEqual(['eth0 10.1.2.3 *', 'tun0 192.168.50.2 v']);
  });

  it('macOS: utun and bridge adapters are virtual', () => {
    const interfaces = {
      en0: [v4('192.168.0.10', WIFI_MAC)],
      utun3: [v4('10.8.0.6', '00:00:00:00:00:00')],
      bridge100: [v4('192.168.64.1', '5e:e9:1f:00:00:64')],
    };
    expect(summary(interfaces)).toEqual([
      'en0 192.168.0.10 *',
      'bridge100 192.168.64.1 v',
      'utun3 10.8.0.6 v',
    ]);
  });

  it('virtual adapter recognised by MAC even with an innocent name (VMware, VirtualBox)', () => {
    const interfaces = {
      'Ethernet 2': [v4('192.168.56.1', '08:00:27:aa:bb:cc')],
      'Ethernet 3': [v4('192.168.234.1', '00:50:56:c0:00:08')],
      Ethernet: [v4('192.168.1.5', 'b0:25:aa:44:55:66')],
    };
    expect(summary(interfaces)).toEqual([
      'Ethernet 192.168.1.5 *',
      'Ethernet 2 192.168.56.1 v',
      'Ethernet 3 192.168.234.1 v',
    ]);
  });
});

describe('ranking', () => {
  it('prefers 192.168, then 10, then 172.16/12, then other addresses', () => {
    const interfaces = {
      a: [v4('172.20.1.1', WIFI_MAC)],
      b: [v4('10.0.0.2', WIFI_MAC)],
      c: [v4('192.168.0.2', WIFI_MAC)],
      d: [v4('100.100.1.1', WIFI_MAC)], // CGNAT: not a home LAN range
    };
    expect(summary(interfaces)).toEqual([
      'c 192.168.0.2 *',
      'b 10.0.0.2',
      'a 172.20.1.1',
      'd 100.100.1.1',
    ]);
  });

  it('is independent of the order the OS reports interfaces', () => {
    const wifi = { wlan0: [v4('192.168.1.42', WIFI_MAC)] };
    const docker = { docker0: [v4('172.17.0.1', '02:42:6c:aa:bb:cc')] };
    expect(listNetworkCandidates({ ...wifi, ...docker })).toEqual(
      listNetworkCandidates({ ...docker, ...wifi }),
    );
  });

  it('recommends exactly one address when several real networks exist', () => {
    const interfaces = {
      eth0: [v4('192.168.1.5', 'b0:25:aa:44:55:66')],
      wlan0: [v4('192.168.1.42', WIFI_MAC)],
    };
    const candidates = listNetworkCandidates(interfaces);
    expect(candidates.filter((c) => c.recommended)).toHaveLength(1);
    expect(candidates).toHaveLength(2); // the other one stays selectable
  });
});

describe('only unusable addresses are dropped', () => {
  it('returns nothing for a machine with loopback only', () => {
    expect(listNetworkCandidates(LOOPBACK)).toEqual([]);
    expect(listNetworkCandidates({})).toEqual([]);
  });

  it('drops loopback, link-local, 0.0.0.0, multicast, internal and IPv6 entries', () => {
    const interfaces = {
      lo: [v4('127.0.0.1', '00:00:00:00:00:00', true)],
      odd: [v4('127.1.2.3', WIFI_MAC)], // 127/8 is all loopback even if not flagged internal
      eth0: [v4('169.254.10.20', WIFI_MAC), v6('fe80::1', WIFI_MAC)],
      eth1: [v4('0.0.0.0', WIFI_MAC), v4('224.0.0.1', WIFI_MAC), v4('255.255.255.255', WIFI_MAC)],
      wlan0: [v4('192.168.1.42', WIFI_MAC)],
    };
    expect(summary(interfaces)).toEqual(['wlan0 192.168.1.42 *']);
  });

  it('ignores malformed addresses and interfaces without entries', () => {
    const interfaces: NetworkInterfaces = {
      bad: [v4('999.1.1.1', WIFI_MAC), v4('not-an-ip', WIFI_MAC)],
      empty: undefined,
      none: [],
    };
    expect(listNetworkCandidates(interfaces)).toEqual([]);
  });

  it('lists the same address once', () => {
    const interfaces = {
      eth0: [v4('192.168.1.5', 'b0:25:aa:44:55:66')],
      eth0b: [v4('192.168.1.5', 'b0:25:aa:44:55:66')],
    };
    expect(listNetworkCandidates(interfaces)).toHaveLength(1);
  });

  it('keeps the physical interface for a shared address regardless of enumeration order', () => {
    const wifi = { wlan0: [v4('192.168.1.42', WIFI_MAC)] };
    const vpn = { tun0: [v4('192.168.1.42', '00:00:00:00:00:00')] };
    expect(summary({ ...vpn, ...wifi })).toEqual(['wlan0 192.168.1.42 *']);
    expect(summary({ ...wifi, ...vpn })).toEqual(['wlan0 192.168.1.42 *']);
  });

  it('keeps virtual-only machines selectable but recommends nothing', () => {
    const interfaces = { docker0: [v4('172.17.0.1', '02:42:6c:aa:bb:cc')] };
    expect(summary(interfaces)).toEqual(['docker0 172.17.0.1 v']);
  });

  it('does not treat a 172.17 address on a real-looking adapter as safe: flags the Docker range', () => {
    expect(summary({ eth0: [v4('172.17.0.5', 'b0:25:aa:44:55:66')] })).toEqual([
      'eth0 172.17.0.5 v',
    ]);
  });
});

describe('HS_PUBLIC_HOST override', () => {
  const interfaces = {
    wlan0: [v4('192.168.1.42', WIFI_MAC)],
    docker0: [v4('172.17.0.1', '02:42:6c:aa:bb:cc')],
  };

  it('comes first and is the only recommended candidate', () => {
    expect(summary(interfaces, 'game-pc.local')).toEqual([
      'HS_PUBLIC_HOST game-pc.local *',
      'wlan0 192.168.1.42',
      'docker0 172.17.0.1 v',
    ]);
  });

  it('is not duplicated when it equals a detected address', () => {
    expect(summary(interfaces, '192.168.1.42')).toEqual([
      'HS_PUBLIC_HOST 192.168.1.42 *',
      'docker0 172.17.0.1 v',
    ]);
  });

  it('works on a machine where nothing was detected', () => {
    expect(summary(LOOPBACK, '203.0.113.7')).toEqual(['HS_PUBLIC_HOST 203.0.113.7 *']);
  });
});
