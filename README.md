# PokeMulti

Programa para Windows que abre até 4 contas do pokeidle.io em uma janela, com Sniper do Mercado, histórico de preços, Precificador de pokémon e a hunt que mais rende para o seu pokémon.

**[Baixar a última versão](https://github.com/negronesdev/pokemulti/releases/latest/download/PokeMulti-Setup.exe)** · [Site](https://pokemulti.app) · [Código do programa](codigo) · [Todas as versões](https://github.com/negronesdev/pokemulti/releases) · [Termos de uso](https://pokemulti.app/termos.html)

## Como funciona

1. Baixe e instale. É grátis, sem cadastro, e os primeiros 7 dias são de Premium, com todos os recursos.
2. Entre nas suas contas, na própria página do jogo, dentro do programa. Os logins ficam só no seu PC.
3. Depois dos 7 dias, o programa continua grátis, só com o jogo nas 4 contas. Para manter as ferramentas (Sniper, monitores do Mercado, Precificador, lives e as outras), ele mostra o valor da mensalidade e o QR do Pix. Envie o comprovante pelo WhatsApp ou pelo Instagram, e você recebe uma key que libera o Premium por 30 dias.

## O código está aberto para você conferir

A pasta [`codigo`](codigo) tem o código do programa, o mesmo que vira o instalador. Qualquer pessoa pode ler e conferir o que ele faz:

- Você entra na própria página do jogo, dentro do programa. O programa não pede e não guarda a sua senha.
- Os logins e os ajustes ficam na pasta `Documentos\PokeMulti-dados`, no seu PC. Não temos servidor, e nada é enviado para nós.
- Ele se conecta com o jogo; com a Twitch, a Kick e o TopIdle, se você usar as lives e o aviso de voto; com o GitHub, para saber se saiu versão nova; com `pokeidle.io` e `cloudflare.com`, só para conferir a data; e com a rede Solana, só se você ligar o monitor do caixa.

O instalador é feito a partir desse código, com os comentários retirados e o código compactado. Se preferir, rode direto do código: instale o [Node.js](https://nodejs.org), abra um terminal na pasta `codigo` e rode `npm install` e depois `npm start`.

Para conferir se o instalador que você baixou é o original, compare a impressão digital dele. No PowerShell, na pasta do download, rode `Get-FileHash .\PokeMulti-Setup.exe`. A da versão 1.2.0 é esta (maiúsculas ou minúsculas, tanto faz):

`0c635f5313fb576dd2f023cc7ea343e344cda955f5e1237a5c507efbf04d258d`

## O Windows mostrou um aviso

O instalador ainda não tem certificado pago. Se aparecer "O Windows protegeu o computador", clique em **Mais informações** e em **Executar assim mesmo**.

## Requisitos

- Windows 10 ou 11, 64 bits
- 8 GB de memória ou mais

## Antes de usar

- É uma ferramenta independente, sem vínculo, patrocínio ou autorização do pokeidle.io, da Nintendo, da Game Freak, da Creatures ou da The Pokémon Company.
- A moderação do jogo decide sobre a sua conta, e as regras podem mudar. Não dá para garantir nada sobre ela.
- Não há promessa de ganho. As compras feitas pelo Sniper e pela Reposição são reais.
- O jogo é só para maiores de 18 anos, e o PokeMulti também.

## Direitos

O código está aberto para leitura e conferência, e você pode rodá-lo no seu PC. Todos os direitos são reservados: não é permitido redistribuir, vender ou publicar cópias do programa, alteradas ou não. O arquivo `codigo/qrcode.js` é de Kazuhiko Arase, com licença MIT, e mantém o aviso original. O cálculo do Precificador (`codigo/precificador.js`) vem do [Precificador de Pokémon](https://github.com/briaoAle/precificador-pokemon) de briaoAle, com licença MIT, e o aviso original está no fim do arquivo.
