import { describe, it, expect, vi } from 'vitest';
import {
  SessionRecorder,
  normalizePageUrlForSession,
  formatNavigationErrorMessage
} from './session-recorder';
import { CdpNetworkRecorder } from './cdp-recorder';

describe('SessionRecorder: Gravação manual e detecção de navegação', () => {
  it('normaliza URLs para sessão ignorando hashes de âncoras', () => {
    expect(normalizePageUrlForSession('https://getartcraft.com/#hero')).toBe('https://getartcraft.com/');
    expect(normalizePageUrlForSession('https://getartcraft.com/sobre#equipe')).toBe('https://getartcraft.com/sobre');
    expect(normalizePageUrlForSession('https://getartcraft.com/')).toBe('https://getartcraft.com/');
  });

  it('formata mensagem de erro amigável ao mudar de página conforme SPEC-v12', () => {
    const msg = formatNavigationErrorMessage('https://getartcraft.com/pricing');
    expect(msg).toBe('A gravação vale só para a página onde começou. Você saiu de getartcraft.com/pricing.');

    const msgRoot = formatNavigationErrorMessage('https://outrodominio.com/');
    expect(msgRoot).toBe('A gravação vale só para a página onde começou. Você saiu de outrodominio.com.');
  });

  it('inicia gravação e permite navegações internas de âncora/hash na mesma página', async () => {
    const session = new SessionRecorder();
    await session.start(123, 'https://getartcraft.com/');

    expect(session.isRecording()).toBe(true);

    const nav1 = session.handlePotentialNavigation('https://getartcraft.com/#section-features');
    expect(nav1.allowed).toBe(true);
    expect(nav1.navigatedAway).toBe(false);
    expect(session.isRecording()).toBe(true);
  });

  it('trava gravação e notifica callback ao navegar para outra página/endereço', async () => {
    const session = new SessionRecorder();
    const onNavAway = vi.fn();

    await session.start(123, 'https://getartcraft.com/', onNavAway);

    const navRes = session.handlePotentialNavigation('https://getartcraft.com/docs');
    expect(navRes.allowed).toBe(false);
    expect(navRes.navigatedAway).toBe(true);
    expect(navRes.errorMessage).toContain('A gravação vale só para a página onde começou.');
    expect(navRes.errorMessage).toContain('Você saiu de getartcraft.com/docs.');

    expect(onNavAway).toHaveBeenCalledWith(navRes.errorMessage, expect.objectContaining({
      navigatedAway: true,
      navigatedToUrl: 'https://getartcraft.com/docs'
    }));

    expect(session.isRecording()).toBe(false);
    const state = session.getState();
    expect(state.navigatedAway).toBe(true);
  });

  it('coleta recursos gravados ao parar (Salvar o que já gravei)', async () => {
    const mockCdpRecorder = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      collectResources: vi.fn().mockResolvedValue([
        { url: 'https://getartcraft.com/menu.svg', mimeType: 'image/svg+xml', statusCode: 200, data: 'svg' }
      ])
    } as unknown as CdpNetworkRecorder;

    const session = new SessionRecorder();
    await session.start(123, 'https://getartcraft.com/', undefined, mockCdpRecorder);

    session.handlePotentialNavigation('https://getartcraft.com/outra-pagina');

    const result = await session.stop();
    expect(result.navigatedAway).toBe(true);
    expect(result.errorMessage).toContain('A gravação vale só para a página onde começou.');
    expect(result.resources.length).toBe(1);
    expect(result.resources[0].url).toBe('https://getartcraft.com/menu.svg');
  });

  it('reseta a gravação para permitir recomeçar limpo', async () => {
    const session = new SessionRecorder();
    await session.start(123, 'https://getartcraft.com/');
    session.handlePotentialNavigation('https://outro.com');
    expect(session.getState().navigatedAway).toBe(true);

    session.reset();
    expect(session.getState().navigatedAway).toBe(false);
    expect(session.getState().isRecording).toBe(false);
    expect(session.getState().startUrl).toBe('');
  });
});
