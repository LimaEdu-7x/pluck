import { describe, it, expect } from 'vitest';
import { serializeLiveDom, isSpaSkeleton, isHeavySpa } from './dom-serializer';

describe('DOM Serializer & SPA Skeleton Detector', () => {
  it('detecta se uma página é uma SPA pesada (YouTube/Twitter) para modo foto fiel', () => {
    expect(isHeavySpa('https://www.youtube.com/results?search_query=lofi')).toBe(true);
    expect(isHeavySpa('https://youtu.be/abc12345678')).toBe(true);
    expect(isHeavySpa('https://x.com/home')).toBe(true);
    expect(isHeavySpa('https://twitter.com/i/flow')).toBe(true);
    expect(isHeavySpa('https://landonorris.com/')).toBe(false);
    expect(isHeavySpa('https://getartcraft.com/')).toBe(false);
    expect(isHeavySpa('https://exemplo.com/', '<ytd-app><ytd-rich-item-renderer></ytd-rich-item-renderer></ytd-app>')).toBe(true);
  });
  it('detecta esqueleto vazio do YouTube e shells de SPA', () => {
    const ytSkeleton = `
      <html>
        <head><title>YouTube</title></head>
        <body>
          <div id="skeleton" class="style-scope ytd-rich-grid-renderer">
            <div class="rich-thumbnail skeleton-bg-color"></div>
          </div>
        </body>
      </html>
    `;
    expect(isSpaSkeleton(ytSkeleton)).toBe(true);

    const normalHtml = `
      <html>
        <head><title>YouTube</title></head>
        <body>
          <ytd-app>
            <ytd-rich-item-renderer>
              <div id="video-title">Vídeo Top</div>
            </ytd-rich-item-renderer>
          </ytd-app>
        </body>
      </html>
    `;
    expect(isSpaSkeleton(normalHtml)).toBe(false);
  });

  it('serializa nós normais e mantém tags de imagem', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <h1>Título do Vídeo</h1>
      <img src="https://i.ytimg.com/vi/abc/hq720.jpg" alt="Thumb">
    `;
    const serialized = serializeLiveDom(container);
    expect(serialized).toContain('<h1>Título do Vídeo</h1>');
    expect(serialized).toContain('src="https://i.ytimg.com/vi/abc/hq720.jpg"');
    expect(serialized).toContain('loading="eager"');
  });

  it('serializa Web Components e Shadow DOM como Declarative Shadow DOM (<template shadowrootmode="open">)', () => {
    const customEl = document.createElement('yt-img-shadow');
    const shadow = customEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <img id="img" src="https://i.ytimg.com/vi/xyz/hq720.jpg?sqp=test" alt="Thumbnail">
      <span class="badge">10:45</span>
    `;

    const lightChild = document.createElement('div');
    lightChild.className = 'light-info';
    lightChild.textContent = 'Canal Oficial';
    customEl.appendChild(lightChild);

    const serialized = serializeLiveDom(customEl);
    expect(serialized).toContain('<template shadowrootmode="open" shadowroot="open">');
    expect(serialized).toContain('https://i.ytimg.com/vi/xyz/hq720.jpg?sqp=test');
    expect(serialized).toContain('10:45');
    expect(serialized).toContain('Canal Oficial');
  });

  it('resolve imagens com lazy load ou data-thumb quando src está ausente', () => {
    const imgContainer = document.createElement('div');
    imgContainer.innerHTML = `
      <img data-thumb="https://i.ytimg.com/vi/lazy123/hqdefault.jpg" alt="Lazy">
    `;
    const serialized = serializeLiveDom(imgContainer);
    expect(serialized).toContain('src="https://i.ytimg.com/vi/lazy123/hqdefault.jpg"');
  });

  it('captura do painel: congela o modo HTML, troca canvas por imagem e restaura o DOM', () => {
    document.body.innerHTML = `
      <div data-reveal style="opacity: 0"><canvas width="100" height="100"></canvas></div>
    `;
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const snap = 'data:image/png;base64,' + 'A'.repeat(120);

    const html = serializeLiveDom(null, { capture: { freeze: true, canvasSnapshots: [{ index: 0, dataUrl: snap }] } });

    expect(html).toContain('data-pluck-canvas-img="true"');
    expect(html).toContain(snap);
    expect(html).toContain('opacity: 1');
    expect(html).not.toContain('opacity: 0');
    // o DOM vivo volta como estava: sem a imagem criada e o canvas visível de novo
    expect(document.querySelector('[data-pluck-canvas-img]')).toBeNull();
    expect(canvas.style.display).toBe('');
  });

  it('captura sem freeze serializa como antes (sem trocar canvas)', () => {
    document.body.innerHTML = '<div><canvas width="100" height="100"></canvas></div>';
    const html = serializeLiveDom(null, { capture: { freeze: false } });
    expect(html).not.toContain('data-pluck-canvas-img');
    expect(html).toContain('<canvas');
  });
});
