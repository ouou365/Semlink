# 🧠 Semlink — Frag deinen Vault. Sieh ihm beim Denken zu.

**Deutsch** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Français](README_fr.md) | [Español](README_es.md) | [Português](README_pt.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

Ein Obsidian-Plugin, das jahrelange Notizen in ein zweites Gehirn verwandelt: ein transparenter KI-Agent, der dort lebt, wo du schreibst, alles durchsucht, was du je notiert hast, mit echten Tools darüber nachdenkt und mit nummerierten, anklickbaren Quellenangaben antwortet.

**Agent in deinem Vault • Denken + Tool-Aufrufe sichtbar • Anklickbare Quellenangaben • Lokaler SQLite-Index — kein Server • Beliebiger OpenAI-/Anthropic-kompatibler Anbieter • MCP für Claude & Cursor • 11 Sprachen • Kostenloser Kern, einmaliges Pro**

<br>

Offizielle Website: [getsemlink.com](https://getsemlink.com) · [Pro-Lizenz — $3 Frühbucher](https://getsemlink.com) · [Issues](https://github.com/ouou365/Semlink/issues)

🤔 Warum Semlink? | 🚀 Schnellstart | ✨ Funktionen | 🤖 Bring dein eigenes Modell mit | 🌐 MCP | ❓ FAQ

← Wenn Semlink in deiner Seitenleiste seinen Platz verdient hat, lass einen Stern da ⭐ — es ist das einzige Marketing, das ein Indie-Plugin hat.

## 🤔 Warum Semlink?

Du schreibst seit Jahren. Dann stellst du eine Frage zu deinem eigenen Wissen — und der Workflow lautet: Ordner erinnern, Strg+F, Copy-Paste in ein Chatfenster, den Faden verlieren.

Andere Obsidian-KI-Plugins chatten zwar mit deinen Notizen. Was sie dir nicht zeigen, ist die Arbeit. Die meisten RAG-Plugins holen hinter einer Black Box ein paar Chunks und antworten trotzdem — falsche Chunks, überzeugter Ton. Smart Connections findet verwandte Notizen, antwortet aber nie. Omnisearch bleibt bei Stichwörtern stehen. Und der „ernsthafte“ Weg — Notizen in ChatGPT einfügen oder Claude Code aus einem Terminal steuern — bedeutet, dass dein Wissen woanders lebt als in deinem Editor.

Semlink ist umgekehrt gebaut:

**Der Agent lebt in deinem Vault — und du siehst ihm bei der Arbeit zu.** Jede Antwort kommt mit dem Denkprozess des Modells, mit jedem Tool-Aufruf, den es gemacht hat (`search_notes` → `get_note` → …), und mit nummerierten Quellenangaben, die zurück in deine eigenen Notizen zeigen. Du musst der Antwort nicht vertrauen. Du prüfst sie.

### Der Vergleich

| | Semlink | Copilot-artiges RAG | Smart Connections | Omnisearch | ChatGPT / Claude Code |
|---|---|---|---|---|---|
| Wo die KI lebt | ✅ In Obsidian | 🟡 Nur Chat-Panel | 🟡 Nur verwandte Notizen | 🟡 Nur Suchfeld | ❌ Browser / Terminal |
| Agent-Schleife (Suchen → Lesen → Nachdenken) | ✅ 9 Tools, das Modell entscheidet | ❌ Fester Chunk-Abruf | ❌ Kein Q&A | ❌ | ✅ aber außerhalb deines Editors |
| Nachvollziehbarkeit des Denkens | ✅ Denken + Tool-Spuren | ❌ Black Box | — | — | 🟡 Terminal-Verlauf |
| Quellenangaben in deine Notizen | ✅ Nummeriert, anklickbar | 🟡 Chunk-Verweise | ❌ | ❌ | ❌ |
| Speicherort des Index | ✅ Lokales SQLite, kein Server | ✅ Lokal | ✅ Lokal | ✅ Lokal | — |
| Andere KIs können deinen Vault lesen (MCP) | ✅ Eingebaut | ❌ | ❌ | ❌ | 🟡 Über Terminals |
| Preise | ✅ Kostenloser Kern + einmaliges Pro | BYOK | Kostenlos | Kostenlos | Abo |

### Drei Entscheidungen, die wir bewusst getroffen haben

🗄️ **Local-first, und zwar strukturell.** Dein Index ist eine SQLite-Datei auf deiner eigenen Festplatte. Es gibt keinen Semlink-Server — nicht „wir versprechen, deine Notizen nicht hochzuladen“, es gibt buchstäblich nichts, wohin man sie hochladen könnte.

🔌 **Jedes Modell, das du schon bezahlst.** DeepSeek, GLM, SiliconFlow, OpenAI, Claude, Ollama, LM Studio — jeder OpenAI- oder Anthropic-kompatible Endpunkt. Semlink schlägt nichts auf und fasst deine Tokens nie an; die Nutzung stellt dir dein Anbieter direkt in Rechnung.

🪟 **Ein Bürger deines Vaults.** Zieh eine Notiz in den Chat, um sie anzuhängen, speichere Antworten als Notizen zurück, sieh zu, wie sich der Kontextring in Echtzeit füllt. Die Indexierung tritt zurück, während du tippst. Der Agent arbeitet dort, wo deine Notizen bereits leben — nichts zu exportieren, nichts zu synchronisieren.

## 🎯 Ist das was für mich?

**✅ Ja, wenn du:**

- seit Monaten (oder Jahren) Notizen hast und ihnen Fragen in natürlicher Sprache *stellen* willst
- nachvollziehbares Reasoning willst — Denken, Tool-Aufrufe, Quellenangaben — statt einer überzeugten Black Box
- darauf achtest, dass deine Notizen deinen Rechner nie verlassen
- bereits einen LLM-API-Key hast (oder ein lokales Modell betreibst) und keine Lust auf Zwischenhändler-Aufschläge hast
- Claude Desktop, Claude Code oder Cursor nutzt — und willst, dass sie deinen Vault ebenfalls lesen

**❌ Nein, wenn du:**

- einen allgemeinen ChatGPT-Ersatz suchst — Semlink antwortet aus deinem Vault, nicht aus dem Internet
- null Konfiguration erwartest — du brauchst einen Embedding-API-Key und einen Key für ein Chat-Modell (kostenlose Konten reichen)
- Team-Kollaboration oder Cloud-Sync brauchst — ein Backend gibt es nicht, und zwar aus Prinzip

## 🚀 Schnellstart

1. **Installieren** — ein Klick auf der [Plugin-Seite](https://community.obsidian.md/plugins/semlink), oder suche „Semlink“ unter Einstellungen → Community-Plugins.
2. **Konfigurieren** — füge einen Embedding-API-Key ein (SiliconFlow BGE-M3 ist vorkonfiguriert) und einen Key für einen Chat-Anbieter. Die dreistufige Einführung prüft beides und startet die Indexierung.
3. **Fragen.** Öffne die Seitenleiste: *„Was habe ich über Zettelkasten geschrieben?“* — und schau zu: Denken → `search_notes` → `get_note` → eine Antwort mit [1][2][3].

Das war’s. Deine Notizen werden nie verändert — Semlink liest nur.

## ✨ Funktionen

### 🕵️ Ein Agent mit Tools, kein Chatbot

Neun eingebaute Tools — semantische Suche, Notiz lesen, Abschnitt lesen, ähnliche Notizen, regex grep, indexierte Auflistung (mit Zeitstempeln), Erkennung der aktuellen Notiz — und das Modell entscheidet beim Antworten, was es heranzieht. Es holt nicht drei Chunks und halluciniert darüber hinweg; es sucht, liest den richtigen Abschnitt und zeigt jeden Schritt.

### 🔍 Semantische Suche, die alles erreicht

Frage nach Bedeutung, nicht nach Stichwörtern — eine natürlichsprachliche Anfrage erreicht jede Notiz, die du je geschrieben hast. Vorschläge für ähnliche Notizen und regex grep sind für den Fall da, dass du die exakte Zeichenkette *doch* kennst.

### 🪟 Ein Bürger deines Vaults

- **Drag & Drop**: lege eine Notiz an beliebiger Stelle im Panel ab, um sie anzuhängen — `[[Wiki-Links]]` werden inline aufgelöst
- **Antworten als Notizen speichern**: ein Klick, zurück in deinen Vault
- **Kontext, den du sehen kannst**: ein Live-Kontextring zeigt, wie voll das Fenster des Modells ist, daneben die Cache-Trefferquote — so weißt du, warum eine Antwort flach ausgefallen ist, bevor du dem Modell die Schuld gibst
- **Start-Fragenkarten**: kuratierte Beispiel-Prompts, einige aus deinen eigenen jüngsten Notizen gezogen

### ⚡ Echtzeit-Indexierung

Dateiänderungen werden automatisch erfasst und beim Schreiben neu eingebettet — und die Indexierung tritt zurück, während du arbeitest, damit der Editor nie ruckelt.

### 🌍 11 Sprachen

English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português, Italiano, Русский — auswählen unter Einstellungen → Allgemein.

## 🤖 Bring dein eigenes Modell mit

Jeder OpenAI-kompatible oder Anthropic-kompatible Endpunkt funktioniert: DeepSeek (vorkonfiguriert), SiliconFlow, GLM, OpenAI, Anthropic, Ollama, LM Studio, OpenRouter — deine Keys, deine Preise, unbegrenzter Wechsel. Was zählt:

- **Chat-Modell**: langer Kontext hilft — Antworten zitieren deine Notizen ausführlich
- **Embedding-Modell**: BGE-M3 (1024-dim) über SiliconFlow vorkonfiguriert; jeder kompatible Embedding-Endpunkt funktioniert
- Die Modellnutzung stellt dein Anbieter in Rechnung — Semlink sieht davon keinen Cent

## 🌐 MCP — gib deinen anderen KIs ein Gedächtnis

Dieselben Tools gibt es als lokalen MCP-Server, damit auch Claude Desktop, Claude Code und Cursor deinen Vault durchsuchen und zitieren können:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Nur localhost, optionaler Access Key. Keine Cloud-Relais.

## ⭐ Pro — kostenlos, wo es zählt

Der Kern ist für immer kostenlos, versprochen in der App selbst: semantische Suche, Chat mit dem vollen Agent, Indexierung, MCP — unbegrenzt, keine Testuhr. Modell-Tokens stellt dein Anbieter in Rechnung, niemals wir.

[Pro](https://getsemlink.com) ist eine **Einmallizenz** (kein Abo): unbegrenzter Chat-Verlauf plus Verwaltung des Verlaufs — Suche, Anheften, Ordner.

## ❓ FAQ

**Werden meine Daten irgendwohin gesendet?**
Dein Index liegt in `data/` im Plugin-Ordner, auf deiner Festplatte. Die einzigen Netzwerkaufrufe gehen an die Anbieter, *die du* konfigurierst. Siehe die [Datenschutzerklärung](https://getsemlink.com/privacy.html).

**Worin unterscheidet sich das von Copilot for Obsidian?**
Transparenz und die Agent-Schleife: du siehst das Denken und jeden Tool-Aufruf, das Modell wählt, welche Notizen es liest, und Antworten zitieren konkrete Notizen, die du öffnen kannst. Wenn Copilot für dich funktioniert, behalte es — Semlink ist für den Fall, dass du der Arbeit zusehen willst.

**Brauche ich einen API Key?**
Ja — Semlink ist von Grund auf Bring-Your-Own-Key. Kostenlose Konten (SiliconFlow, Groq …) reichen für Embedding und Chat gleichermaßen aus.

**Wo liegt der Index?**
`data/vault.db` (SQLite) und `data/vectors.bin` im Plugin-Ordner. Lösche sie und indexiere jederzeit neu; nichts verlässt jemals deinen Rechner.

**Welches Modell soll ich verwenden?**
Jedes Langkontext-Chat-Modell, das du magst — Antworten zitieren deine Notizen ausführlich. Embeddings sind günstig und selten nötig (BGE-M3).

## 🛠 Befehle

| Befehl | Wirkung |
|---|---|
| Semlink: Open Search | Öffnet das Chat-Panel in der Seitenleiste |
| Semlink: Full Reindex | Scannt alle Dateien neu |
| Semlink: Resume / Pause Index | Steuert die Indexierung |
| Semlink: Start/Stop MCP Service | Schaltet den MCP-Server um |
| Semlink: Toggle Debug Logging | Ausführliche Konsolen-Diagnosen |
| Semlink: View Index Progress | Öffnet das Fortschritts-Panel |

## 📜 Lizenz

MIT — siehe [LICENSE](LICENSE). Die optionale Pro-Lizenz ist ein Einmalkauf und nie ein Abo.
