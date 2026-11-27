# Política de privacidade do Pluck e do Pagefold

Última atualização: 27 de novembro de 2026

O Pluck é uma extensão para Chrome e Edge que salva a página aberta para ver offline. Esta política vale para as duas edições: a **Pagefold**, publicada na Chrome Web Store, e o **Pluck**, a edição completa distribuída pelo GitHub. Onde está escrito "Pluck", leia também "Pagefold".

## Resumo

- **Nada sai do seu navegador.** O Pluck não tem servidor, não cria conta, não usa analytics, não mostra anúncios e não vende nem compartilha dados.
- O Pluck só lê a página quando **você** inicia uma captura.
- O arquivo gerado vai para a sua pasta de downloads e fica só com você.

## O que o Pluck lê

Quando você inicia uma captura, o Pluck lê, só na aba que você escolheu:

- o endereço (URL) e o título da página, para mostrar no painel qual página será salva;
- o conteúdo da página (HTML, estilos, fontes, imagens e, conforme o modo, vídeos e áudios), para montar a cópia offline;
- no modo Site inteiro (edição completa), as páginas internas do mesmo site, até o limite que você escolher.

## O que o Pluck faz com isso

- Monta o arquivo (ZIP ou HTML) **dentro do seu navegador**.
- Antes de salvar, **apaga senhas, dados digitados em formulários e tokens de acesso nos endereços**.
- Guarda o arquivo gerado só na memória enquanto o painel estiver aberto (para você poder baixar de novo) e o descarta quando você volta ao início ou fecha o painel.
- Não guarda histórico de navegação nem lista de páginas salvas.

## Conexões de rede

Para montar a cópia, o Pluck baixa os arquivos que compõem a página (estilos, fontes, imagens, mídias) diretamente dos sites de onde eles vêm, como o seu navegador já faz ao exibir a página. O Pluck não envia o conteúdo da página, o endereço nem qualquer outro dado seu a nenhum servidor próprio ou de terceiros.

## Permissões

| Permissão | Para quê |
|---|---|
| Painel lateral (`sidePanel`) | mostrar a interface do Pluck ao lado da página |
| Aba ativa (`activeTab`) e abas (`tabs`) | saber qual página você quer salvar e perceber quando você troca de aba ou de endereço |
| Execução de script (`scripting`) | ler o conteúdo da página e rolá-la para carregar o que aparece sob demanda |
| Downloads (`downloads`) | salvar o arquivo gerado na sua pasta de downloads |
| Acesso aos sites | baixar os arquivos que compõem a página salva. Na Pagefold é opcional e só é pedido no primeiro clique em arquivar |
| Depurador (`debugger`), só na edição completa | Modo Fiel: ler a página viva pelo Chrome DevTools Protocol para uma cópia mais fiel. O navegador mostra um aviso enquanto ele está ativo, e ele é desligado ao terminar |

## Uso limitado

O uso de informações recebidas pelas APIs do Chrome segue a Política de Dados do Usuário da Chrome Web Store, incluindo os requisitos de Uso Limitado (Limited Use). Os dados da página são usados só para gerar o arquivo que você pediu, nunca para publicidade, perfil de usuário ou qualquer outra finalidade, e nunca são transferidos a terceiros.

## Conteúdo de terceiros

Você é responsável por salvar só o que tem direito de guardar. O Pluck não contorna login, paywall nem proteção de conteúdo (DRM): ele salva apenas o que você já consegue ver na página.

## Crianças

O Pluck não é direcionado a crianças e não coleta dados de ninguém.

## Mudanças

Se esta política mudar, a nova versão será publicada neste mesmo endereço, com a data atualizada no topo.

## Contato

Dúvidas: abra uma issue em https://github.com/LimaEdu-7x/pluck/issues

---

# Pluck privacy policy (English)

Last updated: November 27, 2026

Pluck is a Chrome and Edge extension that saves the open web page for offline viewing. This policy covers both editions: **Pagefold**, published on the Chrome Web Store, and **Pluck**, the full edition distributed on GitHub. Wherever it says "Pluck", read "Pagefold" as well.

- **Nothing leaves your browser.** Pluck has no server, no accounts, no analytics, no ads, and does not sell or share any data.
- Pluck reads a page only when **you** start a capture, and only in the tab you chose: its URL and title (to show which page will be saved) and its content (HTML, styles, fonts, images and, depending on the mode, video and audio). In the full edition's "Whole site" mode it also reads internal pages of the same site, up to the limit you set.
- The archive (ZIP or HTML) is built inside your browser. **Passwords, form input and access tokens in URLs are removed before saving.** The file is kept in memory only while the panel is open and is then discarded. No browsing history or list of saved pages is stored.
- To build the copy, Pluck downloads the files that make up the page directly from the sites they come from. It never sends page content, URLs or any other data to its own or third-party servers.
- Permissions: `sidePanel` (interface), `activeTab` and `tabs` (know which page to save and notice tab or address changes), `scripting` (read and scroll the page), `downloads` (save the archive), site access (download the page's files), and, in the full edition only, `debugger` (Faithful Mode via the Chrome DevTools Protocol; the browser shows a notice while it is active).
- **Limited Use:** the use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. Page data is used only to produce the file you requested and is never used for advertising or profiling, nor transferred to third parties.
- Pluck does not bypass logins, paywalls or DRM; it saves only what you can already see. You are responsible for saving only content you have the right to keep.
- Pluck is not directed at children and collects no data from anyone.
- Changes to this policy will be published at this same address with an updated date.
- Contact: https://github.com/LimaEdu-7x/pluck/issues
