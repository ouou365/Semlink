# 🧠 Semlink — Agentic Knowledge Workspace

**Deixe o seu Obsidian Vault pensar, colaborar e agir.**

**Português** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Français](README_fr.md) | [Español](README_es.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

O Semlink transforma o seu Vault do Obsidian em um espaço de conhecimento agêntico — um assistente de IA que vive na sua barra lateral, busca tudo o que você já anotou, raciocina sobre isso com ferramentas reais, cita cada afirmação de volta para as suas notas e compartilha o que aprende. O agente inteiro vem dentro do plugin: sem Claude Desktop, sem Cursor, sem terminal, sem nenhum cliente de terceiros para instalar. Traga a sua própria chave — e o seu Vault começa a pensar.

## 🤔 Por que o Semlink?

Você escreve há anos. Aí você faz uma pergunta sobre o seu próprio conhecimento — e o fluxo é: lembrar em qual pasta estava, Ctrl+F, copiar e colar em uma janela de chat, perder o fio da meada.

A maioria dos plugins de IA para Obsidian depende de clientes de agente de terceiros — e esses clientes são aplicações de agente feitas para programação. Você recebe um assistente de programação que dá uma passadinha nas suas notas, não um agente que realmente trabalha dentro delas.

O Semlink foi construído ao contrário:

**O espaço de trabalho é o Vault, e o agente vem integrado de fábrica — não enxertado por fora.** Instale o plugin, cole a sua chave, pergunte. O agente pensa, chama ferramentas, lê as suas notas e responde com citações numeradas — inteiramente dentro do Obsidian. Você não precisa confiar na resposta. Você assiste a ela ser construída — e depois a verifica.

### Semlink vs. Copilot for Obsidian

| | Semlink | Copilot for Obsidian |
|---|---|---|
| Zero ferramentas externas | ✅ Agente, RAG e compartilhamento, tudo integrado ao plugin | ❌ O agente exige opencode, o RAG exige Miyo — instalações separadas |
| Loop de agente (buscar → ler → raciocinar) | ✅ 9 ferramentas, o modelo decide o que ler | 🟡 Roteado através de um cliente externo |
| Transparência do raciocínio | ✅ Pensamento + rastros de ferramentas, transmitidos ao vivo dentro do plugin | 🟡 O loop acontece fora do Obsidian |
| Citações | ✅ Um registro de numeração único por turno; clique em uma citação para saltar para a nota de onde ela veio | 🟡 Notas de origem listadas |
| Compartilhar uma resposta | ✅ Página web na LAN + QR code, revogue quando quiser | ❌ Copiar e colar |
| Outras IAs podem ler o seu Vault (MCP) | ✅ Servidor local integrado | ❌ |

### Escolhas que fizemos de propósito

🧠 **O agente é um residente, não um visitante.** Tudo o que o agente precisa — busca, ferramentas, rastro de raciocínio, citações, compartilhamento — vem no plugin. Clientes de IA externos são bem-vindos via MCP, mas são um bônus opcional, nunca um pré-requisito.

🗄️ **Local-first, estruturalmente.** O seu índice é um arquivo SQLite no seu próprio disco. Não existe servidor do Semlink — não é "prometemos não enviar as suas notas", é que literalmente não há para onde enviá-las.

🔑 **BYOK, sem adivinhação.** Um catálogo com 24 provedores de chat (mais de 1.800 modelos, com preços e janelas de contexto) e um catálogo dedicado de provedores de embedding deixam tudo configurado em poucos cliques; runtimes locais como o Ollama funcionam sem chave alguma. O Semlink não adiciona markup e nunca toca nos seus tokens — o seu provedor cobra você diretamente.

🪟 **Um cidadão do Vault.** Arraste uma nota para o chat para anexá-la, salve respostas de volta como notas, veja o anel de contexto encher em tempo real. A indexação dá passagem enquanto você digita. O espaço de trabalho vive onde as suas notas já vivem — nada para exportar, nada para sincronizar.

## ✨ Funcionalidades marcantes

### 🔗 Citações que você realmente pode seguir

Cada turno usa um único registro de numeração que atravessa o rastro de raciocínio, o corpo da resposta e os cartões de origem — o `[3]` da resposta é o mesmo `[3]` que você viu o modelo ler. Clique em uma citação e o Obsidian abre a nota no exato ponto de onde ela veio. Uma resposta só é tão boa quanto as notas com as quais você pode verificá-la — então, verifique.

### 📡 Compartilhe uma resposta sem exportar nada

Achou algo que vale a pena mostrar? Um clique publica a troca inteira — pergunta, rastro de raciocínio, resposta, cartões de origem — como uma página web limpa na sua LAN. Envie o link ou o QR code; o leitor abre em qualquer navegador, sem Obsidian, sem conta, sem instalação. Pare de compartilhar e a página deixa de existir. Nada nunca sai da sua rede.

### 🪟 Assista o agente trabalhar, ao vivo

A resposta não é a única saída — o raciocínio também é. O pensamento é transmitido conforme acontece, cada chamada de ferramenta (`search_notes` → `get_section` → …) é registrada com o seu resultado, e o anel de contexto mostra quão cheia está a janela do modelo, com a taxa de acerto do cache incluída. Você vê exatamente o que o modelo viu — e é exatamente esse o ponto.

## 🚀 Início rápido

1. **Instale** — com um clique na [página do plugin](https://community.obsidian.md/plugins/semlink), ou busque "Semlink" em Ajustes → Plugins comunitários.
2. **Configure** — escolha provedores no catálogo (ou cole um endpoint personalizado) e adicione a sua API key. O onboarding de três passos valida chat + embedding e inicia a indexação.
3. **Pergunte.** Abra a barra lateral: *"O que eu já escrevi sobre Zettelkasten?"* — e observe: raciocínio → `search_notes` → `get_note` → uma resposta com [1][2][3].

É isso. Sem cliente de agente, sem configuração de servidor. As suas notas nunca são modificadas — o Semlink apenas lê.

## 🧠 Pense — um agente que mostra o trabalho

- **Nove ferramentas integradas**, com o modelo decidindo o que consultar ao responder: busca semântica, leitura de nota, leitura de seção, notas semelhantes, grep com regex, listagens do índice com marcações de tempo, reconhecimento da nota atual. Ele não recupera três chunks e alucina sobre eles; ele busca, lê a seção certa e mostra cada passo.
- **Um raciocínio que você pode inspecionar.** Cada resposta carrega o raciocínio do modelo e cada chamada de ferramenta (`search_notes` → `get_section` → …), transmitidos ao vivo — não uma caixa-preta confiante.
- **Citações que conferem.** Um registro de numeração único por turno atravessa o rastro de raciocínio, o corpo da resposta e os cartões de origem; clique em uma citação para saltar direto para a nota (e a linha) de onde ela veio.
- **Uma busca que alcança tudo**: consulte por significado em todas as notas que você já escreveu, com sugestões de notas semelhantes e grep com regex para quando você *sabe* a string exata.

## 🤝 Colabore — conhecimento que sai do silo (nos seus termos)

- **Compartilhe uma conversa pela sua LAN**: um clique publica as perguntas e respostas em uma página web limpa — envie o link ou o QR code, o leitor abre em qualquer navegador e você revoga o compartilhamento quando quiser. Nada sai da sua rede.
- **Respostas viram notas**: salve qualquer resposta de volta no seu Vault com um clique.
- **Anexe arrastando e soltando**: solte uma nota em qualquer lugar do painel — `[[wiki-links]]` são resolvidos inline — e o agente a lê primeiro.
- **Opcional: deixe as suas outras IAs entrarem.** As mesmas ferramentas vêm como um servidor MCP local, então Claude Desktop, Claude Code e Cursor também podem buscar e citar o seu Vault. Estritamente opcional — o agente integrado não precisa de ajuda.

## ⚡ Aja — controle em tempo real

- **Um painel de RAG, não uma barra de progresso**: métricas do Vault, progresso real de embedding nota por nota e interruptores de índice / auto-embedding que fazem efeito imediatamente — mesmo no meio de uma execução.
- **Reconfigure sem cerimônia**: troque o modelo de embedding e uma reindexação completa começa automaticamente; o guia revalida a sua chave e leva você direto ao passo certo.
- **Indexação em tempo real** que acompanha cada mudança de arquivo enquanto você escreve — e dá passagem enquanto você digita, então o editor nunca engasga.
- **Controle pela paleta de comandos** sobre indexação, MCP, log de depuração e progresso.

## 🔑 BYOK — traga a sua própria chave

Qualquer endpoint compatível com OpenAI ou com Anthropic funciona — DeepSeek, GLM, SiliconFlow, OpenAI, Anthropic, OpenRouter, Ollama, LM Studio e mais de 1.800 outros pelo catálogo integrado. O que importa:

- **Modelo de chat**: escolha no catálogo, com preços e janelas de contexto exibidos, ou adicione um endpoint personalizado (incluindo runtimes locais sem chave)
- **Modelo de embedding**: um catálogo dedicado de provedores de embedding — SiliconFlow BGE-M3 pré-configurado; Jina, Voyage, Nomic, Mixedbread e mais, ou um endpoint de embedding local sem chave
- **As suas chaves, as suas tarifas, troca ilimitada** — o uso dos modelos é cobrado pelo seu provedor; o Semlink nunca vê um centavo disso

## 🌐 MCP — opcional, para as suas outras IAs

O agente integrado é completo por si só. Se você também usa Claude Desktop, Claude Code ou Cursor, as mesmas ferramentas são expostas como um servidor MCP local:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Apenas localhost, chave de acesso opcional. Sem retransmissão na nuvem.

## ❓ FAQ

**Preciso do Claude Desktop, do Cursor ou de qualquer outro cliente de IA?**
Não. O agente completo — rastro de raciocínio, chamadas de ferramentas, citações, compartilhamento — roda dentro do plugin. O MCP existe para que IAs externas *possam* ler o seu Vault, nunca porque precisam.

**Meus dados são enviados a algum lugar?**
O seu índice vive em `data/`, dentro da pasta do plugin, no seu disco. As únicas chamadas de rede vão para os provedores que *você* configura. O compartilhamento pela LAN fica na sua rede. Veja a [política de privacidade](https://getsemlink.com/privacy.html).

**Qual é a diferença para o Copilot for Obsidian?**
O Copilot roteia o agente pelo opencode e o RAG pelo Miyo — ferramentas externas que você instala e executa ao lado do plugin. O Semlink mantém o loop inteiro dentro do Obsidian: você vê o raciocínio e cada chamada de ferramenta, o modelo escolhe quais notas ler e as respostas citam notas específicas que você pode abrir. Se o Copilot funciona para você, fique com ele — o Semlink é para quando você quer o espaço de trabalho, não mais clientes.

**Preciso de uma API key?**
O Semlink é BYOK por design — mas "a sua própria chave" inclui runtimes locais sem chave, como o Ollama, tanto para chat quanto para embeddings. Tiers gratuitos de nuvem (SiliconFlow, Groq…) também funcionam bem.

**Onde fica o índice?**
`data/vault.db` (SQLite) e `data/vectors.bin`, dentro da pasta do plugin. Apague-os e reindexe quando quiser; nada nunca sai da sua máquina.

**Qual modelo devo usar?**
Qualquer modelo de chat de contexto longo que você preferir — as respostas citam as suas notas com generosidade. Embeddings são baratos e pouco frequentes (BGE-M3).

## 📜 Licença

MIT — veja [LICENSE](LICENSE). A licença Pro opcional é uma compra única e nunca uma assinatura.
