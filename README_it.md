# 🧠 Semlink — Chiedi al tuo vault. Guardalo ragionare.

**Italiano** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Français](README_fr.md) | [Español](README_es.md) | [Português](README_pt.md) | [Русский](README_ru.md)

Un plugin per Obsidian che trasforma anni di note in uno spazio di lavoro conoscitivo agentico: un agente AI trasparente che vive dove scrivi, cerca tutto ciò che hai mai annotato, ragiona sopra con veri strumenti e risponde con citazioni numerate su cui puoi cliccare.

**Agente dentro il tuo Vault • Ragionamento e chiamate agli strumenti, visibili • Citazioni cliccabili • Indice SQLite locale — nessun server • Qualsiasi provider compatibile OpenAI/Anthropic • MCP per Claude e Cursor • 11 lingue • Nucleo gratuito, Pro una tantum**

<br>

Sito ufficiale: [getsemlink.com](https://getsemlink.com) · [Licenza Pro — early bird 3 $](https://getsemlink.com) · [Segnalazioni](https://github.com/ouou365/Semlink/issues)

🤔 Perché Semlink? | 🚀 Inizio rapido | ✨ Funzionalità | 🤖 Porta il tuo modello | 🌐 MCP | ❓ FAQ

← Se Semlink si guadagna un posto nella tua barra laterale, lascia una stella ⭐ — è l'unico marketing che ha un plugin indipendente.

## 🤔 Perché Semlink?

Scrivi da anni. Poi fai una domanda sulle tue stesse conoscenze — e il flusso è: ricordare in quale cartella, Ctrl+F, copia-incolla in una finestra di chat, perdere il filo.

Gli altri plugin AI per Obsidian chattano con le tue note. Quello che non ti mostrano è il lavoro. La maggior parte dei plugin RAG recupera qualche chunk dietro una scatola nera e risponde comunque — chunk sbagliati, tono sicuro di sé. Smart Connections trova le note correlate ma non risponde mai. Omnisearch si ferma alle parole chiave. E la via "seria" — incollare le note in ChatGPT o pilotare Claude Code da un terminale — significa che le tue conoscenze vivono da qualche parte che non è il tuo editor.

Semlink è costruito nel modo opposto:

**L'agente vive dentro il tuo Vault — e tu lo guardi lavorare.** Ogni risposta arriva con il processo di ragionamento del modello, ogni chiamata agli strumenti che ha fatto (`search_notes` → `get_note` → …) e citazioni numerate che rimandano alle tue stesse note. Non devi fidarti della risposta. La controlli.

### Come ci confrontiamo

| | Semlink | RAG in stile Copilot | Smart Connections | Omnisearch | ChatGPT / Claude Code |
|---|---|---|---|---|---|
| Dove vive l'AI | ✅ Dentro Obsidian | 🟡 Solo pannello di chat | 🟡 Solo note correlate | 🟡 Solo casella di ricerca | ❌ Browser / terminale |
| Ciclo agent (cerca → leggi → ragiona) | ✅ 9 strumenti, decide il modello | ❌ Recupero fisso di chunk | ❌ Nessuna Q&A | ❌ | ✅ ma fuori dal tuo editor |
| Trasparenza del ragionamento | ✅ Ragionamento + tracce degli strumenti | ❌ Scatola nera | — | — | 🟡 Scrollback del terminale |
| Citazioni nelle tue note | ✅ Numerate, cliccabili | 🟡 Riferimenti a chunk | ❌ | ❌ | ❌ |
| Dove risiede l'indice | ✅ SQLite locale, nessun server | ✅ Locale | ✅ Locale | ✅ Locale | — |
| Altre AI possono leggere il tuo Vault (MCP) | ✅ Integrato | ❌ | ❌ | ❌ | 🟡 Tramite terminali |
| Prezzi | ✅ Nucleo gratuito + Pro una tantum | BYOK | Gratis | Gratis | Abbonamento |

### Tre scelte fatte apposta

🗄️ **Local-first, per struttura.** L'indice è un file SQLite sul tuo disco. Non esiste alcun server Semlink — non "promettiamo di non caricare le tue note": letteralmente non c'è niente su cui caricarle.

🔌 **Qualsiasi modello che già paghi.** DeepSeek, GLM, SiliconFlow, OpenAI, Claude, Ollama, LM Studio — qualsiasi endpoint compatibile OpenAI o Anthropic. Semlink non applica alcun ricarico e non tocca mai i tuoi token; l'utilizzo è fatturato dal tuo provider, direttamente a te.

🪟 **Un cittadino del Vault.** Trascina una nota nella chat per allegarla, salva le risposte come note, guarda l'anello del contesto riempirsi in tempo reale. L'indicizzazione si mette da parte mentre scrivi. L'agente lavora dove le tue note vivono già — niente da esportare, niente da sincronizzare.

## 🎯 Fa per me?

**✅ Sì, se tu:**

- Hai mesi (o anni) di note e vuoi *farle* domande in linguaggio naturale
- Vuoi un ragionamento che puoi ispezionare — pensiero, chiamate agli strumenti, citazioni — non una scatola nera sicura di sé
- Ti importa che le tue note non lascino mai il tuo computer
- Hai già una API key per un LLM (o usi un modello locale) e detesti i ricarichi degli intermediari
- Usi Claude Desktop, Claude Code o Cursor — e vuoi che leggano anche il tuo Vault

**❌ No, se tu:**

- Cerchi un sostituto generale di ChatGPT — Semlink risponde dal tuo Vault, non da internet
- Ti aspetti zero configurazione — ti serviranno una API key di embedding e una chiave per il modello di chat (vanno bene i piani gratuiti)
- Ti serve collaborazione di team o sincronizzazione cloud — non c'è alcun backend, per design

## 🚀 Inizio rapido

1. **Installa** — con un clic dalla [pagina del plugin](https://community.obsidian.md/plugins/semlink), o cerca "Semlink" in Impostazioni → Plugin community.
2. **Configura** — incolla una API key di embedding (SiliconFlow BGE-M3 preconfigurato) e una chiave del provider di chat. Il percorso di benvenuto in tre passaggi valida entrambe e avvia l'indicizzazione.
3. **Chiedi.** Apri la barra laterale: *"Cosa ho scritto sullo Zettelkasten?"* — poi guarda: ragionamento → `search_notes` → `get_note` → una risposta con [1][2][3].

Questo è tutto. Le tue note non vengono mai modificate — Semlink legge soltanto.

## ✨ Funzionalità

### 🕵️ Un agente che usa gli strumenti, non un chatbot

Nove strumenti integrati — ricerca semantica, lettura della nota, lettura della sezione, note simili, grep con regex, elenco indicizzato (con marche temporali), consapevolezza della nota corrente — e il modello decide cosa consultare mentre risponde. Non recupera tre chunk e allucina sopra; cerca, legge la sezione giusta e mostra ogni passaggio.

### 🔍 Una ricerca semantica che arriva ovunque

Interroga per significato, non per parole chiave — una sola query in linguaggio naturale tocca ogni nota che hai mai scritto. I suggerimenti di note simili e il grep con regex sono lì per quando *conosci* davvero la stringa esatta.

### 🪟 Un cittadino del Vault

- **Trascina e rilascia**: rilascia una nota in un punto qualsiasi del pannello per allegarla — i `[[wiki-link]]` si risolvono in linea
- **Salva le risposte come note**: un clic, di nuovo dentro il tuo Vault
- **Contesto visibile**: un anello del contesto in tempo reale mostra quanto è piena la finestra del modello, con il rate di cache hit accanto — così capisci perché una risposta è diventata superficiale prima di dare la colpa al modello
- **Schede di domande iniziali**: prompt di esempio curati, alcuni tratti dalle tue stesse note recenti

### ⚡ Indicizzazione in tempo reale

Le modifiche ai file vengono rilevate automaticamente e ri-elaborate mentre scrivi — e l'indicizzazione si mette da parte mentre lavori, così l'editor non scatta mai.

### 🌍 11 lingue

English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português, Italiano, Русский — scegli in Impostazioni → Generale.

## 🤖 Porta il tuo modello

Funziona qualsiasi endpoint compatibile OpenAI o Anthropic: DeepSeek (preconfigurato), SiliconFlow, GLM, OpenAI, Anthropic, Ollama, LM Studio, OpenRouter — le tue chiavi, le tue tariffe, cambio illimitato. Ciò che conta:

- **Modello di chat**: un contesto lungo aiuta — le risposte citano le tue note ampiamente
- **Modello di embedding**: BGE-M3 (1024 dimensioni) preconfigurato via SiliconFlow; va bene qualsiasi endpoint di embedding compatibile
- L'utilizzo dei modelli è fatturato dal tuo provider — Semlink non ne vede nemmeno un centesimo

## 🌐 MCP — dai una memoria alle tue altre AI

Gli stessi strumenti sono disponibili come server MCP locale, così anche Claude Desktop, Claude Code e Cursor possono cercare e citare il tuo Vault:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Solo localhost, chiave di accesso opzionale. Nessun relay nel cloud.

## ⭐ Pro — gratis dove conta

Il nucleo è gratuito per sempre, promesso dentro l'app stessa: ricerca semantica, chat con l'agente completo, indicizzazione, MCP — illimitati, senza timer di prova. I token dei modelli sono fatturati dal tuo provider, mai da noi.

[Pro](https://getsemlink.com) è una **licenza una tantum** (nessun abbonamento): cronologia chat illimitata più gestione della cronologia — ricerca, fissaggio, cartelle.

## ❓ FAQ

**I miei dati vengono inviati da qualche parte?**
Il tuo indice vive in `data/` dentro la cartella del plugin, sul tuo disco. Le uniche chiamate di rete vanno ai provider che configuri *tu*. Consulta l'[informativa sulla privacy](https://getsemlink.com/privacy.html).

**In che cosa è diverso da Copilot for Obsidian?**
Trasparenza e ciclo dell'agente: vedi il ragionamento e ogni chiamata agli strumenti, il modello sceglie quali note leggere e le risposte citano note specifiche che puoi aprire. Se Copilot ti funziona, tienilo — Semlink è per quando vuoi guardare il lavoro.

**Serve una API key?**
Sì — Semlink è bring-your-own-key per design. I piani gratuiti (SiliconFlow, Groq…) funzionano bene sia per l'embedding sia per la chat.

**Dove vive l'indice?**
`data/vault.db` (SQLite) e `data/vectors.bin` dentro la cartella del plugin. Eliminali e reindicizza quando vuoi; niente lascia mai il tuo computer.

**Quale modello dovrei usare?**
Qualsiasi modello di chat a contesto lungo ti piaccia — le risposte citano le tue note ampiamente. Gli embedding sono economici e poco frequenti (BGE-M3).

## 🛠 Comandi

| Comando | A cosa serve |
|---|---|
| Semlink: Apri la barra laterale di Ricerca semantica | Apre il pannello di chat laterale |
| Semlink: Reindicizzazione completa | Ripete la scansione di tutti i file |
| Semlink: Avvia indice / Metti in pausa l'indice | Controlla l'indicizzazione |
| Semlink: Avvia/Arresta servizio MCP | Attiva/disattiva il server MCP |
| Semlink: Attiva/disattiva log di debug | Diagnostica dettagliata nella console |
| Semlink: Visualizza avanzamento indice | Apre il pannello di avanzamento |

## 📜 Licenza

MIT — vedi [LICENSE](LICENSE). La licenza Pro opzionale è un acquisto una tantum e mai un abbonamento.
