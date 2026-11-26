import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractStaticAssetCandidates,
  downloadMissingStaticAssets
} from './faithful-engine';

describe('Faithful Engine: Extração e Download de Recursos Estáticos Ausentes', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('extrai candidatos de imagens, srcset, picture, inline style e CDNs no HTML', () => {
    const html = `
      <html>
        <head>
          <link rel="icon" href="/favicon.ico">
          <link rel="apple-touch-icon" href="https://cdn.empresa.com/touch.png">
        </head>
        <body>
          <nav class="nav-menu">
            <img src="https://cdn.prod.website-files.com/67b/ln4-menu-img-1.webp" class="menu-img-top">
            <img srcset="https://cdn.prod.website-files.com/67b/ln4-menu-img-2.webp 500w, https://cdn.prod.website-files.com/67b/ln4-menu-img-2-p-800.webp 800w">
          </nav>
          <picture>
            <source srcset="https://cdn.empresa.com/photo.webp" type="image/webp">
            <img src="/images/fallback.png">
          </picture>
          <div style="background-image: url('https://cdn.empresa.com/bg.jpg');"></div>
          <video poster="https://cdn.empresa.com/poster.webp"></video>
        </body>
      </html>
    `;

    const candidates = extractStaticAssetCandidates(html, 'https://landonorris.com/');

    expect(candidates).toContain('https://landonorris.com/favicon.ico');
    expect(candidates).toContain('https://cdn.empresa.com/touch.png');
    expect(candidates).toContain('https://cdn.prod.website-files.com/67b/ln4-menu-img-1.webp');
    expect(candidates).toContain('https://cdn.prod.website-files.com/67b/ln4-menu-img-2.webp');
    expect(candidates).toContain('https://cdn.prod.website-files.com/67b/ln4-menu-img-2-p-800.webp');
    expect(candidates).toContain('https://cdn.empresa.com/photo.webp');
    expect(candidates).toContain('https://landonorris.com/images/fallback.png');
    expect(candidates).toContain('https://cdn.empresa.com/bg.jpg');
    expect(candidates).toContain('https://cdn.empresa.com/poster.webp');
  });

  it('baixa recursos não capturados pelo CDP e os armazena no mapa do ZIP', async () => {
    const mockImageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('menu-img-1.webp')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => mockImageBytes.buffer
        };
      }
      return { ok: false, status: 404 };
    });

    const html = `
      <div class="nav-menu">
        <img src="https://cdn.prod.website-files.com/assets/menu-img-1.webp">
      </div>
    `;

    const urlToZipMap = new Map<string, string>();
    const files: Record<string, Uint8Array> = {};

    const result = await downloadMissingStaticAssets(
      html,
      'https://landonorris.com/',
      'https://landonorris.com/',
      urlToZipMap,
      files
    );

    expect(result.addedCount).toBe(1);
    expect(result.addedBytes).toBe(mockImageBytes.byteLength);

    const zipPath = urlToZipMap.get('https://cdn.prod.website-files.com/assets/menu-img-1.webp');
    expect(zipPath).toBe('_external/cdn.prod.website-files.com/assets/menu-img-1.webp');
    expect(files[zipPath!]).toEqual(mockImageBytes);
  });

  it('bloqueia downloads para IPs privados ou loopback (SSRF guard)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const html = `
      <img src="http://127.0.0.1:8080/secret.png">
      <img src="http://192.168.1.1/admin.png">
      <img src="http://169.254.169.254/metadata.png">
    `;

    const urlToZipMap = new Map<string, string>();
    const files: Record<string, Uint8Array> = {};

    const result = await downloadMissingStaticAssets(
      html,
      'https://landonorris.com/',
      'https://landonorris.com/',
      urlToZipMap,
      files
    );

    expect(result.addedCount).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Object.keys(files).length).toBe(0);
  });

  it('extrai candidatos de modelos 3D, WASM, Rive, HDR e fontes declarados em HTML ou JS', () => {
    const code = `
      const config = {
        models: { helmet: "https://lando.itsoffbrand.io/gl/models/helmet-21.glb" },
        wasm: "https://unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm",
        hdri: "https://lando.itsoffbrand.io/gl/hdri/studio_small_08_1k--light.hdr",
        rive: "https://assets.itsoffbrand.io/lando/rive/circuits.riv",
        fontJson: "https://lando.itsoffbrand.io/gl/fonts/Brier-Bold-msdf.json"
      };
    `;

    const candidates = extractStaticAssetCandidates(code, 'https://landonorris.com/');
    expect(candidates).toContain('https://lando.itsoffbrand.io/gl/models/helmet-21.glb');
    expect(candidates).toContain('https://unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm');
    expect(candidates).toContain('https://lando.itsoffbrand.io/gl/hdri/studio_small_08_1k--light.hdr');
    expect(candidates).toContain('https://assets.itsoffbrand.io/lando/rive/circuits.riv');
    expect(candidates).toContain('https://lando.itsoffbrand.io/gl/fonts/Brier-Bold-msdf.json');
  });

  it('extrai rive.wasm e rive_fallback.wasm de pacotes npm Rive montados dinamicamente em bundles JS', () => {
    const bundleJs = `
      var pkg = {"name":"@rive-app/canvas-lite","version":"2.26.4"};
      f.wasmURL = "https://unpkg.com/".concat(pkg.name,"@").concat(pkg.version,"/rive.wasm");
      s = "https://cdn.jsdelivr.net/npm/".concat(pkg.name,"@").concat(pkg.version,"/rive_fallback.wasm");
    `;

    const candidates = extractStaticAssetCandidates(bundleJs, 'https://landonorris.com/');
    expect(candidates).toContain('https://unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm');
    expect(candidates).toContain('https://unpkg.com/@rive-app/canvas-lite@2.26.4/rive_fallback.wasm');
    expect(candidates).toContain('https://cdn.jsdelivr.net/npm/@rive-app/canvas-lite@2.26.4/rive.wasm');
    expect(candidates).toContain('https://cdn.jsdelivr.net/npm/@rive-app/canvas-lite@2.26.4/rive_fallback.wasm');
  });

  it('rejeita arquivos .wasm vazios (0 bytes ou < 8 bytes) e arquivos sem magic bytes 0061736d', async () => {
    const emptyWasm = new Uint8Array(0);
    const corruptedWasm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // sem magic bytes 0x00 0x61 0x73 0x6d

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('empty.wasm')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => emptyWasm.buffer
        };
      }
      if (url.includes('corrupted.wasm')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => corruptedWasm.buffer
        };
      }
      return { ok: false, status: 404 };
    });

    const html = `
      <script src="/js/empty.wasm"></script>
      <script src="/js/corrupted.wasm"></script>
    `;

    const urlToZipMap = new Map<string, string>();
    const files: Record<string, Uint8Array> = {};

    const result = await downloadMissingStaticAssets(
      html,
      'https://landonorris.com/',
      'https://landonorris.com/',
      urlToZipMap,
      files
    );

    expect(result.addedCount).toBe(0);
    expect(Object.keys(files).length).toBe(0);
  });

  it('aceita arquivos .wasm válidos com magic bytes 0061736d e espelha rive_fallback.wasm', async () => {
    // Magic bytes: 0x00, 0x61, 0x73, 0x6d, version: 0x01, 0x00, 0x00, 0x00
    const validWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x0b]);

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('rive.wasm')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => validWasm.buffer
        };
      }
      return { ok: false, status: 404 };
    });

    const html = `
      <script src="https://unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm"></script>
    `;

    const urlToZipMap = new Map<string, string>();
    const files: Record<string, Uint8Array> = {};

    const result = await downloadMissingStaticAssets(
      html,
      'https://landonorris.com/',
      'https://landonorris.com/',
      urlToZipMap,
      files
    );

    expect(result.addedCount).toBe(1);
    const mainZip = '_external/unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm';
    const fallbackZip = '_external/unpkg.com/@rive-app/canvas-lite@2.26.4/rive_fallback.wasm';

    expect(files[mainZip]).toBeDefined();
    expect(files[mainZip][0]).toBe(0x00);
    expect(files[mainZip][1]).toBe(0x61);
    expect(files[mainZip][2]).toBe(0x73);
    expect(files[mainZip][3]).toBe(0x6d);

    // Verifica que o par rive_fallback.wasm foi automaticamente espelhado
    expect(files[fallbackZip]).toBeDefined();
    expect(files[fallbackZip]).toEqual(files[mainZip]);
  });

  it('extrai e baixa texturas 3D dinâmicas declaradas em template literals e strings em bundles JS', async () => {
    const fakeWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('textures/head/webp/diffuse.webp') || url.includes('textures/head/webp/normal.webp')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => fakeWebp.buffer
        };
      }
      return { ok: false, status: 404 };
    });

    const jsBundle = `
      var vQ = "https://lando.itsoffbrand.io/gl";
      var iQ = "webp";
      var assets = {
        textures: {
          head: {
            diffuse: vQ + \`/textures/head/\${iQ}/diffuse.\${iQ}\`,
            normal: vQ + "/textures/head/webp/normal.webp"
          }
        }
      };
    `;

    const urlToZipMap = new Map<string, string>();
    const files: Record<string, Uint8Array> = {};

    const result = await downloadMissingStaticAssets(
      jsBundle,
      'https://lando.itsoffbrand.io/dev-js/bundle.js',
      'https://landonorris.com/',
      urlToZipMap,
      files
    );

    expect(result.addedCount).toBeGreaterThanOrEqual(2);
    expect(files['_external/lando.itsoffbrand.io/gl/textures/head/webp/diffuse.webp']).toBeDefined();
    expect(files['_external/lando.itsoffbrand.io/gl/textures/head/webp/normal.webp']).toBeDefined();
    expect(urlToZipMap.get('https://lando.itsoffbrand.io/gl/textures/head/webp/diffuse.webp')).toBe(
      '_external/lando.itsoffbrand.io/gl/textures/head/webp/diffuse.webp'
    );
  });

  it('extrai e baixa thumbnails do YouTube dentro de Web Components / Shadow DOM declarativo', async () => {
    const mockJpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('i.ytimg.com') || url.includes('ggpht.com')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'image/jpeg' }),
          arrayBuffer: async () => mockJpgBytes.buffer
        };
      }
      return { ok: false, status: 404 };
    });

    const ytHtml = `
      <html>
        <head><title>YouTube</title></head>
        <body>
          <ytd-app>
            <ytd-rich-grid-renderer>
              <ytd-rich-item-renderer>
                <ytd-thumbnail>
                  <yt-img-shadow>
                    <template shadowrootmode="open">
                      <img id="img" src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg?sqp=-oaymwEcCNAFEJQDSFXy&rs=AOn4CL">
                    </template>
                  </yt-img-shadow>
                </ytd-thumbnail>
                <yt-formatted-string id="video-title">Rick Astley - Never Gonna Give You Up</yt-formatted-string>
              </ytd-rich-item-renderer>
            </ytd-rich-grid-renderer>
          </ytd-app>
        </body>
      </html>
    `;

    const candidates = extractStaticAssetCandidates(ytHtml, 'https://www.youtube.com/');
    expect(candidates).toContain('https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg?sqp=-oaymwEcCNAFEJQDSFXy&rs=AOn4CL');

    const urlToZipMap = new Map<string, string>();
    const files: Record<string, Uint8Array> = {};

    const dlResult = await downloadMissingStaticAssets(
      ytHtml,
      'https://www.youtube.com/',
      'https://www.youtube.com/',
      urlToZipMap,
      files
    );

    expect(dlResult.addedCount).toBeGreaterThanOrEqual(1);
    const mappedPath = urlToZipMap.get('https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg?sqp=-oaymwEcCNAFEJQDSFXy&rs=AOn4CL');
    expect(mappedPath).toBeDefined();
    expect(mappedPath).toMatch(/^_external\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/hq720(\.[a-f0-9]+)?\.jpg$/);
    expect(files[mappedPath!]).toBeDefined();
  });
});
