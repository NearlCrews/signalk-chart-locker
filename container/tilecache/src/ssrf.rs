//! SSRF guards for the egress proxy. The proxy is keyed by source id (never a client URL), redirects
//! are disabled at the client, and every resolved upstream IP is checked here before connecting, so an
//! allowlisted hostname that resolves (or rebinds) to a private, loopback, link-local, multicast, or
//! unspecified address cannot turn the tokenless container into an SSRF pivot.

use std::net::{IpAddr, Ipv6Addr};

/// True when a target IP must not be connected to from the egress proxy.
pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // 100.64.0.0/10 carrier-grade NAT (shared address space).
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                || is_unique_local(v6)
                || is_link_local_v6(v6)
                // An IPv4-mapped address (::ffff:a.b.c.d) is checked against the v4 rules.
                || v6.to_ipv4_mapped().map(|m| is_forbidden_ip(IpAddr::V4(m))).unwrap_or(false)
        }
    }
}

/// fc00::/7 unique-local addresses (the IPv6 analog of RFC1918).
fn is_unique_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

/// fe80::/10 link-local addresses.
fn is_link_local_v6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn rejects_private_loopback_linklocal_and_metadata() {
        for s in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"] {
            let ip: IpAddr = s.parse().unwrap();
            assert!(is_forbidden_ip(ip), "{s} should be forbidden");
        }
        assert!(is_forbidden_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_forbidden_ip(IpAddr::V6("fc00::1".parse().unwrap())));
        assert!(is_forbidden_ip(IpAddr::V6("fe80::1".parse().unwrap())));
        assert!(is_forbidden_ip(IpAddr::V6("::ffff:127.0.0.1".parse().unwrap())));
    }

    #[test]
    fn allows_a_public_address() {
        assert!(!is_forbidden_ip(IpAddr::V4(Ipv4Addr::new(140, 90, 1, 1)))); // a NOAA-range public IP
        assert!(!is_forbidden_ip(IpAddr::V6("2606:4700::1".parse().unwrap()))); // a public IPv6
    }
}
