# 🧠 Semlink — Agentic Knowledge Workspace

**Lass dein Obsidian Vault denken, zusammenarbeiten und handeln.**

**Deutsch** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Français](README_fr.md) | [Español](README_es.md) | [Português](README_pt.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

Semlink verwandelt deinen Obsidian Vault in einen agentischen Wissensarbeitsbereich — einen KI-Assistenten, der in deiner Seitenleiste lebt, alles durchsucht, was du je notiert hast, mit echten Tools darüber nachdenkt, jede Aussage mit Quellenangaben auf deine Notizen zurückführt und Gelerntes teilt. Der komplette Agent wird direkt mit dem Plugin ausgeliefert: kein Claude Desktop, kein Cursor, kein Terminal, kein Client von Drittanbietern. Bringe deinen eigenen API Key mit — und dein Vault beginnt zu denken.


![Semlink — agentic knowledge workspace living in the Obsidian sidebar](assets/screenshot-overview.png)

## 🤔 Warum Semlink?

Du schreibst seit Jahren. Dann stellst du eine Frage zu deinem eigenen Wissen — und der Workflow lautet: Ordner erinnern, Strg+F, Copy-Paste in ein Chatfenster, den Faden verlieren.

Die meisten Obsidian-KI-Plugins hängen von Agent-Clients von Drittanbietern ab — und diese Clients sind Agent-Anwendungen, die für die Programmierung gebaut wurden. Du bekommst einen Coding-Assistenten, der gelegentlich bei deinen Notizen vorbeischaut — keinen Agenten, der tatsächlich in ihnen arbeitet.

Semlink ist umgekehrt gebaut:

**Der Workspace ist der Vault, und der Agent ist eingebaut — nicht draufgesetzt.** Installiere das Plugin, füge deinen Key ein, stelle deine Frage. Der Agent denkt, ruft Tools auf, liest deine Notizen und antwortet mit nummerierten Quellenangaben — vollständig innerhalb von Obsidian. Du musst der Antwort nicht vertrauen. Du siehst zu, wie sie entsteht — und prüfst sie dann.

### Semlink vs. Copilot for Obsidian

| | Semlink | Copilot for Obsidian |
|---|---|---|
| Keine externen Tools | ✅ Agent, RAG und Teilen komplett im Plugin eingebaut | ❌ Agent erfordert opencode, RAG erfordert Miyo — separate Installationen |
| Agent-Schleife (Suchen → Lesen → Nachdenken) | ✅ 9 Tools, das Modell entscheidet, was gelesen wird | 🟡 Wird über einen externen Client geleitet |
| Transparenz des Reasonings | ✅ Denken + Tool-Spuren, live im Plugin gestreamt | 🟡 Die Schleife läuft außerhalb von Obsidian |
| Quellenangaben | ✅ Ein Nummernregister pro Runde; Klick auf eine Quellenangabe springt zur Notiz, aus der sie stammt | 🟡 Quell-Notizen werden aufgelistet |
| Eine Antwort teilen | ✅ LAN-Webseite + QR-Code, jederzeit widerrufbar | ❌ Copy-Paste |
| Andere KIs können deinen Vault lesen (MCP) | ✅ Eingebauter lokaler Server | ❌ |

### Entscheidungen, die wir bewusst getroffen haben

🧠 **Der Agent ist Bewohner, kein Besucher.** Alles, was der Agent braucht — Suche, Tools, Denkspur, Quellenangaben, Teilen — wird mit dem Plugin ausgeliefert. Externe KI-Clients sind über MCP willkommen, aber sie sind ein optionaler Bonus, niemals eine Voraussetzung.

🗄️ **Local-first, und zwar strukturell.** Dein Index ist eine SQLite-Datei auf deiner eigenen Festplatte. Es gibt keinen Semlink-Server — nicht „wir versprechen, deine Notizen nicht hochzuladen“, es gibt buchstäblich nichts, wohin man sie hochladen könnte.

🔑 **BYOK, ohne Rätselraten.** Ein Katalog mit 24 Chat-Anbietern (1.800+ Modelle mit Preisen und Kontextfenstern) und ein eigener Katalog für Embedding-Anbieter bringen dich mit ein paar Klicks zum Laufen; lokale Runtimes wie Ollama funktionieren ganz ohne Key. Semlink schlägt nichts auf und fasst deine Tokens nie an — dein Anbieter stellt dir die Nutzung direkt in Rechnung.

🪟 **Ein Bürger deines Vaults.** Zieh eine Notiz in den Chat, um sie anzuhängen, speichere Antworten als Notizen zurück, sieh zu, wie sich der Kontextring in Echtzeit füllt. Die Indexierung tritt zurück, während du tippst. Der Workspace lebt dort, wo deine Notizen ohnehin leben — nichts zu exportieren, nichts zu synchronisieren.

## ✨ Kernfunktionen

### 🔗 Quellenangaben, denen du wirklich folgen kannst

Jede Runde führt ein einziges Nummernregister über Denkspur, Antworttext und Quellenkarten hinweg — das `[3]` in der Antwort ist genau das `[3]`, das du gesehen hast, als das Modell es gelesen hat. Ein Klick auf eine Quellenangabe, und Obsidian öffnet die Notiz genau an der Stelle, aus der sie stammt. Eine Antwort ist nur so gut wie die Notizen, an denen du sie prüfen kannst — also prüfe nach.

### 📡 Eine Antwort teilen, ohne etwas zu exportieren

Du hast etwas gefunden, das sich zu zeigen lohnt? Ein Klick veröffentlicht den kompletten Austausch — Frage, Denkspur, Antwort, Quellenkarten — als aufgeräumte Webseite in deinem LAN. Schicke den Link oder den QR-Code; Empfänger öffnen ihn in jedem Browser — ohne Obsidian, ohne Konto, ohne Installation. Beende die Freigabe, und die Seite ist weg. Nichts verlässt jemals dein Netzwerk.

### 🪟 Sieh dem Agent bei der Arbeit zu — live

Die Antwort ist nicht der einzige Output — das Reasoning ist es ebenso. Das Denken wird live gestreamt, jeder Tool-Aufruf (`search_notes` → `get_section` → …) wird mitsamt Ergebnis protokolliert, und der Kontextring zeigt, wie voll das Fenster des Modells ist — Cache-Trefferquote inklusive. Du siehst genau, was das Modell gesehen hat — und genau darum geht es.

## 🚀 Schnellstart

1. **Installieren** — ein Klick auf der [Plugin-Seite](https://community.obsidian.md/plugins/semlink), oder suche „Semlink“ unter Einstellungen → Community-Plugins.
2. **Konfigurieren** — Wähle Anbieter aus dem Katalog (oder füge einen benutzerdefinierten Endpunkt ein) und trage deinen API Key ein. Die dreistufige Einführung prüft Chat + Embedding und startet die Indexierung.
3. **Fragen.** Öffne die Seitenleiste: *„Was habe ich über Zettelkasten geschrieben?“* — und schau zu: Denken → `search_notes` → `get_note` → eine Antwort mit [1][2][3].

Das war’s. Kein Agent-Client, kein Server-Setup. Deine Notizen werden nie verändert — Semlink liest nur.

## 🧠 Denken — ein Agent, der seine Arbeit zeigt

- **Neun eingebaute Tools**, und das Modell entscheidet beim Antworten, was es heranzieht: semantische Suche, Notiz lesen, Abschnitt lesen, ähnliche Notizen, regex grep, indexierte Auflistungen mit Zeitstempeln, Erkennung der aktuellen Notiz. Es holt sich nicht drei Chunks und halluziniert darüber hinweg; es sucht, liest den richtigen Abschnitt und zeigt jeden Schritt.
- **Denken, das du prüfen kannst.** Jede Antwort enthält das Reasoning des Modells und jeden Tool-Aufruf (`search_notes` → `get_section` → …), live gestreamt — keine selbstbewusste Black Box.
- **Quellenangaben, die stimmen.** Ein Nummernregister pro Runde spannt sich über Denkspur, Antworttext und Quellenkarten; ein Klick auf eine Quellenangabe springt direkt zur Notiz (und Zeile), aus der sie stammt.
- **Suche, die alles erreicht**: Frage nach Bedeutung über jede Notiz, die du je geschrieben hast — mit Vorschlägen für ähnliche Notizen und regex grep für den Fall, dass du die exakte Zeichenkette *doch* kennst.

## 🤝 Zusammenarbeiten — Wissen, das den Silo verlässt (zu deinen Bedingungen)

- **Ein Gespräch über dein LAN teilen**: Ein Klick veröffentlicht das Q&A als aufgeräumte Webseite — schicke den Link oder den QR-Code, Empfänger öffnen ihn in jedem Browser, und du widerrufst die Freigabe jederzeit. Nichts verlässt dein Netzwerk.
- **Antworten werden zu Notizen**: Speichere jede Antwort mit einem Klick zurück in deinen Vault.
- **Anhängen per Drag & Drop**: Lege eine Notiz an beliebiger Stelle im Panel ab — `[[Wiki-Links]]` werden inline aufgelöst — und der Agent liest sie zuerst.
- **Optional: Lass deine anderen KIs rein.** Dieselben Tools werden als lokaler MCP-Server ausgeliefert, sodass auch Claude Desktop, Claude Code und Cursor deinen Vault durchsuchen und zitieren können. Streng optional — der eingebaute Agent braucht keine Hilfe.

## ⚡ Handeln — Steuerung in Echtzeit

- **Ein RAG-Dashboard, kein Fortschrittsbalken**: Vault-Metriken, echter Embedding-Fortschritt pro Notiz sowie Index-/Auto-Embed-Schalter, die sofort wirken — sogar mitten im Lauf.
- **Neu konfigurieren ohne Zeremoniell**: Ändere das Embedding-Modell, und eine vollständige Neu-Indexierung startet automatisch; der Einrichtungsleitfaden prüft deinen Key erneut und springt direkt zum richtigen Schritt.
- **Echtzeit-Indexierung**, die jede Dateiänderung beim Schreiben erfasst — und beiseitetritt, während du tippst, damit der Editor nie ruckelt.
- **Steuerung über die Befehlspalette** für Indexierung, MCP, Debug-Logging und Fortschritt.

## 🔑 BYOK — bring deinen eigenen Key mit

Jeder OpenAI-kompatible oder Anthropic-kompatible Endpunkt funktioniert — DeepSeek, GLM, SiliconFlow, OpenAI, Anthropic, OpenRouter, Ollama, LM Studio und 1.800+ weitere über den eingebauten Katalog. Was zählt:

- **Chat-Modell**: aus dem Katalog wählen — mit Preisen und Kontextfenstern — oder einen benutzerdefinierten Endpunkt hinzufügen (einschließlich lokaler Runtimes ohne Key)
- **Embedding-Modell**: ein eigener Katalog für Embedding-Anbieter — SiliconFlow BGE-M3 vorkonfiguriert; Jina, Voyage, Nomic, Mixedbread und weitere, oder ein lokaler Embedding-Endpunkt ohne Key
- **Deine Keys, deine Konditionen, unbegrenzter Wechsel** — die Modellnutzung rechnet dein Anbieter ab; Semlink sieht davon keinen Cent

## 🌐 MCP — optional, für deine anderen KIs

Der eingebaute Agent ist für sich genommen vollständig. Wenn du zusätzlich Claude Desktop, Claude Code oder Cursor nutzt, werden dieselben Tools als lokaler MCP-Server bereitgestellt:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Nur localhost, optionaler Access Key. Keine Cloud-Relais.

## ❓ FAQ

**Brauche ich Claude Desktop, Cursor oder irgendeinen anderen KI-Client?**
Nein. Der komplette Agent — Denkspur, Tool-Aufrufe, Quellenangaben, Teilen — läuft innerhalb des Plugins. MCP existiert, damit externe KIs deinen Vault lesen *können* — niemals, weil sie es müssten.

**Werden meine Daten irgendwohin gesendet?**
Dein Index liegt in `data/` im Plugin-Ordner, auf deiner Festplatte. Die einzigen Netzwerkaufrufe gehen an die Anbieter, *die du* konfigurierst. LAN-Freigaben bleiben in deinem Netzwerk. Siehe die [Datenschutzerklärung](https://getsemlink.com/privacy.html).

**Worin unterscheidet sich das von Copilot for Obsidian?**
Copilot leitet seinen Agenten durch opencode und sein RAG durch Miyo — externe Tools, die du neben dem Plugin installierst und betreibst. Semlink hält die komplette Schleife innerhalb von Obsidian: Du siehst das Denken und jeden Tool-Aufruf, das Modell wählt aus, welche Notizen es liest, und Antworten zitieren konkrete Notizen, die du öffnen kannst. Wenn Copilot für dich funktioniert, behalte es — Semlink ist für den Fall, dass du den Workspace willst, nicht noch mehr Clients.

**Brauche ich einen API Key?**
Semlink ist von Grund auf BYOK — aber „dein eigener Key“ schließt schlüssellose lokale Runtimes wie Ollama für Chat und Embeddings mit ein. Kostenlose Cloud-Kontingente (SiliconFlow, Groq …) funktionieren ebenfalls problemlos.

**Wo liegt der Index?**
`data/vault.db` (SQLite) und `data/vectors.bin` im Plugin-Ordner. Lösche sie und indexiere jederzeit neu; nichts verlässt jemals deinen Rechner.

**Welches Modell soll ich verwenden?**
Jedes Langkontext-Chat-Modell, das dir gefällt — Antworten zitieren deine Notizen ausführlich. Embeddings sind günstig und selten nötig (BGE-M3).

## 📜 Lizenz

MIT — siehe [LICENSE](LICENSE). Die optionale Pro-Lizenz ist ein Einmalkauf und nie ein Abo.
