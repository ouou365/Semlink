# 🧠 Semlink — Agentic Knowledge Workspace

**Laissez votre vault Obsidian penser, collaborer et agir.**

**Français** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Español](README_es.md) | [Português](README_pt.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

Semlink transforme votre vault Obsidian en espace de connaissances agentique — un assistant IA qui vit dans votre barre latérale, fouille tout ce que vous avez jamais noté, raisonne dessus avec de vrais outils, cite chaque affirmation en renvoyant à vos notes et partage ce qu'il apprend. L'agent entier est livré dans le plugin : pas de Claude Desktop, pas de Cursor, pas de terminal, aucun client tiers à installer. Ajoutez votre propre API key, et votre vault se met à réfléchir.

## 🤔 Pourquoi Semlink ?

Vous écrivez depuis des années. Puis vous posez une question sur vos propres connaissances — et le rituel recommence : se souvenir du bon dossier, Ctrl+F, copier-coller dans une fenêtre de chat, perdre le fil.

La plupart des plugins IA d'Obsidian dépendent de clients d'agents tiers — et ces clients sont des applications d'agents conçues pour la programmation. Vous obtenez un assistant de code qui passe voir vos notes, pas un agent qui travaille réellement à l'intérieur.

Semlink est conçu dans l'autre sens :

**L'espace de travail, c'est le vault — et l'agent est intégré, pas plaqué dessus.** Installez le plugin, collez votre clé, posez votre question. L'agent réfléchit, appelle des outils, lit vos notes et répond avec des citations numérotées — entièrement dans Obsidian. Vous n'avez pas à faire confiance à la réponse. Vous la voyez se construire, puis vous la vérifiez.

### Semlink vs. Copilot for Obsidian

| | Semlink | Copilot for Obsidian |
|---|---|---|
| Zéro outil externe | ✅ Agent, RAG et partage tous intégrés au plugin | ❌ L'agent exige opencode, le RAG exige Miyo — des installations séparées |
| Boucle d'agent (chercher → lire → raisonner) | ✅ 9 outils, le modèle décide quoi lire | 🟡 Acheminé via un client externe |
| Transparence du raisonnement | ✅ Réflexion + traces d'outils, en direct dans le plugin | 🟡 La boucle se déroule hors d'Obsidian |
| Citations | ✅ Un registre de numérotation par tour ; cliquez sur une citation pour ouvrir la note d'où elle provient | 🟡 Notes sources listées |
| Partager une réponse | ✅ Page web LAN + code QR, révocable à tout moment | ❌ Copier-coller |
| D'autres IA peuvent lire votre vault (MCP) | ✅ Serveur local intégré | ❌ |

### Des choix assumés

🧠 **L'agent est un résident, pas un visiteur.** Tout ce dont l'agent a besoin — recherche, outils, trace de réflexion, citations, partage — est livré dans le plugin. Les clients IA externes sont les bienvenus via MCP, mais ils restent un bonus facultatif, jamais un prérequis.

🗄️ **Local d'abord, structurellement.** Votre index est un fichier SQLite sur votre propre disque. Il n'existe aucun serveur Semlink — ce n'est pas « nous promettons de ne pas envoyer vos notes », il n'y a littéralement rien vers quoi envoyer.

🔑 **BYOK, sans devinettes.** Un catalogue de 24 fournisseurs de chat (plus de 1 800 modèles avec prix et fenêtres de contexte) et un catalogue dédié aux fournisseurs d'embedding vous permettent d'être configuré en quelques clics ; les runtimes locaux comme Ollama fonctionnent sans aucune clé. Semlink n'ajoute aucune marge et ne touche jamais à vos tokens — votre fournisseur vous facture directement.

🪟 **Un citoyen du vault.** Glissez une note dans le chat pour la joindre, enregistrez les réponses en notes, regardez l'anneau de contexte se remplir en temps réel. L'indexation s'efface pendant que vous tapez. L'espace de travail vit là où vivent déjà vos notes — rien à exporter, rien à synchroniser.

## ✨ Fonctionnalités phares

### 🔗 Des citations que vous pouvez vraiment suivre

Chaque tour s'appuie sur un registre de numérotation unique qui traverse la trace de réflexion, le corps de la réponse et les cartes de sources — le `[3]` de la réponse est le même `[3]` que vous avez vu le modèle lire. Cliquez sur une citation et Obsidian ouvre la note à l'endroit exact d'où elle provient. Une réponse ne vaut que par les notes avec lesquelles vous pouvez la vérifier — alors vérifiez.

### 📡 Partagez une réponse sans rien exporter

Vous avez trouvé quelque chose qui mérite d'être montré ? Un clic publie l'échange entier — question, trace de réflexion, réponse, cartes de sources — sous forme d'une page web propre sur votre LAN. Envoyez le lien ou le code QR ; le lecteur l'ouvre dans n'importe quel navigateur, sans Obsidian, sans compte, sans installation. Arrêtez le partage et la page disparaît. Rien ne quitte jamais votre réseau.

### 🪟 Regardez l'agent travailler, en direct

La réponse n'est pas la seule sortie — le raisonnement en est une aussi. La réflexion s'affiche au fil de son déroulement, chaque appel d'outil (`search_notes` → `get_section` → …) est journalisé avec son résultat, et l'anneau de contexte montre à quel point la fenêtre du modèle est remplie, taux de cache hit compris. Vous voyez exactement ce que le modèle a vu — c'est tout l'intérêt.

## 🚀 Démarrage rapide

1. **Installez** — en un clic depuis la [page du plugin](https://community.obsidian.md/plugins/semlink), ou recherchez « Semlink » dans Paramètres → Plugins communautaires.
2. **Configurez** — choisissez des fournisseurs dans le catalogue (ou collez un point d'accès personnalisé) et ajoutez votre API key. L'onboarding en trois étapes valide le chat + l'embedding et lance l'indexation.
3. **Interrogez.** Ouvrez la barre latérale : *« Qu'ai-je écrit sur le Zettelkasten ? »* — puis observez : réflexion → `search_notes` → `get_note` → une réponse avec [1][2][3].

C'est tout. Aucun client d'agent, aucune configuration de serveur. Vos notes ne sont jamais modifiées — Semlink ne fait que lire.

## 🧠 Penser — un agent qui montre son travail

- **Neuf outils intégrés**, et le modèle décide quoi consulter en répondant : recherche sémantique, lecture de note, lecture de section, notes similaires, grep regex, liste indexée (avec horodatages), conscience de la note courante. Il ne récupère pas trois chunks pour halluciner par-dessus ; il cherche, lit la bonne section et montre chaque étape.
- **Une réflexion que vous pouvez inspecter.** Chaque réponse embarque le raisonnement du modèle et chaque appel d'outil (`search_notes` → `get_section` → …), en direct — pas une boîte noire assurée d'elle.
- **Des citations qui tiennent la vérification.** Un registre de numérotation par tour relie la trace de réflexion, le corps de la réponse et les cartes de sources ; cliquez sur une citation pour sauter directement à la note (et à la ligne) d'où elle provient.
- **Une recherche qui atteint tout** : interrogez par le sens dans chaque note que vous avez jamais écrite, avec suggestions de notes similaires et grep regex pour quand vous connaissez *justement* la chaîne exacte.

## 🤝 Collaborer — des connaissances qui sortent du silo (à vos conditions)

- **Partagez une conversation sur votre LAN** : un clic publie les questions-réponses sur une page web propre — envoyez le lien ou le code QR, le lecteur l'ouvre dans n'importe quel navigateur, et vous révoquez le partage à tout moment. Rien ne quitte votre réseau.
- **Les réponses deviennent des notes** : enregistrez n'importe quelle réponse dans votre vault en un clic.
- **Pièces jointes par glisser-déposer** : déposez une note n'importe où dans le panneau — les `[[wiki-links]]` se résolvent en ligne — et l'agent la lit en premier.
- **Facultatif : laissez entrer vos autres IA.** Les mêmes outils sont livrés en serveur MCP local, pour que Claude Desktop, Claude Code et Cursor puissent eux aussi chercher dans votre vault et le citer. Strictement facultatif — l'agent intégré n'a besoin d'aide de personne.

## ⚡ Agir — un contrôle en temps réel

- **Un tableau de bord RAG, pas une barre de progression** : métriques du vault, progression réelle de l'embedding note par note, et interrupteurs index / auto-embed qui prennent effet immédiatement — même en cours de traitement.
- **Reconfigurez sans cérémonie** : changez le modèle d'embedding et une réindexation complète démarre automatiquement ; le guide revalide votre clé et vous amène directement à la bonne étape.
- **Une indexation en temps réel** qui détecte chaque modification de fichier au fil de votre écriture — et s'efface pendant que vous tapez, si bien que l'éditeur ne ralentit jamais.
- **Un contrôle par palette de commandes** sur l'indexation, MCP, le journal de debug et la progression.

## 🔑 BYOK — apportez votre propre clé

Tout point d'accès compatible OpenAI ou Anthropic fonctionne — DeepSeek, GLM, SiliconFlow, OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, et plus de 1 800 autres via le catalogue intégré. Ce qui compte :

- **Modèle de chat** : choisissez dans le catalogue avec prix et fenêtres de contexte affichés, ou ajoutez un point d'accès personnalisé (y compris des runtimes locaux sans clé)
- **Modèle d'embedding** : un catalogue dédié aux fournisseurs d'embedding — SiliconFlow BGE-M3 préconfiguré ; Jina, Voyage, Nomic, Mixedbread et d'autres, ou un point d'accès d'embedding local sans clé
- **Vos clés, vos tarifs, des changements illimités** — l'usage des modèles est facturé par votre fournisseur ; Semlink n'en touche jamais un centime

## 🌐 MCP — facultatif, pour vos autres IA

L'agent intégré est complet en lui-même. Si vous utilisez aussi Claude Desktop, Claude Code ou Cursor, les mêmes outils sont exposés en serveur MCP local :

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Localhost uniquement, clé d'accès facultative. Aucun relais cloud.

## ❓ FAQ

**Ai-je besoin de Claude Desktop, Cursor ou de tout autre client IA ?**
Non. L'agent complet — trace de réflexion, appels d'outils, citations, partage — tourne dans le plugin. MCP existe pour que des IA externes *puissent* lire votre vault, jamais parce qu'elles le doivent.

**Mes données sont-elles envoyées quelque part ?**
Votre index vit dans `data/`, dans le dossier du plugin, sur votre disque. Les seuls appels réseau vont aux fournisseurs que *vous* configurez. Le partage LAN reste sur votre réseau. Voir la [politique de confidentialité](https://getsemlink.com/privacy.html).

**En quoi est-ce différent de Copilot for Obsidian ?**
Copilot achemine son agent via opencode et son RAG via Miyo — des outils externes que vous installez et faites tourner à côté du plugin. Semlink garde toute la boucle dans Obsidian : vous voyez la réflexion et chaque appel d'outil, le modèle choisit quelles notes lire, et les réponses citent des notes précises que vous pouvez ouvrir. Si Copilot vous convient, gardez-le — Semlink est là pour quand vous voulez l'espace de travail, pas plus de clients.

**Ai-je besoin d'une API key ?**
Semlink est conçu en mode BYOK — mais « votre propre clé » inclut les runtimes locaux sans clé comme Ollama, pour le chat comme pour les embeddings. Les offres gratuites du cloud (SiliconFlow, Groq…) fonctionnent très bien aussi.

**Où réside l'index ?**
`data/vault.db` (SQLite) et `data/vectors.bin` dans le dossier du plugin. Supprimez-les et réindexez à tout moment ; rien ne quitte jamais votre machine.

**Quel modèle utiliser ?**
N'importe quel modèle de chat à long contexte qui vous plaît — les réponses citent vos notes largement. Les embeddings sont bon marché et peu fréquents (BGE-M3).

## 📜 Licence

MIT — voir [LICENSE](LICENSE). La licence Pro facultative est un achat unique, jamais un abonnement.
