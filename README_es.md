# 🧠 Semlink — Pregunta a tu bóveda. Mírala pensar.

**Español** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Français](README_fr.md) | [Português](README_pt.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

Obsidian te dio un segundo cerebro. Semlink mete un agente dentro: un agente de IA transparente que vive donde escribes, busca todo lo que has anotado jamás, razona sobre ello con herramientas reales y responde con citas numeradas en las que puedes hacer clic.

**Agente dentro de tu bóveda • Razonamiento y llamadas a herramientas, visibles • Citas en las que puedes hacer clic • Índice SQLite local — sin servidor • Cualquier proveedor compatible con OpenAI/Anthropic • MCP para Claude y Cursor • 11 idiomas • Núcleo gratuito, Pro de pago único**

<br>

Sitio oficial: [getsemlink.com](https://getsemlink.com) · [Licencia Pro — $3 precio de lanzamiento](https://getsemlink.com) · [Issues](https://github.com/ouou365/Semlink/issues)

🤔 ¿Por qué Semlink? | 🚀 Inicio rápido | ✨ Funciones | 🤖 Trae tu propio modelo | 🌐 MCP | ❓ FAQ

← Si Semlink se gana su lugar en tu barra lateral, deja una estrella ⭐ — es todo el marketing que tiene un plugin independiente.

## 🤔 ¿Por qué Semlink?

Llevas años escribiendo. Luego haces una pregunta sobre tu propio conocimiento — y el flujo de trabajo es: recordar qué carpeta, Ctrl+F, copiar y pegar en una ventana de chat, perder el hilo.

Otros plugins de IA para Obsidian conversan con tus notas. Lo que no te enseñan es el trabajo. La mayoría de los plugins RAG recuperan unos fragmentos tras una caja negra y responden igualmente — fragmentos equivocados, tono seguro. Smart Connections encuentra notas relacionadas pero nunca responde. Omnisearch se queda en las palabras clave. Y el camino «serio» — pegar notas en ChatGPT o manejar Claude Code desde una terminal — significa que tu conocimiento vive en un lugar distinto a tu editor.

Semlink está construido al revés:

**El agente vive dentro de tu bóveda — y tú lo miras trabajar.** Cada respuesta incluye el proceso de razonamiento del modelo, cada llamada a herramientas que hizo (`search_notes` → `get_note` → …) y citas numeradas que apuntan a tus propias notas. No tienes que fiarte de la respuesta. La compruebas.

### Cómo nos comparamos

| | Semlink | RAG tipo Copilot | Smart Connections | Omnisearch | ChatGPT / Claude Code |
|---|---|---|---|---|---|
| Dónde vive la IA | ✅ Dentro de Obsidian | 🟡 Solo panel de chat | 🟡 Solo notas relacionadas | 🟡 Solo cuadro de búsqueda | ❌ Navegador / terminal |
| Bucle de agente (buscar → leer → razonar) | ✅ 9 herramientas, decide el modelo | ❌ Recuperación fija de fragmentos | ❌ Sin preguntas y respuestas | ❌ | ✅ pero fuera de tu editor |
| Transparencia del razonamiento | ✅ Razonamiento + trazas de herramientas | ❌ Caja negra | — | — | 🟡 Historial de la terminal |
| Citas hacia tus notas | ✅ Numeradas, en las que puedes hacer clic | 🟡 Referencias a fragmentos | ❌ | ❌ | ❌ |
| Ubicación del índice | ✅ SQLite local, sin servidor | ✅ Local | ✅ Local | ✅ Local | — |
| Otras IAs pueden leer tu bóveda (MCP) | ✅ Integrado | ❌ | ❌ | ❌ | 🟡 Vía terminales |
| Precio | ✅ Núcleo gratis + Pro de pago único | BYOK | Gratis | Gratis | Suscripción |

### Tres decisiones tomadas a propósito

🗄️ **Local primero, estructuralmente.** Tu índice es un archivo SQLite en tu propio disco. No existe ningún servidor de Semlink — no es «prometemos no subir tus notas», es que literalmente no hay ningún sitio al que subirlas.

🔌 **Cualquier modelo que ya estés pagando.** DeepSeek, GLM, SiliconFlow, OpenAI, Claude, Ollama, LM Studio — cualquier endpoint compatible con OpenAI o Anthropic. Semlink no añade recargo alguno y jamás toca tus tokens; el uso lo factura tu proveedor, directamente a ti.

🪟 **Un ciudadano de la bóveda.** Arrastra una nota al chat para adjuntarla, guarda las respuestas como notas, mira llenarse el anillo de contexto en tiempo real. El indexado se aparta mientras escribes. El agente trabaja donde tus notas ya viven — nada que exportar, nada que sincronizar.

## 🎯 ¿Es para mí?

**✅ Sí, si tú:**

- Llevas meses (o años) de notas y quieres *preguntarles* en lenguaje natural
- Quieres un razonamiento que puedas inspeccionar — razonamiento, llamadas a herramientas, citas — no una caja negra segura de sí misma
- Te importa que tus notas jamás salgan de tu equipo
- Ya tienes una API key de un LLM (o ejecutas un modelo local) y te irritan los recargos de los intermediarios
- Usas Claude Desktop, Claude Code o Cursor — y quieres que ellos también lean tu bóveda

**❌ No, si tú:**

- Buscas un reemplazo general de ChatGPT — Semlink responde desde tu bóveda, no desde internet
- Esperas cero configuración — necesitarás una API key de embeddings y una clave de modelo de chat (los niveles gratuitos sirven)
- Necesitas colaboración en equipo o sincronización en la nube — no hay backend, a propósito

## 🚀 Inicio rápido

1. **Instala** — copia `main.js`, `manifest.json`, `styles.css` de [Releases](https://github.com/ouou365/Semlink/releases) a `YourVault/.obsidian/plugins/semlink/`, o compila desde el código fuente. Actívalo en Plugins comunitarios.
2. **Configura** — pega una API key de embeddings (SiliconFlow BGE-M3 preconfigurado) y la clave de un proveedor de chat. La guía de tres pasos valida ambas e inicia el indexado.
3. **Pregunta.** Abre la barra lateral: *«¿Qué he escrito sobre Zettelkasten?»* — y observa: razonamiento → `search_notes` → `get_note` → una respuesta con [1][2][3].

Eso es todo. Tus notas nunca se modifican — Semlink solo lee.

## ✨ Funciones

### 🕵️ Un agente con herramientas, no un chatbot

Nueve herramientas integradas — búsqueda semántica, leer nota, leer sección, notas similares, grep con regex, listado del índice (con marcas de tiempo), conciencia de la nota actual — y el modelo decide qué consultar mientras responde. No recupera tres fragmentos y alucina sobre ellos; busca, lee la sección correcta y muestra cada paso.

### 🔍 Búsqueda semántica que lo alcanza todo

Consulta por significado, no por palabras clave — una consulta en lenguaje natural llega a cada nota que has escrito jamás. Las sugerencias de notas similares y el grep con regex están ahí para cuando *sí* conoces la cadena exacta.

### 🪟 Un ciudadano de la bóveda

- **Arrastrar y soltar**: suelta una nota en cualquier parte del panel para adjuntarla — los `[[wiki-enlaces]]` se resuelven en línea
- **Guarda respuestas como notas**: un clic, de vuelta a tu bóveda
- **Un contexto que puedes ver**: un anillo de contexto en tiempo real muestra cuán llena está la ventana del modelo, con la tasa de acierto de caché al lado — así sabes por qué una respuesta se quedó superficial antes de culpar al modelo
- **Tarjetas de preguntas de inicio**: ejemplos curados, algunos extraídos de tus propias notas recientes

### ⚡ Indexado en tiempo real

Los cambios de archivos se detectan automáticamente y se vuelven a vectorizar mientras escribes — y el indexado se aparta mientras trabajas, así que el editor nunca sufre tirones.

### 🌍 11 idiomas

English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português, Italiano, Русский — elige en Ajustes → General.

## 🤖 Trae tu propio modelo

Funciona cualquier endpoint compatible con OpenAI o Anthropic: DeepSeek (preconfigurado), SiliconFlow, GLM, OpenAI, Anthropic, Ollama, LM Studio, OpenRouter — tus claves, tus tarifas, cambio ilimitado. Lo que importa:

- **Modelo de chat**: el contexto largo ayuda — las respuestas citan tus notas con extensión
- **Modelo de embeddings**: BGE-M3 (1024 dimensiones) preconfigurado vía SiliconFlow; sirve cualquier endpoint de embeddings compatible
- El uso de los modelos lo factura tu proveedor — Semlink jamás ve un céntimo de ello

## 🌐 MCP — dale memoria a tus otras IAs

Las mismas herramientas se entregan como un servidor MCP local, para que Claude Desktop, Claude Code y Cursor también puedan buscar y citar tu bóveda:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Solo localhost, clave de acceso opcional. Sin relé en la nube.

## ⭐ Pro — gratis donde importa

El núcleo es gratis para siempre, prometido dentro de la propia app: búsqueda semántica, chat con el agente completo, indexado, MCP — ilimitado, sin cronómetro de prueba. Los tokens de los modelos los factura tu proveedor, nunca nosotros.

[Pro](https://getsemlink.com) es una **licencia de pago único** (sin suscripción): historial de chat ilimitado más gestión del historial — búsqueda, fijado, carpetas.

## ❓ FAQ

**¿Mis datos se envían a algún sitio?**
Tu índice vive en `data/`, dentro de la carpeta del plugin, en tu disco. Las únicas llamadas de red van a los proveedores que *tú* configuras. Consulta la [política de privacidad](https://getsemlink.com/privacy.html).

**¿En qué se diferencia de Copilot para Obsidian?**
En la transparencia y el bucle de agente: ves el razonamiento y cada llamada a herramientas, el modelo elige qué notas leer y las respuestas citan notas concretas que puedes abrir. Si Copilot te funciona, quédatelo — Semlink es para cuando quieres ver el trabajo.

**¿Necesito una API key?**
Sí — Semlink funciona con tu propia clave por diseño (bring-your-own-key). Los niveles gratuitos (SiliconFlow, Groq…) sirven perfectamente tanto para embeddings como para chat.

**¿Dónde vive el índice?**
En `data/vault.db` (SQLite) y `data/vectors.bin`, dentro de la carpeta del plugin. Bórralos y reindexa cuando quieras; nada sale jamás de tu equipo.

**¿Qué modelo debería usar?**
Cualquier modelo de chat de contexto largo que te guste — las respuestas citan tus notas con extensión. Los embeddings son baratos e infrecuentes (BGE-M3).

## 🛠 Comandos

| Comando | Qué hace |
|---|---|
| Semlink: Abrir barra lateral de búsqueda semántica | Abre el panel de chat lateral |
| Semlink: Reindexado completo | Vuelve a escanear todos los archivos |
| Semlink: Iniciar/Pausar indexado | Controla el indexado |
| Semlink: Iniciar/Detener servicio MCP | Alterna el servidor MCP |
| Semlink: Activar/desactivar registro de depuración | Diagnósticos detallados en consola |
| Semlink: Ver progreso del indexado | Abre el panel de progreso |

## 📜 Licencia

MIT — consulta [LICENSE](LICENSE). La licencia Pro opcional es una compra de pago único y jamás una suscripción.
