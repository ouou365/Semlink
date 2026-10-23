# 🧠 Semlink — Pergunte ao seu Vault. Veja-o pensar.

**Português** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Français](README_fr.md) | [Español](README_es.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

Um plugin do Obsidian que transforma anos de notas em um espaço de conhecimento agêntico: um agente de IA transparente que vive onde você escreve, busca tudo o que você já anotou, raciocina sobre isso com ferramentas reais e responde com citações numeradas nas quais você pode clicar.

**Agente dentro do seu Vault • Raciocínio + chamadas de ferramentas visíveis • Citações clicáveis • Índice SQLite local — sem servidor • Qualquer provedor compatível com OpenAI/Anthropic • MCP para Claude e Cursor • 11 idiomas • Núcleo grátis, Pro com pagamento único**

<br>

Site oficial: [getsemlink.com](https://getsemlink.com) · [Licença Pro — $3 preço de lançamento](https://getsemlink.com) · [Issues](https://github.com/ouou365/Semlink/issues)

🤔 Por que o Semlink? | 🚀 Início rápido | ✨ Funcionalidades | 🤖 Traga o seu próprio modelo | 🌐 MCP | ❓ FAQ

← Se o Semlink conquistar um lugar na sua barra lateral, deixe uma estrela ⭐ — é o único marketing que um plugin indie tem.

## 🤔 Por que o Semlink?

Você escreve há anos. Aí precisa fazer uma pergunta sobre o seu próprio conhecimento — e o fluxo é: lembrar em qual pasta estava, Ctrl+F, copiar e colar em uma janela de chat, perder o fio da meada.

Outros plugins de IA para Obsidian conversam com as suas notas. O que eles não mostram é o trabalho. A maioria dos plugins RAG recupera alguns chunks atrás de uma caixa-preta e responde mesmo assim — chunks errados, tom confiante. O Smart Connections encontra notas relacionadas, mas nunca responde. O Omnisearch para nas palavras-chave. E o caminho "sério" — colar notas no ChatGPT ou comandar o Claude Code pelo terminal — significa que o seu conhecimento vive em algum lugar fora do seu editor.

O Semlink foi construído ao contrário:

**O agente vive dentro do seu Vault — e você o vê trabalhar.** Cada resposta vem com o processo de raciocínio do modelo, todas as chamadas de ferramentas que ele fez (`search_notes` → `get_note` → …) e citações numeradas que apontam de volta para as suas próprias notas. Você não precisa confiar na resposta. Você a verifica.

### Como nos comparamos

| | Semlink | RAG estilo Copilot | Smart Connections | Omnisearch | ChatGPT / Claude Code |
|---|---|---|---|---|---|
| Onde a IA vive | ✅ Dentro do Obsidian | 🟡 Só painel de chat | 🟡 Só notas relacionadas | 🟡 Só caixa de busca | ❌ Navegador / terminal |
| Loop de agente (buscar → ler → raciocinar) | ✅ 9 ferramentas, o modelo decide | ❌ Recuperação fixa de chunks | ❌ Sem perguntas e respostas | ❌ | ✅ mas fora do seu editor |
| Transparência do raciocínio | ✅ Raciocínio + rastros de ferramentas | ❌ Caixa-preta | — | — | 🟡 Histórico do terminal |
| Citações para as suas notas | ✅ Numeradas, clicáveis | 🟡 Referências a chunks | ❌ | ❌ | ❌ |
| Local do índice | ✅ SQLite local, sem servidor | ✅ Local | ✅ Local | ✅ Local | — |
| Outras IAs podem ler o seu Vault (MCP) | ✅ Integrado | ❌ | ❌ | ❌ | 🟡 Via terminais |
| Preços | ✅ Núcleo grátis + Pro único | BYOK | Grátis | Grátis | Assinatura |

### Três decisões que tomamos de propósito

🗄️ **Local-first, estruturalmente.** O seu índice é um arquivo SQLite no seu próprio disco. Não existe servidor do Semlink — não é "prometemos não enviar as suas notas", é que literalmente não há para onde enviá-las.

🔌 **Qualquer modelo pelo qual você já paga.** DeepSeek, GLM, SiliconFlow, OpenAI, Claude, Ollama, LM Studio — qualquer endpoint compatível com OpenAI ou Anthropic. O Semlink não adiciona markup e nunca toca nos seus tokens; o uso é cobrado pelo seu provedor, diretamente a você.

🪟 **Um cidadão do Vault.** Arraste uma nota para o chat para anexá-la, salve respostas de volta como notas, veja o anel de contexto encher em tempo real. A indexação dá passagem enquanto você digita. O agente trabalha onde as suas notas já vivem — nada para exportar, nada para sincronizar.

## 🎯 É para mim?

**✅ Sim, se você:**

- Tem meses (ou anos) de notas e quer *fazer perguntas* a elas em linguagem natural
- Quer um raciocínio que você pode inspecionar — pensamento, chamadas de ferramentas, citações — não uma caixa-preta confiante
- Se importa que as suas notas nunca saiam da sua máquina
- Já tem uma API key de LLM (ou roda um modelo local) e detesta markups de intermediários
- Usa Claude Desktop, Claude Code ou Cursor — e quer que eles também leiam o seu Vault

**❌ Não, se você:**

- Quer um substituto geral do ChatGPT — o Semlink responde a partir do seu Vault, não da internet
- Espera configuração zero — você vai precisar de uma API key de embedding e de uma chave de modelo de chat (tiers gratuitos funcionam)
- Precisa de colaboração em equipe ou sincronização na nuvem — não existe backend, por design

## 🚀 Início rápido

1. **Instale** — com um clique na [página do plugin](https://community.obsidian.md/plugins/semlink), ou busque "Semlink" em Ajustes → Plugins comunitários.
2. **Configure** — cole uma API key de embedding (SiliconFlow BGE-M3 pré-configurado) e uma chave de provedor de chat. O onboarding de três passos valida as duas e inicia a indexação.
3. **Pergunte.** Abra a barra lateral: *"O que eu já escrevi sobre Zettelkasten?"* — e observe: raciocínio → `search_notes` → `get_note` → uma resposta com [1][2][3].

É isso. As suas notas nunca são modificadas — o Semlink apenas lê.

## ✨ Funcionalidades

### 🕵️ Um agente que usa ferramentas, não um chatbot

Nove ferramentas integradas — busca semântica, leitura de nota, leitura de seção, notas semelhantes, grep com regex, listagem do índice (com marcações de tempo), reconhecimento da nota atual — e o modelo decide o que consultar ao responder. Ele não recupera três chunks e alucina sobre eles; ele busca, lê a seção certa e mostra cada passo.

### 🔍 Busca semântica que alcança tudo

Consulte por significado, não por palavras-chave — uma consulta em linguagem natural alcança cada nota que você já escreveu. Sugestões de notas semelhantes e grep com regex estão lá para quando você *sabe* a string exata.

### 🪟 Um cidadão do Vault

- **Arrastar e soltar**: solte uma nota em qualquer lugar do painel para anexá-la — `[[wiki-links]]` são resolvidos inline
- **Salve respostas como notas**: um clique, de volta ao seu Vault
- **Contexto que você pode ver**: um anel de contexto ao vivo mostra quão cheia está a janela do modelo, com a taxa de acerto do cache ao lado — assim você sabe por que uma resposta ficou rasa antes de culpar o modelo
- **Cartões de perguntas da tela inicial**: prompts de exemplo curados, alguns extraídos das suas próprias notas recentes

### ⚡ Indexação em tempo real

Mudanças em arquivos são detectadas automaticamente e reprocessadas enquanto você escreve — e a indexação dá passagem quando você está trabalhando, então o editor nunca engasga.

### 🌍 11 idiomas

English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português, Italiano, Русский — escolha em Configurações → Geral.

## 🤖 Traga o seu próprio modelo

Qualquer endpoint compatível com OpenAI ou Anthropic funciona: DeepSeek (pré-configurado), SiliconFlow, GLM, OpenAI, Anthropic, Ollama, LM Studio, OpenRouter — as suas chaves, as suas tarifas, troca ilimitada. O que importa:

- **Modelo de chat**: contexto longo ajuda — as respostas citam as suas notas com generosidade
- **Modelo de embedding**: BGE-M3 (1024 dimensões) pré-configurado via SiliconFlow; qualquer endpoint de embedding compatível funciona
- O uso dos modelos é cobrado pelo seu provedor — o Semlink nunca vê um centavo disso

## 🌐 MCP — dê memória às suas outras IAs

As mesmas ferramentas são entregues como um servidor MCP local, para que Claude Desktop, Claude Code e Cursor também possam buscar e citar o seu Vault:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Apenas localhost, chave de acesso opcional. Sem retransmissão na nuvem.

## ⭐ Pro — grátis onde importa

O núcleo é grátis para sempre, prometido dentro do próprio app: busca semântica, chat com o agente completo, indexação, MCP — ilimitado, sem cronômetro de teste. Os tokens dos modelos são cobrados pelo seu provedor, nunca por nós.

O [Pro](https://getsemlink.com) é uma **licença única** (sem assinatura): histórico de conversas ilimitado, mais gerenciamento de histórico — busca, fixação, pastas.

## ❓ FAQ

**Meus dados são enviados a algum lugar?**
O seu índice vive em `data/`, dentro da pasta do plugin, no seu disco. As únicas chamadas de rede vão para os provedores que *você* configura. Veja a [política de privacidade](https://getsemlink.com/privacy.html).

**Qual é a diferença para o Copilot for Obsidian?**
Transparência e o loop de agente: você vê o raciocínio e cada chamada de ferramenta, o modelo escolhe quais notas ler e as respostas citam notas específicas que você pode abrir. Se o Copilot funciona para você, mantenha-o — o Semlink é para quando você quer assistir ao trabalho.

**Preciso de uma API key?**
Sim — o Semlink é bring-your-own-key por design. Tiers gratuitos (SiliconFlow, Groq…) funcionam bem tanto para embedding quanto para chat.

**Onde fica o índice?**
`data/vault.db` (SQLite) e `data/vectors.bin`, dentro da pasta do plugin. Apague-os e reindexe quando quiser; nada nunca sai da sua máquina.

**Qual modelo devo usar?**
Qualquer modelo de chat de contexto longo que você preferir — as respostas citam as suas notas com generosidade. Embeddings são baratos e pouco frequentes (BGE-M3).

## 🛠 Comandos

| Comando | O que faz |
|---|---|
| Semlink: Open Search | Abre o painel de chat na barra lateral |
| Semlink: Full Reindex | Reescaneia todos os arquivos |
| Semlink: Resume / Pause Index | Controla a indexação |
| Semlink: Start/Stop MCP Service | Liga/desliga o servidor MCP |
| Semlink: Toggle Debug Logging | Diagnósticos detalhados no console |
| Semlink: View Index Progress | Abre o painel de progresso |

## 📜 Licença

MIT — veja [LICENSE](LICENSE). A licença Pro opcional é uma compra única e nunca uma assinatura.
