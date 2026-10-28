# 🧠 Semlink — Agentic Knowledge Workspace (spazio di lavoro conoscitivo agentico)

**Lascia che il tuo Vault di Obsidian pensi, collabori e agisca.**

**Italiano** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Français](README_fr.md) | [Español](README_es.md) | [Português](README_pt.md) | [Русский](README_ru.md)

Semlink trasforma il tuo vault di Obsidian in uno spazio di lavoro conoscitivo agentico — un assistente AI che vive nella tua barra laterale, cerca tutto ciò che hai mai annotato, ragiona sui tuoi appunti con veri strumenti, riporta ogni affermazione alle tue note con citazioni e condivide ciò che impara. L'intero agente è incluso nel plugin: niente Claude Desktop, niente Cursor, niente terminale, nessun client di terze parti da installare. Porta la tua API key, e il tuo vault comincia a pensare.


![Semlink — agentic knowledge workspace living in the Obsidian sidebar](assets/screenshot-overview.png)

## 🤔 Perché Semlink?

Scrivi da anni. Poi fai una domanda sulle tue stesse conoscenze — e il flusso è: ricordare in quale cartella, Ctrl+F, copia-incolla in una finestra di chat, perdere il filo.

La maggior parte dei plugin AI per Obsidian dipende da client agentici di terze parti — e quei client sono applicazioni agentiche pensate per la programmazione. Ti ritrovi un assistente di coding che fa capolino sulle tue note, non un agente che lavora davvero dentro di esse.

Semlink è costruito nel modo opposto:

**Lo spazio di lavoro è il vault, e l'agente è integrato — non aggiunto dall'esterno.** Installa il plugin, incolla la tua chiave, chiedi. L'agente pensa, chiama gli strumenti, legge le tue note e risponde con citazioni numerate — interamente dentro Obsidian. Non devi fidarti della risposta. La guardi prendere forma, poi la verifichi.

### Semlink vs. Copilot for Obsidian

| | Semlink | Copilot for Obsidian |
|---|---|---|
| Zero strumenti esterni | ✅ Agente, RAG e condivisione tutti integrati nel plugin | ❌ L'agente richiede opencode, la RAG richiede Miyo — installazioni separate |
| Ciclo dell'agente (cerca → leggi → ragiona) | ✅ 9 strumenti, il modello decide cosa leggere | 🟡 Instradato tramite un client esterno |
| Trasparenza del ragionamento | ✅ Ragionamento + tracce degli strumenti, in streaming live dentro il plugin | 🟡 Il ciclo avviene fuori da Obsidian |
| Citazioni | ✅ Un solo registro di numerazione per turno; clicca una citazione per saltare alla nota da cui proviene | 🟡 Note sorgente elencate |
| Condividere una risposta | ✅ Pagina web in LAN + QR code, revoca quando vuoi | ❌ Copia-incolla |
| Altre AI possono leggere il tuo vault (MCP) | ✅ Server locale integrato | ❌ |

### Scelte fatte apposta

🧠 **L'agente è un residente, non un visitatore.** Tutto ciò che serve all'agente — ricerca, strumenti, traccia del ragionamento, citazioni, condivisione — è incluso nel plugin. I client AI esterni sono i benvenuti via MCP, ma restano un extra opzionale, mai un prerequisito.

🗄️ **Local-first, per struttura.** L'indice è un file SQLite sul tuo disco. Non esiste alcun server Semlink — non "promettiamo di non caricare le tue note": letteralmente non c'è niente su cui caricarle.

🔑 **BYOK, senza andare a tentoni.** Un catalogo di 24 fornitori di chat (1.800+ modelli con prezzi e finestre di contesto) e un catalogo dedicato ai provider di embedding ti portano alla configurazione in un paio di clic; i runtime locali come Ollama funzionano senza alcuna chiave. Semlink non applica ricarichi e non tocca mai i tuoi token — è il tuo provider a fatturarti direttamente.

🪟 **Un cittadino del Vault.** Trascina una nota nella chat per allegarla, salva le risposte come note, guarda l'anello del contesto riempirsi in tempo reale. L'indicizzazione si mette da parte mentre scrivi. Lo spazio di lavoro vive dove le tue note vivono già — niente da esportare, niente da sincronizzare.

## ✨ Funzionalità distintive

### 🔗 Citazioni che puoi davvero seguire

Ogni turno usa un unico registro di numerazione condiviso tra la traccia del ragionamento, il corpo della risposta e le schede sorgente — il `[3]` nella risposta è lo stesso `[3]` che hai visto leggere al modello. Clicca una citazione e Obsidian apre la nota nel punto esatto da cui proviene. Una risposta vale solo quanto le note con cui puoi verificarla — quindi verifica.

### 📡 Condividi una risposta senza esportare nulla

Trovato qualcosa che merita di essere mostrato? Un clic pubblica l'intero scambio — domanda, traccia del ragionamento, risposta, schede sorgente — come una pulita pagina web sulla tua LAN. Invia il link o il QR code; chi legge lo apre in qualsiasi browser, senza Obsidian, senza account, senza installazioni. Interrompi la condivisione e la pagina sparisce. Niente lascia mai la tua rete.

### 🪟 Guarda l'agente al lavoro, dal vivo

La risposta non è l'unico output — lo è anche il ragionamento. Il pensiero arriva in streaming mentre accade, ogni chiamata agli strumenti (`search_notes` → `get_section` → …) viene registrata con il suo risultato, e l'anello del contesto mostra quanto è piena la finestra del modello, tasso di cache hit incluso. Vedi esattamente ciò che il modello ha visto — ed è questo il punto.

## 🚀 Inizio rapido

1. **Installa** — un clic dalla [pagina del plugin](https://community.obsidian.md/plugins/semlink), oppure cerca "Semlink" in Impostazioni → Plugin community.
2. **Configura** — scegli i provider dal catalogo (oppure incolla un endpoint personalizzato) e aggiungi la tua API key. Il percorso di benvenuto in tre passaggi valida chat + embedding e avvia l'indicizzazione.
3. **Chiedi.** Apri la barra laterale: *"Cosa ho scritto sullo Zettelkasten?"* — poi guarda: ragionamento → `search_notes` → `get_note` → una risposta con [1][2][3].

Questo è tutto. Nessun client agentico, nessun server da configurare. Le tue note non vengono mai modificate — Semlink legge soltanto.

## 🧠 Pensa — un agente che mostra il proprio lavoro

- **Nove strumenti integrati**, e il modello decide cosa attingere mentre risponde: ricerca semantica, lettura della nota, lettura della sezione, note simili, grep con regex, elenchi indicizzati con marche temporali, consapevolezza della nota corrente. Non recupera tre chunk e allucina sopra; cerca, legge la sezione giusta e mostra ogni passaggio.
- **Un ragionamento che puoi ispezionare.** Ogni risposta riporta il ragionamento del modello e ogni chiamata agli strumenti (`search_notes` → `get_section` → …), in streaming live — non una scatola nera sicura di sé.
- **Citazioni verificabili.** Un unico registro di numerazione per turno attraversa la traccia del ragionamento, il corpo della risposta e le schede sorgente; clicca una citazione per saltare dritto alla nota (e alla riga) da cui proviene.
- **Una ricerca che arriva ovunque**: interroga per significato ogni nota che hai mai scritto, con suggerimenti di note simili e grep con regex per quando *conosci* davvero la stringa esatta.

## 🤝 Collabora — la conoscenza esce dal silo (alle tue condizioni)

- **Condividi una conversazione sulla tua LAN**: un clic pubblica domanda e risposta in una pulita pagina web — invia il link o il QR code, chi legge lo apre in qualsiasi browser, e tu revochi la condivisione quando vuoi. Niente lascia la tua rete.
- **Le risposte diventano note**: salva qualsiasi risposta di nuovo nel tuo vault con un clic.
- **Allega con drag & drop**: rilascia una nota in un punto qualsiasi del pannello — i `[[wiki-link]]` si risolvono in linea — e l'agente la legge per primo.
- **Opzionale: fai entrare le tue altre AI.** Gli stessi strumenti sono disponibili come server MCP locale, così anche Claude Desktop, Claude Code e Cursor possono cercare e citare il tuo vault. Strettamente opzionale — l'agente integrato non ha bisogno di aiuto.

## ⚡ Agisci — controllo in tempo reale

- **Un cruscotto RAG, non una barra di avanzamento**: metriche del vault, avanzamento reale dell'embedding nota per nota, e interruttori indice / auto-embed che hanno effetto immediato — anche a run in corso.
- **Riconfigura senza cerimonie**: cambia il modello di embedding e una reindicizzazione completa parte automaticamente; la guida rivalida la tua chiave e ti porta direttamente al passaggio giusto.
- **Indicizzazione in tempo reale** che rileva ogni modifica ai file mentre scrivi — e si mette da parte mentre digiti, così l'editor non scatta mai.
- **Controllo dalla palette dei comandi** per indicizzazione, MCP, log di debug e avanzamento.

## 🔑 BYOK — porta la tua chiave

Funziona qualsiasi endpoint compatibile OpenAI o Anthropic — DeepSeek, GLM, SiliconFlow, OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, e più di 1.800 altri tramite il catalogo integrato. Ciò che conta:

- **Modello di chat**: scegli dal catalogo con prezzi e finestre di contesto ben visibili, oppure aggiungi un endpoint personalizzato (runtime locali inclusi, senza chiave)
- **Modello di embedding**: un catalogo dedicato ai provider di embedding — SiliconFlow BGE-M3 preconfigurato; Jina, Voyage, Nomic, Mixedbread e altri, oppure un endpoint di embedding locale senza chiave
- **Le tue chiavi, le tue tariffe, cambio illimitato** — l'utilizzo dei modelli è fatturato dal tuo provider; Semlink non ne vede nemmeno un centesimo

## 🌐 MCP — opzionale, per le tue altre AI

L'agente integrato è completo di per sé. Se usi anche Claude Desktop, Claude Code o Cursor, gli stessi strumenti sono esposti come server MCP locale:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Solo localhost, chiave di accesso opzionale. Nessun relay nel cloud.

## ❓ FAQ

**Mi serve Claude Desktop, Cursor o un altro client AI?**
No. L'agente completo — traccia del ragionamento, chiamate agli strumenti, citazioni, condivisione — gira dentro il plugin. MCP esiste perché le AI esterne *possono* leggere il tuo vault, mai perché debbano farlo.

**I miei dati vengono inviati da qualche parte?**
Il tuo indice vive in `data/` dentro la cartella del plugin, sul tuo disco. Le uniche chiamate di rete vanno ai provider che configuri *tu*. La condivisione in LAN resta sulla tua rete. Consulta l'[informativa sulla privacy](https://getsemlink.com/privacy.html).

**In che cosa è diverso da Copilot for Obsidian?**
Copilot instrada il suo agente tramite opencode e la sua RAG tramite Miyo — strumenti esterni da installare ed eseguire accanto al plugin. Semlink tiene l'intero ciclo dentro Obsidian: vedi il ragionamento e ogni chiamata agli strumenti, il modello sceglie quali note leggere e le risposte citano note specifiche che puoi aprire. Se Copilot ti funziona, tienilo — Semlink è per quando vuoi lo spazio di lavoro, non altri client.

**Serve una API key?**
Semlink è BYOK per design — ma "la tua chiave" include anche i runtime locali senza chiave come Ollama, sia per la chat sia per gli embedding. I piani gratuiti del cloud (SiliconFlow, Groq…) funzionano bene ugualmente.

**Dove vive l'indice?**
`data/vault.db` (SQLite) e `data/vectors.bin` dentro la cartella del plugin. Eliminali e reindicizza quando vuoi; niente lascia mai il tuo computer.

**Quale modello dovrei usare?**
Qualsiasi modello di chat a contesto lungo ti piaccia — le risposte citano le tue note ampiamente. Gli embedding sono economici e poco frequenti (BGE-M3).

## 📜 Licenza

MIT — vedi [LICENSE](LICENSE). La licenza Pro opzionale è un acquisto una tantum e mai un abbonamento.
