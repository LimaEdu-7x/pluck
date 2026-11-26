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
});
