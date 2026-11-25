export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
  url?: URL;
}

export function isAllowedProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

/**
 * [NOVO-02] Determina se a URL da página refere-se legitimamente a um host local/loopback.
 * Avalia ESTRITAMENTE o hostname parsed via WHATWG URL (localhost, 127.0.0.0/8, ::1).
 * Não aceita substrings em path ou subdomínios (ex: https://attacker.com/?q=localhost).
 */
export function isLocalhostPage(pageUrl: string): boolean {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1') {
      return true;
    }

    if (/^127\.\d+\.\d+\.\d+$/.test(host)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function isPrivateIpOrHost(hostname: string, allowLocalhostForTests = false): boolean {
  // [SEC-05] Remove colchetes de endereços IPv6 (ex: '[::1]' -> '::1')
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    allowLocalhostForTests &&
    (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1')
  ) {
    return false;
  }

  // Hostnames locais padrão
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === '::') {
    return true;
  }

  if (host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }

  // [SEC-05] Checagem de IPv6 privados e locais:
  // Loopback (::1), Link-Local (fe80::/10), Unique Local (fc00::/7, fd00::/7)
  if (
    host.startsWith('fe80:') ||
    /^fe[89ab][0-9a-f]:/i.test(host) ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }

  // [SEC-05] IPv4-mapped IPv6 (ex: ::ffff:127.0.0.1 ou em hex ::ffff:7f00:1 / ::ffff:808:808)
  if (host.startsWith('::ffff:')) {
    const rawMapped = host.replace(/^::ffff:/, '');
    let mappedIpv4: string | null = null;

    if (/^\d+\.\d+\.\d+\.\d+$/.test(rawMapped)) {
      mappedIpv4 = rawMapped;
    } else {
      const parts = rawMapped.split(':');
      if (parts.length === 2) {
        const hi = parseInt(parts[0], 16);
        const lo = parseInt(parts[1], 16);
        if (!isNaN(hi) && !isNaN(lo)) {
          mappedIpv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        }
      }
    }

    if (mappedIpv4) {
      return isPrivateIpOrHost(mappedIpv4, allowLocalhostForTests);
    }
    return true;
  }

  // IPv4 private ranges
  const ipv4Match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const octet1 = parseInt(ipv4Match[1], 10);
    const octet2 = parseInt(ipv4Match[2], 10);

    // 10.0.0.0/8
    if (octet1 === 10) return true;
    // 172.16.0.0/12
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true;
    // 192.168.0.0/16
    if (octet1 === 192 && octet2 === 168) return true;
    // 127.0.0.0/8
    if (octet1 === 127) return true;
    // 169.254.0.0/16
    if (octet1 === 169 && octet2 === 254) return true;
    // 0.0.0.0/8
    if (octet1 === 0) return true;
  }

  return false;
}

export function validateUrl(rawUrl: string, allowLocalhost = false): UrlValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, reason: 'URL vazia ou inválida' };
  }

  try {
    const parsed = new URL(rawUrl);

    if (!isAllowedProtocol(parsed.protocol)) {
      return { valid: false, reason: `Protocolo proibido: ${parsed.protocol}` };
    }

    if (parsed.username || parsed.password) {
      return { valid: false, reason: 'Credenciais na URL não são permitidas' };
    }

    if (isPrivateIpOrHost(parsed.hostname, allowLocalhost)) {
      return { valid: false, reason: 'Acesso a hosts locais ou privados bloqueado (SSRF guard)' };
    }

    return { valid: true, url: parsed };
  } catch {
    return { valid: false, reason: 'Formato de URL inválido' };
  }
}
