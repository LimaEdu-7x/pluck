import { describe, it, expect } from 'vitest';
import {
  isSensitiveResource,
  sanitizeUrlForStorage,
  MAX_CDP_RESOURCES,
  MAX_CDP_BYTES
} from './cdp-recorder';

describe('CDP Recorder Security (FIEL-04 & FIEL-06)', () => {
  describe('isSensitiveResource: Bloqueio de APIs autenticadas e JSON sensível (FIEL-04)', () => {
    it('bloqueia endpoints de autenticação, perfil e tokens', () => {
      expect(isSensitiveResource('https://exemplo.com/api/me', 'application/json')).toBe(true);
      expect(isSensitiveResource('https://exemplo.com/auth/token', 'application/json')).toBe(true);
      expect(isSensitiveResource('https://exemplo.com/user/profile', 'application/json')).toBe(true);
      expect(isSensitiveResource('https://exemplo.com/session/login', 'application/json')).toBe(true);
      expect(isSensitiveResource('https://exemplo.com/api/v1/graphql', 'application/json')).toBe(true);
      expect(isSensitiveResource('https://exemplo.com/oauth/access_token', 'application/json')).toBe(true);
    });

    it('bloqueia respostas application/json genéricas não identificadas como assets estáticos', () => {
      expect(isSensitiveResource('https://exemplo.com/dados-privados', 'application/json')).toBe(true);
      expect(isSensitiveResource('https://exemplo.com/schema', 'application/ld+json')).toBe(true);
      expect(isSensitiveResource('https://exemplo.com/info', 'text/json')).toBe(true);
    });

    it('permite arquivos de assets estáticos públicos (.gltf, manifest.json, .png, .woff2, .css, .js)', () => {
      expect(isSensitiveResource('https://exemplo.com/manifest.json', 'application/json')).toBe(false);
      expect(isSensitiveResource('https://exemplo.com/models/model.gltf', 'application/json')).toBe(false);
      expect(isSensitiveResource('https://exemplo.com/animations/anim.lottie', 'application/json')).toBe(false);
      expect(isSensitiveResource('https://exemplo.com/style.css', 'text/css')).toBe(false);
      expect(isSensitiveResource('https://exemplo.com/bundle.js', 'application/javascript')).toBe(false);
      expect(isSensitiveResource('https://exemplo.com/img.png', 'image/png')).toBe(false);
      expect(isSensitiveResource('https://exemplo.com/font.woff2', 'font/woff2')).toBe(false);
      expect(isSensitiveResource('https://exemplo.com/mesh.glb', 'model/gltf-binary')).toBe(false);
    });
  });

  describe('sanitizeUrlForStorage: Limpeza de query tokens confidenciais (FIEL-04)', () => {
    it('remove parâmetros sensíveis de autenticação mantendo parâmetros neutros', () => {
      const dirtyUrl = 'https://exemplo.com/imagem.png?token=SECRET123&width=800&auth=XYZ987';
      const cleanUrl = sanitizeUrlForStorage(dirtyUrl);
      expect(cleanUrl).not.toContain('SECRET123');
      expect(cleanUrl).not.toContain('XYZ987');
      expect(cleanUrl).toContain('width=800');
    });

    it('remove signature, session, access_token, jwt, apikey', () => {
      const url = 'https://cdn.exemplo.com/asset.js?access_token=111&sig=222&session=333&jwt=444&apikey=555';
      const clean = sanitizeUrlForStorage(url);
      expect(clean).not.toContain('111');
      expect(clean).not.toContain('222');
      expect(clean).not.toContain('333');
      expect(clean).not.toContain('444');
      expect(clean).not.toContain('555');
    });

    it('mantém intactas URLs sem parâmetros sensíveis', () => {
      const safe = 'https://cdn.exemplo.com/style.css?v=1.2.3&lang=pt-br';
      expect(sanitizeUrlForStorage(safe)).toBe(safe);
    });
  });

  describe('Limites Globais de Recursos (FIEL-06)', () => {
    it('define teto de até 2000 recursos e 150 MB', () => {
      expect(MAX_CDP_RESOURCES).toBeLessThanOrEqual(2000);
      expect(MAX_CDP_BYTES).toBeLessThanOrEqual(150 * 1024 * 1024);
    });
  });
});
