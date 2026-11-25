import { describe, it, expect } from 'vitest';
import {
  cleanUrlTokens,
  cleanFormValues
} from './privacy-cleaner';
import { sanitizeHtml } from '../sanitizer';
import { rewriteHtmlDocument } from '../faithful/rewriter';
import { generateReplayShim } from '../faithful/replay-shim';
import { normalizeCrawlUrl } from '../faithful/crawler';

describe('Privacidade e Limpeza de Dados Pessoais (Cofre & Forja)', () => {
  describe('1. cleanUrlTokens: Sanitização de Parâmetros Sensíveis em URLs', () => {
    it('remove tokens e parâmetros confidenciais de URLs absolutas', () => {
      const url = 'https://exemplo.com/perfil?token=xyz123&auth=abc456&key=secret789&session=sess99&sig=validsig&page=2&tema=dark';
      const cleaned = cleanUrlTokens(url);
      expect(cleaned).toContain('page=2');
      expect(cleaned).toContain('tema=dark');
      expect(cleaned).not.toContain('token=');
      expect(cleaned).not.toContain('auth=');
      expect(cleaned).not.toContain('key=');
      expect(cleaned).not.toContain('session=');
      expect(cleaned).not.toContain('sig=');
    });

    it('remove parâmetros sensíveis de URLs relativas preservando o caminho', () => {
      const relUrl = '/api/checkout?session_id=sess_live_123&code=oauth_code_456&access_token=ya29.xx&item=42';
      const cleaned = cleanUrlTokens(relUrl);
      expect(cleaned).toBe('/api/checkout?item=42');
    });

    it('remove tokens quando o parâmetro contém substrings sensíveis como jwt, secret e password', () => {
      const url = 'https://exemplo.com/callback?my_token=abc&user_secret=topsecret&password=123&status=ok';
      const cleaned = cleanUrlTokens(url);
      expect(cleaned).toContain('status=ok');
      expect(cleaned).not.toContain('my_token');
      expect(cleaned).not.toContain('user_secret');
      expect(cleaned).not.toContain('password');
    });

    it('preserva âncoras e fragmentos válidos', () => {
      const url = 'https://exemplo.com/faq?token=secret#secao-ajuda';
      const cleaned = cleanUrlTokens(url);
      expect(cleaned).toBe('https://exemplo.com/faq#secao-ajuda');
    });
  });

  describe('2. cleanFormValues: Limpeza de Formulários e Campos Preenchidos', () => {
    it('apaga valores de inputs de texto, email, telefone e números preenchidos pelo usuário', () => {
      const doc = new DOMParser().parseFromString(
        `<div>
          <input type="text" id="nome" value="Maria Exemplo">
          <input type="email" id="email" value="maria@exemplo.com">
          <input type="tel" id="telefone" value="+551199999999">
          <input type="number" id="cpf" value="12345678900">
          <input type="search" id="busca" value="meus dados confidenciais">
        </div>`,
        'text/html'
      );

      cleanFormValues(doc);

      const inputs = doc.querySelectorAll('input');
      inputs.forEach((inp) => {
        expect(inp.getAttribute('value')).toBe('');
      });
    });

    it('remove completamente campos de senha', () => {
      const doc = new DOMParser().parseFromString(
        `<div>
          <input type="password" id="senha" value="senha123">
          <input type="password" name="confirm_password" value="senha123">
        </div>`,
        'text/html'
      );

      cleanFormValues(doc);
      expect(doc.querySelectorAll('input[type="password"]').length).toBe(0);
    });

    it('esvazia tokens em inputs ocultos (CSRF, session, nonce)', () => {
      const doc = new DOMParser().parseFromString(
        `<div>
          <input type="hidden" name="csrf_token" value="csrf_secret_token_123">
          <input type="hidden" id="authenticity_token" value="auth_token_456">
          <input type="hidden" name="user_session" value="sess_789">
        </div>`,
        'text/html'
      );

      cleanFormValues(doc);

      const hiddens = doc.querySelectorAll('input[type="hidden"]');
      hiddens.forEach((h) => {
        expect(h.getAttribute('value')).toBe('');
      });
    });

    it('apaga texto digitado em textareas', () => {
      const doc = new DOMParser().parseFromString(
        `<form>
          <textarea id="bio">Texto confidencial digitado pelo usuário na sessão.</textarea>
          <textarea id="obs">Observações pessoais e dados de cartão.</textarea>
        </form>`,
        'text/html'
      );

      cleanFormValues(doc);

      const tas = doc.querySelectorAll('textarea');
      tas.forEach((t) => {
        expect(t.textContent).toBe('');
      });
    });

    it('reseta selects para a opção inicial desmarcando seleções dinâmicas', () => {
      const doc = new DOMParser().parseFromString(
        `<select id="pais">
          <option value="br">Brasil</option>
          <option value="us" selected>Estados Unidos</option>
          <option value="ca" selected>Canadá</option>
        </select>`,
        'text/html'
      );

      cleanFormValues(doc);

      const opts = doc.querySelectorAll('option');
      expect(opts[0].hasAttribute('selected')).toBe(true);
      expect(opts[1].hasAttribute('selected')).toBe(false);
      expect(opts[2].hasAttribute('selected')).toBe(false);
    });

    it('remove meta tags de CSRF e atributos data-* sensíveis', () => {
      const doc = new DOMParser().parseFromString(
        `<html>
          <head>
            <meta name="csrf-token" content="secret-csrf-123">
            <meta name="auth-token" content="secret-auth-456">
          </head>
          <body>
            <div id="user" data-token="token-abc" data-auth="auth-xyz" data-normal="visivel"></div>
          </body>
        </html>`,
        'text/html'
      );

      cleanFormValues(doc);

      expect(doc.querySelectorAll('meta[name="csrf-token"]').length).toBe(0);
      expect(doc.querySelectorAll('meta[name="auth-token"]').length).toBe(0);
      const userDiv = doc.getElementById('user');
      expect(userDiv?.hasAttribute('data-token')).toBe(false);
      expect(userDiv?.hasAttribute('data-auth')).toBe(false);
      expect(userDiv?.getAttribute('data-normal')).toBe('visivel');
    });
  });

  describe('3. Integração com Sanitizer (Modo HTML Autossuficiente)', () => {
    it('sanitizeHtml remove senhas, limpa campos preenchidos e sanitiza tokens em links', () => {
      const rawHtml = `<html>
        <body>
          <input type="text" name="usuario" value="usuario_exemplo">
          <input type="password" name="senha" value="123456">
          <textarea name="comentario">Mensagem confidencial</textarea>
          <a href="/checkout?token=supersecret&session=sess123">Comprar</a>
        </body>
      </html>`;

      const sanitized = sanitizeHtml(rawHtml);

      expect(sanitized).not.toContain('type="password"');
      expect(sanitized).not.toContain('usuario_exemplo');
      expect(sanitized).not.toContain('Mensagem confidencial');
      expect(sanitized).not.toContain('token=supersecret');
      expect(sanitized).not.toContain('session=sess123');
      expect(sanitized).toContain('href="/checkout"');
    });
  });

  describe('4. Integração com Rewriter (Modo Fiel / ZIP)', () => {
    it('rewriteHtmlDocument limpa formulários, senhas e sanitiza URLs de links e imagens', () => {
      const rawHtml = `<html>
        <head>
          <meta name="csrf-token" content="meta_csrf_999">
        </head>
        <body>
          <form action="/login" method="POST">
            <input type="text" name="login" value="usuario_logado">
            <input type="password" name="pass" value="senha_secreta">
            <textarea name="anotacao">Notas privadas</textarea>
          </form>
          <a href="/dashboard?auth_token=jwt_xyz&key=api_key_777">Dashboard</a>
          <img src="https://cdn.exemplo.com/avatar.png?sig=signature123&user_id=10">
        </body>
      </html>`;

      const rewritten = rewriteHtmlDocument(
        rawHtml,
        'https://exemplo.com/home',
        'index.html',
        new Map()
      );

      expect(rewritten).not.toContain('senha_secreta');
      expect(rewritten).not.toContain('usuario_logado');
      expect(rewritten).not.toContain('Notas privadas');
      expect(rewritten).not.toContain('meta_csrf_999');
      expect(rewritten).not.toContain('auth_token=jwt_xyz');
      expect(rewritten).not.toContain('api_key_777');
      expect(rewritten).not.toContain('sig=signature123');
    });
  });

  describe('5. Isolamento de Cookies e Storage no Replay Shim (Modo Offline)', () => {
    it('generateReplayShim injeta isolamento de document.cookie, localStorage e sessionStorage', () => {
      const shimCode = generateReplayShim({});
      expect(shimCode).toContain('document.cookie');
      expect(shimCode).toContain('localStorage');
      expect(shimCode).toContain('sessionStorage');
      expect(shimCode).toContain('createMemStorage');
    });
  });

  describe('6. Crawler: Não propaga tokens em URLs enfileiradas', () => {
    it('normalizeCrawlUrl remove tokens e sessões ao normalizar URLs para a fila de BFS', () => {
      const rawUrl = 'https://exemplo.com/pagina-2?token=xyz999&session=sess888&filtro=todos';
      const normalized = normalizeCrawlUrl(rawUrl);
      expect(normalized).toContain('filtro=todos');
      expect(normalized).not.toContain('token=');
      expect(normalized).not.toContain('session=');
    });
  });
});
