import { describe, it, expect } from 'vitest';
import { mapUrlToZipPath } from './rewriter';

const PAGE = 'https://site.exemplo.com/dashboard';

describe('B1: colisão de nomes no ZIP (respostas ?_rsc=...)', () => {
  it('40 respostas RSC com _rsc diferentes geram 40 caminhos diferentes', () => {
    const paths = new Set<string>();
    for (let i = 0; i < 40; i++) {
      paths.add(mapUrlToZipPath(`https://site.exemplo.com/__next._tree.txt?_rsc=rsc${i}`, PAGE));
    }
    expect(paths.size).toBe(40);
  });

  it('o mesmo URL gera sempre o mesmo caminho (determinístico)', () => {
    const u = 'https://site.exemplo.com/__next._tree.txt?_rsc=abc123';
    expect(mapUrlToZipPath(u, PAGE)).toBe(mapUrlToZipPath(u, PAGE));
  });
});
