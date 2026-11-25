import { describe, it, expect } from 'vitest';
import { validateUrl, isAllowedProtocol, isPrivateIpOrHost, isLocalhostPage } from './url-guard';

describe('UrlGuard', () => {
  it('permite protocolos http e https', () => {
    expect(isAllowedProtocol('http:')).toBe(true);
    expect(isAllowedProtocol('https:')).toBe(true);
    expect(isAllowedProtocol('ftp:')).toBe(false);
    expect(isAllowedProtocol('file:')).toBe(false);
    expect(isAllowedProtocol('chrome:')).toBe(false);
    expect(isAllowedProtocol('javascript:')).toBe(false);
  });

  it('detecta hosts privados e locais para prevenção de SSRF', () => {
    expect(isPrivateIpOrHost('localhost')).toBe(true);
    expect(isPrivateIpOrHost('127.0.0.1')).toBe(true);
    expect(isPrivateIpOrHost('10.0.0.5')).toBe(true);
    expect(isPrivateIpOrHost('192.168.1.1')).toBe(true);
    expect(isPrivateIpOrHost('172.20.0.1')).toBe(true);
    expect(isPrivateIpOrHost('server.local')).toBe(true);

    expect(isPrivateIpOrHost('example.com')).toBe(false);
    expect(isPrivateIpOrHost('8.8.8.8')).toBe(false);
  });

  it('permite localhost quando flag de teste for explicitamente ativada', () => {
    expect(isPrivateIpOrHost('localhost', true)).toBe(false);
    expect(isPrivateIpOrHost('127.0.0.1', true)).toBe(false);
  });

  it('[SEC-05] detecta e bloqueia IPv6 loopback e enderecos locais com colchetes', () => {
    expect(isPrivateIpOrHost('[::1]')).toBe(true);
    expect(isPrivateIpOrHost('[fe80::1]')).toBe(true);
    expect(isPrivateIpOrHost('[fc00::1]')).toBe(true);
    expect(isPrivateIpOrHost('[::ffff:127.0.0.1]')).toBe(true);

    const resLoopback = validateUrl('http://[::1]/secret');
    expect(resLoopback.valid).toBe(false);
    expect(resLoopback.reason).toContain('SSRF');

    const resLinkLocal = validateUrl('http://[fe80::1]/admin');
    expect(resLinkLocal.valid).toBe(false);

    // [SEC-05] IPv4-mapped IPv6 e Link-Local ranges
    expect(validateUrl('http://[::ffff:192.168.1.1]/admin').valid).toBe(false);
    expect(validateUrl('http://[::ffff:10.0.0.1]/secret').valid).toBe(false);
    expect(validateUrl('http://[::ffff:127.0.0.1]/').valid).toBe(false);
    expect(validateUrl('http://[fd00::1]/secret').valid).toBe(false);
    expect(validateUrl('http://[::ffff:8.8.8.8]/dns').valid).toBe(true);
    expect(validateUrl('http://169.254.169.254/latest/meta-data/').valid).toBe(false);
  });

  it('rejeita credenciais embutidas na URL', () => {
    const res = validateUrl('https://admin:secret@example.com/page');
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('Credenciais');
  });

  it('valida URLs públicas comuns com sucesso', () => {
    const res = validateUrl('https://example.org/path?query=1#hash');
    expect(res.valid).toBe(true);
    expect(res.url?.hostname).toBe('example.org');
  });

  it('[NOVO-02] isLocalhostPage avalia estritamente hostname da pagina e nao se deixa enganar por substrings', () => {
    expect(isLocalhostPage('https://attacker.com/?ref=localhost')).toBe(false);
    expect(isLocalhostPage('https://localhost.attacker.com/page')).toBe(false);
    expect(isLocalhostPage('https://localhost.atacante.com')).toBe(false);
    expect(isLocalhostPage('http://localhost.atacante.com:8080')).toBe(false);
    expect(isLocalhostPage('https://127.0.0.1.attacker.com')).toBe(false);
    expect(isLocalhostPage('https://127.0.0.1.nip.io')).toBe(false);
    expect(isLocalhostPage('http://localhost:3000/')).toBe(true);
    expect(isLocalhostPage('http://localhost:3000')).toBe(true);
    expect(isLocalhostPage('http://127.0.0.1:8080/app')).toBe(true);
    expect(isLocalhostPage('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalhostPage('http://127.0.0.2:8080/app')).toBe(true);
    expect(isLocalhostPage('http://[::1]:5173/dev')).toBe(true);
    expect(isLocalhostPage('http://[::1]:5173')).toBe(true);
  });

  it('rejeita variantes maliciosas de atacante e protocolos nao-http no isLocalhostPage', () => {
    expect(isLocalhostPage('https://localhost.atacante.com')).toBe(false);
    expect(isLocalhostPage('https://127.0.0.1.atacante.com')).toBe(false);
    expect(isLocalhostPage('https://atacante.com/?ref=localhost')).toBe(false);
    expect(isLocalhostPage('https://atacante.com/localhost')).toBe(false);
    expect(isLocalhostPage('javascript:alert(1)')).toBe(false);
    expect(isLocalhostPage('http://localhost:3000')).toBe(true);
    expect(isLocalhostPage('http://127.0.0.1')).toBe(true);
    expect(isLocalhostPage('http://[::1]:8080')).toBe(true);
  });
});
