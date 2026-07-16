//! SSRF guards for the egress proxy. The proxy is keyed by source id (never a client URL), redirects
//! are disabled at the client, and every resolved upstream IP is checked here before connecting, so an
//! allowlisted hostname that resolves (or rebinds) to a private, loopback, link-local, multicast, or
//! unspecified address cannot turn the private egress container into an SSRF pivot.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// True when a target IP must not be connected to from the egress proxy.
pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_unspecified()
                // 0.0.0.0/8 "this network": is_unspecified only matches 0.0.0.0 exactly, but Linux routes
                // the whole 0.0.0.0/8 block to the local host, so 0.0.0.1 through 0.255.255.255 must be
                // rejected too or they become an SSRF-to-loopback bypass.
                || v4.octets()[0] == 0
                || v4.is_broadcast()
                || v4.is_documentation()
                // 100.64.0.0/10 carrier-grade NAT (shared address space).
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
                // 240.0.0.0/4 reserved, 198.18.0.0/15 benchmarking, 192.0.0.0/24 IETF assignments.
                || v4.octets()[0] >= 240
                || (v4.octets()[0] == 198 && (v4.octets()[1] & 0xfe) == 18)
                || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 0)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                || is_unique_local(v6)
                || is_link_local_v6(v6)
                || is_site_local_v6(v6)
                // An IPv4-mapped address (::ffff:a.b.c.d) is checked against the v4 rules.
                || v6.to_ipv4_mapped().map(|m| is_forbidden_ip(IpAddr::V4(m))).unwrap_or(false)
                // 6to4 (2002::/16) and the well-known NAT64 prefix (64:ff9b::/96) embed a v4; decode it
                // and apply the v4 rules so a transition-range address cannot reach a private v4.
                || embedded_v4(v6).map(|m| is_forbidden_ip(IpAddr::V4(m))).unwrap_or(false)
                // RFC 8215 local-use NAT64 (64:ff9b:1::/48): a translation prefix whose embedded v4
                // offset varies by prefix length, so reject the whole /48 rather than decode it. The
                // prefix is reserved and not globally routable, so no real public upstream falls in it.
                || is_local_use_nat64(v6)
                // Egress accepts ordinary global-unicast IPv6 only. This excludes documentation,
                // benchmarking, discard-only, and other special-purpose ranges outside 2000::/3.
                || !is_global_unicast_v6(v6)
        }
    }
}

/// The RFC 8215 local-use NAT64 prefix 64:ff9b:1::/48 (first 48 bits are 0064:ff9b:0001).
fn is_local_use_nat64(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 0x0001
}

/// True when the URL's host is an IP literal that is forbidden for egress (loopback, private,
/// link-local, and the other ranges is_forbidden_ip rejects). A hostname (non-literal) yields
/// false here; hostnames are guarded separately at DNS-resolution time.
pub fn is_forbidden_ip_literal_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| {
                let bare = h
                    .strip_prefix('[')
                    .and_then(|s| s.strip_suffix(']'))
                    .unwrap_or(h);
                bare.parse::<std::net::IpAddr>()
                    .map(is_forbidden_ip)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// The v4 embedded in a 6to4 (2002::/16) or well-known NAT64 (64:ff9b::/96) IPv6 address, if either
/// prefix matches, so the v4 forbidden-range rules can run over a transition-range target.
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = ip.segments();
    // 2002:AABB:CCDD::/48 6to4: the v4 is segments 1 and 2.
    if s[0] == 0x2002 {
        return Some(Ipv4Addr::new(
            (s[1] >> 8) as u8,
            s[1] as u8,
            (s[2] >> 8) as u8,
            s[2] as u8,
        ));
    }
    // 64:ff9b::/96 well-known NAT64: the v4 is the last 32 bits.
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 {
        return Some(Ipv4Addr::new(
            (s[6] >> 8) as u8,
            s[6] as u8,
            (s[7] >> 8) as u8,
            s[7] as u8,
        ));
    }
    // ::a.b.c.d IPv4-compatible (deprecated): the high 96 bits are zero and the low 32 are a v4, so
    // ::7f00:1 (::127.0.0.1) would otherwise reach loopback. :: and ::1 map to 0.0.0.0 and 0.0.0.1,
    // which the unspecified and 0.0.0.0/8 v4 rules already reject.
    if s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 {
        return Some(Ipv4Addr::new(
            (s[6] >> 8) as u8,
            s[6] as u8,
            (s[7] >> 8) as u8,
            s[7] as u8,
        ));
    }
    None
}

/// fc00::/7 unique-local addresses (the IPv6 analog of RFC1918).
fn is_unique_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

/// fe80::/10 link-local addresses.
fn is_link_local_v6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

/// Deprecated fec0::/10 site-local space can still be routed on private networks.
fn is_site_local_v6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfec0
}

fn is_global_unicast_v6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xe000) == 0x2000
        && (ip.segments()[0] != 0x2001 || ip.segments()[1] != 0x0db8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn rejects_private_loopback_linklocal_and_metadata() {
        for s in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "172.16.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "0.1.2.3",
            "224.0.0.1",
        ] {
            let ip: IpAddr = s.parse().unwrap();
            assert!(is_forbidden_ip(ip), "{s} should be forbidden");
        }
        assert!(is_forbidden_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_forbidden_ip(IpAddr::V6("fc00::1".parse().unwrap())));
        assert!(is_forbidden_ip(IpAddr::V6("fe80::1".parse().unwrap())));
        assert!(is_forbidden_ip(IpAddr::V6("fec0::1".parse().unwrap())));
        assert!(is_forbidden_ip(IpAddr::V6("2001:db8::1".parse().unwrap())));
        assert!(is_forbidden_ip(IpAddr::V6(
            "::ffff:127.0.0.1".parse().unwrap()
        )));
        // 6to4 wrapping 10.0.0.1 (2002:0a00:0001::) and NAT64 wrapping 192.168.1.1 (64:ff9b::c0a8:0101).
        assert!(is_forbidden_ip(IpAddr::V6(
            "2002:0a00:0001::".parse().unwrap()
        )));
        assert!(is_forbidden_ip(IpAddr::V6(
            "64:ff9b::c0a8:0101".parse().unwrap()
        )));
        // IPv4-compatible ::127.0.0.1 (::7f00:1) decodes to loopback.
        assert!(is_forbidden_ip(IpAddr::V6("::7f00:1".parse().unwrap())));
        // RFC 8215 local-use NAT64 (64:ff9b:1::/48) is rejected across the whole prefix.
        assert!(is_forbidden_ip(IpAddr::V6("64:ff9b:1::1".parse().unwrap())));
        assert!(is_forbidden_ip(IpAddr::V6(
            "64:ff9b:1:0:0:0:c0a8:1".parse().unwrap()
        )));
    }

    #[test]
    fn allows_a_public_address() {
        assert!(!is_forbidden_ip(IpAddr::V4(Ipv4Addr::new(140, 90, 1, 1)))); // a NOAA-range public IP
        assert!(!is_forbidden_ip(IpAddr::V6(
            "2606:4700::1".parse().unwrap()
        ))); // a public IPv6
    }
}
