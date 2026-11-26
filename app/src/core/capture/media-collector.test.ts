import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unzipSync } from 'fflate';
import {
  collectMediaFromDom,
  captureMediaZip,
  type MediaCandidate
} from './media-collector';

describe('Media Collector (SPEC-v12: Modo Somente Mídias)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('coleta imagens, vídeos, áudios e vetores SVG do DOM e templates', () => {
    const html = `
      <html>
        <body>
          <img src="https://example.com/foto1.jpg" alt="Foto 1">
          <picture>
            <source srcset="https://example.com/banner.webp" type="image/webp">
          </picture>
          <video src="https://example.com/video1.mp4" title="Video Principal"></video>
          <audio src="https://example.com/audio1.mp3" title="Musica"></audio>
          <svg id="icone-star"><circle cx="5" cy="5" r="5"/></svg>
          <template shadowrootmode="open">
            <img src="https://example.com/shadow-thumb.png" alt="Shadow Thumb">
            <video src="https://example.com/shadow-video.webm"></video>
          </template>
        </body>
      </html>
    `;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const allMedia = collectMediaFromDom(doc, 'https://example.com');

    const types = allMedia.map((m) => m.type);
    expect(types).toContain('image');
    expect(types).toContain('video');
    expect(types).toContain('audio');
    expect(types).toContain('svg');

    expect(allMedia.some((m) => m.url.includes('shadow-thumb.png'))).toBe(true);
    expect(allMedia.some((m) => m.url.includes('shadow-video.webm'))).toBe(true);
  });

  it('respeita o filtro de tipos permitidos ao coletar mídias', () => {
    const html = `
      <html>
        <body>
          <img src="https://example.com/foto.jpg">
          <video src="https://example.com/video.mp4"></video>
          <audio src="https://example.com/audio.mp3"></audio>
        </body>
      </html>
    `;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const videosOnly = collectMediaFromDom(doc, 'https://example.com', ['video']);
    expect(videosOnly.length).toBe(1);
    expect(videosOnly[0].type).toBe('video');
  });

  it('empacota mídias em pastas por tipo no ZIP (imagens/, videos/, audios/, vetores/)', async () => {
    const mockBytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('.jpg')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'image/jpeg' }),
          arrayBuffer: async () => mockBytes.buffer
        };
      }
      if (url.includes('.mp4')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'video/mp4' }),
          arrayBuffer: async () => mockBytes.buffer
        };
      }
      if (url.includes('.mp3')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'audio/mpeg' }),
          arrayBuffer: async () => mockBytes.buffer
        };
      }
      return { ok: false, status: 404 };
    });

    const candidates: MediaCandidate[] = [
      { url: 'https://example.com/foto.jpg', type: 'image', sourceKind: 'img', preferredName: 'foto' },
      { url: 'https://example.com/clip.mp4', type: 'video', sourceKind: 'video', preferredName: 'clip' },
      { url: 'https://example.com/som.mp3', type: 'audio', sourceKind: 'audio', preferredName: 'som' },
      {
        url: 'inline-svg://star',
        type: 'svg',
        sourceKind: 'svg-inline',
        content: '<svg id="star"><circle cx="5" cy="5" r="5"/></svg>',
        preferredName: 'star.svg'
      }
    ];

    const result = await captureMediaZip({
      candidates,
      title: 'meu-site',
      foldersByType: true
    });

    expect(result.stats.savedAssets).toBe(4);

    const buf = new Uint8Array(await result.blob.arrayBuffer());
    const unzipped = unzipSync(buf);
    const filenames = Object.keys(unzipped);

    expect(filenames).toContain('imagens/foto.jpg');
    expect(filenames).toContain('videos/clip.mp4');
    expect(filenames).toContain('audios/som.mp3');
    expect(filenames).toContain('vetores/star.svg');
  });

  it('pula automaticamente arquivos que excedem o tamanho máximo por mídia', async () => {
    const smallBytes = new Uint8Array(100);
    const hugeBytes = new Uint8Array(60 * 1024 * 1024); // 60 MB

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('huge.mp4')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'video/mp4' }),
          arrayBuffer: async () => hugeBytes.buffer
        };
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => smallBytes.buffer
      };
    });

    const candidates: MediaCandidate[] = [
      { url: 'https://example.com/normal.jpg', type: 'image', sourceKind: 'img' },
      { url: 'https://example.com/huge.mp4', type: 'video', sourceKind: 'video' }
    ];

    const result = await captureMediaZip({
      candidates,
      maxPerItemBytes: 50 * 1024 * 1024 // 50 MB
    });

    expect(result.stats.savedAssets).toBe(1);
    expect((result.stats as any).skippedOversizedCount).toBe(1);
  });

  it('suporta pular a mídia atual (shouldSkipCurrent) e parar e salvar (shouldStop)', async () => {
    const mockBytes = new Uint8Array([1, 2, 3]);
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      url,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => mockBytes.buffer
    }));

    const candidates: MediaCandidate[] = [
      { url: 'https://example.com/1.jpg', type: 'image', sourceKind: 'img' },
      { url: 'https://example.com/2.jpg', type: 'image', sourceKind: 'img' },
      { url: 'https://example.com/3.jpg', type: 'image', sourceKind: 'img' },
      { url: 'https://example.com/4.jpg', type: 'image', sourceKind: 'img' }
    ];

    let currentItemIndex = 0;
    const result = await captureMediaZip({
      candidates,
      shouldSkipCurrent: () => {
        currentItemIndex++;
        return currentItemIndex === 2; // Pula o item 2
      },
      shouldStop: () => {
        return currentItemIndex >= 3; // Para no item 3 e salva
      }
    });

    expect((result.stats as any).stoppedByUser).toBe(true);
    expect((result.stats as any).skippedByUserCount).toBe(1);
    expect(result.stats.savedAssets).toBe(1); // Item 1 salvo, item 2 pulado, parou no 3
  });
});
