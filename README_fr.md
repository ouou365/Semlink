# 🧠 Semlink — Interrogez votre vault. Regardez-le réfléchir.

**Français** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Español](README_es.md) | [Português](README_pt.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

Un plugin Obsidian qui transforme des années de notes en un espace de connaissances agentique : un agent IA transparent qui vit là où vous écrivez, cherche dans tout ce que vous avez noté, raisonne avec de vrais outils et répond avec des citations numérotées sur lesquelles vous pouvez cliquer.

**Un agent dans votre vault • Réflexion + appels d'outils, visibles • Citations cliquables • Index SQLite local — sans serveur • Tout fournisseur compatible OpenAI/Anthropic • MCP pour Claude & Cursor • 11 langues • Cœur gratuit, Pro en achat unique**

<br>

Site officiel : [getsemlink.com](https://getsemlink.com) · [Licence Pro — offre de lancement à 3 $](https://getsemlink.com) · [Issues](https://github.com/ouou365/Semlink/issues)

🤔 Pourquoi Semlink ? | 🚀 Démarrage rapide | ✨ Fonctionnalités | 🤖 Apportez vos modèles | 🌐 MCP | ❓ FAQ

← Si Semlink a gagné sa place dans votre barre latérale, laissez une étoile ⭐ — c'est le seul marketing dont dispose un plugin indépendant.

## 🤔 Pourquoi Semlink ?

Vous écrivez depuis des années. Puis vous posez une question sur vos propres connaissances — et le rituel recommence : se souvenir du bon dossier, Ctrl+F, copier-coller dans une fenêtre de chat, perdre le fil.

Les autres plugins IA d'Obsidian savent discuter avec vos notes. Ce qu'ils ne vous montrent pas, c'est le travail. La plupart des plugins RAG récupèrent quelques chunks derrière une boîte noire et répondent quand même — mauvais chunks, ton assuré. Smart Connections trouve des notes similaires mais ne répond jamais. Omnisearch s'arrête aux mots-clés. Et la voie « sérieuse » — coller des notes dans ChatGPT ou piloter Claude Code depuis un terminal — signifie que vos connaissances vivent ailleurs que dans votre éditeur.

Semlink est conçu dans l'autre sens :

**L'agent vit dans votre vault — et vous le regardez travailler.** Chaque réponse s'accompagne du processus de réflexion du modèle, de chaque appel d'outil effectué (`search_notes` → `get_note` → …) et de citations numérotées renvoyant à vos propres notes. Vous n'avez pas à faire confiance à la réponse. Vous la vérifiez.

### Comment nous nous comparons

| | Semlink | RAG type Copilot | Smart Connections | Omnisearch | ChatGPT / Claude Code |
|---|---|---|---|---|---|
| Où vit l'IA | ✅ Dans Obsidian | 🟡 Panneau de chat uniquement | 🟡 Notes similaires uniquement | 🟡 Zone de recherche uniquement | ❌ Navigateur / terminal |
| Boucle d'agent (chercher → lire → raisonner) | ✅ 9 outils, le modèle décide | ❌ Récupération de chunks figée | ❌ Pas de questions-réponses | ❌ | ✅ mais hors de votre éditeur |
| Transparence du raisonnement | ✅ Réflexion + traces d'outils | ❌ Boîte noire | — | — | 🟡 Historique du terminal |
| Citations vers vos notes | ✅ Numérotées, cliquables | 🟡 Réf. de chunks | ❌ | ❌ | ❌ |
| Emplacement de l'index | ✅ SQLite local, sans serveur | ✅ Local | ✅ Local | ✅ Local | — |
| D'autres IA peuvent lire votre vault (MCP) | ✅ Intégré | ❌ | ❌ | ❌ | 🟡 Via terminaux |
| Tarifs | ✅ Cœur gratuit + Pro en achat unique | BYOK | Gratuit | Gratuit | Abonnement |

### Trois choix assumés

🗄️ **Local d'abord, structurellement.** Votre index est un fichier SQLite sur votre propre disque. Il n'existe aucun serveur Semlink — ce n'est pas « nous promettons de ne pas envoyer vos notes », il n'y a littéralement rien vers quoi envoyer.

🔌 **N'importe quel modèle que vous payez déjà.** DeepSeek, GLM, SiliconFlow, OpenAI, Claude, Ollama, LM Studio — tout point d'accès compatible OpenAI ou Anthropic. Semlink n'ajoute aucune marge et ne touche jamais à vos tokens ; l'usage est facturé par votre fournisseur, directement à vous.

🪟 **Un citoyen du vault.** Glissez une note dans le chat pour la joindre, enregistrez les réponses en notes, regardez l'anneau de contexte se remplir en temps réel. L'indexation s'efface pendant que vous tapez. L'agent travaille là où vivent déjà vos notes — rien à exporter, rien à synchroniser.

## 🎯 Est-ce fait pour vous ?

**✅ Oui, si vous :**

- Avez des mois (ou des années) de notes et voulez leur *poser* des questions en langage naturel
- Voulez un raisonnement inspectable — réflexion, appels d'outils, citations — pas une boîte noire assurée
- Tenez à ce que vos notes ne quittent jamais votre machine
- Avez déjà une API key LLM (ou faites tourner un modèle local) et supportez mal les marges des intermédiaires
- Utilisez Claude Desktop, Claude Code ou Cursor — et voulez qu'ils lisent eux aussi votre vault

**❌ Non, si vous :**

- Cherchez un remplacement généraliste de ChatGPT — Semlink répond depuis votre vault, pas depuis Internet
- Vous attendez à zéro configuration — il vous faudra une API key d'embedding et une clé de modèle de chat (des offres gratuites suffisent)
- Avez besoin de collaboration d'équipe ou de synchronisation cloud — il n'y a pas de backend, c'est voulu

## 🚀 Démarrage rapide

1. **Installez** — en un clic depuis la [page du plugin](https://community.obsidian.md/plugins/semlink), ou recherchez « Semlink » dans Paramètres → Plugins communautaires.
2. **Configurez** — collez une API key d'embedding (SiliconFlow BGE-M3 préconfiguré) et une clé de fournisseur de chat. L'onboarding en trois étapes valide les deux et lance l'indexation.
3. **Interrogez.** Ouvrez la barre latérale : *« Qu'ai-je écrit sur le Zettelkasten ? »* — puis observez : réflexion → `search_notes` → `get_note` → une réponse avec [1][2][3].

C'est tout. Vos notes ne sont jamais modifiées — Semlink ne fait que lire.

## ✨ Fonctionnalités

### 🕵️ Un agent outillé, pas un chatbot

Neuf outils intégrés — recherche sémantique, lecture de note, lecture de section, notes similaires, grep regex, liste indexée (avec horodatages), conscience de la note courante — et le modèle décide quoi consulter en répondant. Il ne récupère pas trois chunks pour halluciner par-dessus ; il cherche, lit la bonne section et montre chaque étape.

### 🔍 Une recherche sémantique qui atteint tout

Interrogez par le sens, pas par mots-clés — une seule requête en langage naturel touche chaque note que vous avez écrite. Les suggestions de notes similaires et le grep regex sont là pour quand vous connaissez *justement* la chaîne exacte.

### 🪟 Un citoyen du vault

- **Glisser-déposer** : déposez une note n'importe où dans le panneau pour la joindre — les `[[wiki-links]]` se résolvent en ligne
- **Enregistrer les réponses en notes** : un clic, et c'est dans votre vault
- **Un contexte visible** : un anneau de contexte en direct montre le remplissage de la fenêtre du modèle, avec le taux de cache hit à côté — vous savez pourquoi une réponse est restée superficielle avant d'accuser le modèle
- **Cartes de questions d'accueil** : exemples de prompts choisis avec soin, certains tirés de vos propres notes récentes

### ⚡ Indexation en temps réel

Les modifications de fichiers sont détectées automatiquement et ré-embeddées au fil de votre écriture — et l'indexation s'efface pendant que vous travaillez, si bien que l'éditeur ne ralentit jamais.

### 🌍 11 langues

English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português, Italiano, Русский — à choisir dans Paramètres → Général.

## 🤖 Apportez vos propres modèles

Tout point d'accès compatible OpenAI ou Anthropic fonctionne : DeepSeek (préconfiguré), SiliconFlow, GLM, OpenAI, Anthropic, Ollama, LM Studio, OpenRouter — vos clés, vos tarifs, changements illimités. Ce qui compte :

- **Modèle de chat** : un long contexte aide — les réponses citent vos notes largement
- **Modèle d'embedding** : BGE-M3 (1024 dimensions) préconfiguré via SiliconFlow ; tout point d'accès d'embedding compatible fonctionne
- L'usage des modèles est facturé par votre fournisseur — Semlink n'en touche jamais un centime

## 🌐 MCP — donnez une mémoire à vos autres IA

Les mêmes outils sont livrés en serveur MCP local, pour que Claude Desktop, Claude Code et Cursor puissent eux aussi chercher dans votre vault et le citer :

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Localhost uniquement, clé d'accès facultative. Aucun relais cloud.

## ⭐ Pro — gratuit là où cela compte

Le cœur est gratuit pour toujours, promis au sein même de l'application : recherche sémantique, chat avec l'agent complet, indexation, MCP — sans plafond, sans chronomètre d'essai. Les tokens des modèles sont facturés par votre fournisseur, jamais par nous.

[Pro](https://getsemlink.com) est une **licence unique** (sans abonnement) : historique de chat illimité plus gestion de l'historique — recherche, épinglage, dossiers.

## ❓ FAQ

**Mes données sont-elles envoyées quelque part ?**
Votre index vit dans `data/`, dans le dossier du plugin, sur votre disque. Les seuls appels réseau vont aux fournisseurs que *vous* configurez. Voir la [politique de confidentialité](https://getsemlink.com/privacy.html).

**En quoi est-ce différent de Copilot pour Obsidian ?**
La transparence et la boucle d'agent : vous voyez la réflexion et chaque appel d'outil, le modèle choisit quelles notes lire, et les réponses citent des notes précises que vous pouvez ouvrir. Si Copilot vous convient, gardez-le — Semlink est là pour quand vous voulez regarder le travail.

**Ai-je besoin d'une API key ?**
Oui — Semlink est conçu en mode BYOK (apportez votre propre clé). Des offres gratuites (SiliconFlow, Groq…) suffisent pour l'embedding comme pour le chat.

**Où réside l'index ?**
`data/vault.db` (SQLite) et `data/vectors.bin` dans le dossier du plugin. Supprimez-les et réindexez à tout moment ; rien ne quitte jamais votre machine.

**Quel modèle utiliser ?**
N'importe quel modèle de chat à long contexte qui vous plaît — les réponses citent vos notes largement. Les embeddings sont bon marché et peu fréquents (BGE-M3).

## 🛠 Commandes

| Commande | Effet |
|---|---|
| Semlink : Ouvrir la recherche sémantique | Ouvre le panneau de chat dans la barre latérale |
| Semlink : Réindexation complète | Rescanne tous les fichiers |
| Semlink : Démarrer / Mettre en pause l'index | Contrôle l'indexation |
| Semlink : Démarrer/Arrêter le service MCP | Active/désactive le serveur MCP |
| Semlink : Activer/désactiver le journal de debug | Diagnostics console détaillés |
| Semlink : Voir la progression de l'index | Ouvre le panneau de progression |

## 📜 Licence

MIT — voir [LICENSE](LICENSE). La licence Pro facultative est un achat unique, jamais un abonnement.
