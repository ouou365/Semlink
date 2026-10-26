# 🧠 Semlink — Agentic Knowledge Workspace (Espacio de trabajo de conocimiento agéntico)

**Haz que tu bóveda de Obsidian piense, colabore y actúe.**

**Español** | [English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Français](README_fr.md) | [Português](README_pt.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

Semlink convierte tu bóveda de Obsidian en un espacio de trabajo de conocimiento agéntico — un asistente de IA que vive en tu barra lateral, busca todo lo que has anotado jamás, razona sobre ello con herramientas reales, respalda cada afirmación con citas a tus propias notas y comparte lo que aprende. Todo el agente viene dentro del plugin: nada de Claude Desktop, ni Cursor, ni terminal, ni cliente de terceros que instalar. Trae tu propia API key, y tu bóveda empieza a pensar.

## 🤔 ¿Por qué Semlink?

Llevas años escribiendo. Luego haces una pregunta sobre tu propio conocimiento — y el flujo de trabajo es: recordar qué carpeta, Ctrl+F, copiar y pegar en una ventana de chat, perder el hilo.

La mayoría de los plugins de IA para Obsidian dependen de clientes de agente de terceros — y esos clientes son aplicaciones de agente construidas para programar. Lo que obtienes es un asistente de programación que pasa por tus notas, no un agente que trabaje de verdad dentro de ellas.

Semlink está construido al revés:

**El espacio de trabajo es la bóveda, y el agente está integrado — no atornillado.** Instala el plugin, pega tu clave, pregunta. El agente piensa, llama a herramientas, lee tus notas y responde con citas numeradas — enteramente dentro de Obsidian. No tienes que fiarte de la respuesta. La ves construirse en directo y luego la compruebas.

### Semlink frente a Copilot for Obsidian

| | Semlink | Copilot for Obsidian |
|---|---|---|
| Cero herramientas externas | ✅ Agente, RAG y compartir, todo integrado en el plugin | ❌ El agente requiere opencode, el RAG requiere Miyo — instalaciones separadas |
| Bucle de agente (buscar → leer → razonar) | ✅ 9 herramientas, el modelo decide qué leer | 🟡 Enrutado a través de un cliente externo |
| Transparencia del razonamiento | ✅ Razonamiento + trazas de herramientas, en directo dentro del plugin | 🟡 El bucle ocurre fuera de Obsidian |
| Citas | ✅ Un registro de numeración por turno; haz clic en una cita para saltar a la nota de la que procede | 🟡 Las notas de origen, listadas |
| Compartir una respuesta | ✅ Página web en la LAN + código QR, revoca cuando quieras | ❌ Copiar y pegar |
| Otras IAs pueden leer tu bóveda (MCP) | ✅ Servidor local integrado | ❌ |

### Decisiones tomadas a propósito

🧠 **El agente es residente, no visitante.** Todo lo que el agente necesita — búsqueda, herramientas, traza de razonamiento, citas, compartir — viene en el plugin. Los clientes de IA externos son bienvenidos vía MCP, pero son una ventaja opcional, nunca un requisito.

🗄️ **Local primero, estructuralmente.** Tu índice es un archivo SQLite en tu propio disco. No existe ningún servidor de Semlink — no es «prometemos no subir tus notas», es que literalmente no hay ningún sitio al que subirlas.

🔑 **BYOK, sin tanteos.** Un catálogo de 24 proveedores de chat (más de 1.800 modelos con precios y ventanas de contexto) y un catálogo dedicado de proveedores de embeddings te dejan configurado en un par de clics; los runtimes locales como Ollama funcionan sin clave alguna. Semlink no añade recargo y jamás toca tus tokens — tu proveedor te factura directamente.

🪟 **Un ciudadano de la bóveda.** Arrastra una nota al chat para adjuntarla, guarda las respuestas como notas, mira llenarse el anillo de contexto en tiempo real. El indexado se aparta mientras escribes. El espacio de trabajo vive donde tus notas ya viven — nada que exportar, nada que sincronizar.

## ✨ Funciones destacadas

### 🔗 Citas que de verdad puedes seguir

Cada turno ejecuta un único registro de numeración que atraviesa la traza de razonamiento, el cuerpo de la respuesta y las tarjetas de origen — el `[3]` de la respuesta es el mismo `[3]` que viste leer al modelo. Haz clic en una cita y Obsidian abre la nota en el punto exacto del que procede. Una respuesta solo vale lo que valen las notas con las que puedes contrastarla — así que contrástala.

### 📡 Comparte una respuesta sin exportar nada

¿Has encontrado algo que merece la pena mostrar? Un clic publica el intercambio completo — pregunta, traza de razonamiento, respuesta, tarjetas de origen — como una página web limpia en tu LAN. Envía el enlace o el código QR; quien lo reciba lo abre en cualquier navegador, sin Obsidian, sin cuenta, sin instalación. Deja de compartir y la página desaparece. Nada sale jamás de tu red.

### 🪟 Mira trabajar al agente, en directo

La respuesta no es la única salida — el razonamiento también lo es. El razonamiento fluye según ocurre, cada llamada a herramientas (`search_notes` → `get_section` → …) queda registrada con su resultado, y el anillo de contexto muestra cuán llena está la ventana del modelo, tasa de acierto de caché incluida. Ves exactamente lo que vio el modelo, que es justamente la idea.

## 🚀 Inicio rápido

1. **Instala** — con un clic desde la [página del plugin](https://community.obsidian.md/plugins/semlink), o busca «Semlink» en Ajustes → Plugins comunitarios.
2. **Configura** — elige proveedores del catálogo (o pega un endpoint personalizado) y añade tu API key. El arranque guiado de tres pasos valida chat + embeddings e inicia el indexado.
3. **Pregunta.** Abre la barra lateral: *«¿Qué he escrito sobre Zettelkasten?»* — y observa: razonamiento → `search_notes` → `get_note` → una respuesta con [1][2][3].

Eso es todo. Sin cliente de agente, sin montar ningún servidor. Tus notas nunca se modifican — Semlink solo lee.

## 🧠 Pensar — un agente que muestra su trabajo

- **Nueve herramientas integradas**, y el modelo decide qué consultar mientras responde: búsqueda semántica, leer nota, leer sección, notas similares, grep con regex, listados del índice con marcas de tiempo, conciencia de la nota actual. No recupera tres fragmentos y alucina sobre ellos; busca, lee la sección correcta y muestra cada paso.
- **Un razonamiento que puedes inspeccionar.** Cada respuesta incluye el razonamiento del modelo y cada llamada a herramientas (`search_notes` → `get_section` → …), transmitidos en directo — no una caja negra segura de sí misma.
- **Citas que se sostienen.** Un único registro de numeración por turno abarca la traza de razonamiento, el cuerpo de la respuesta y las tarjetas de origen; haz clic en una cita para saltar directo a la nota (y a la línea) de la que procede.
- **Una búsqueda que lo alcanza todo**: consulta por significado en cada nota que has escrito jamás, con sugerencias de notas similares y grep con regex para cuando *sí* conoces la cadena exacta.

## 🤝 Colaborar — conocimiento que sale del silo (en tus términos)

- **Comparte una conversación por tu LAN**: un clic publica las preguntas y respuestas en una página web limpia — envía el enlace o el código QR, quien lo reciba lo abre en cualquier navegador, y revocas el acceso cuando quieras. Nada sale de tu red.
- **Las respuestas se vuelven notas**: guarda cualquier respuesta de vuelta en tu bóveda con un clic.
- **Adjunta arrastrando y soltando**: suelta una nota en cualquier parte del panel — los `[[wiki-enlaces]]` se resuelven en línea — y el agente la lee primero.
- **Opcional: deja entrar a tus otras IAs.** Las mismas herramientas se entregan como un servidor MCP local, para que Claude Desktop, Claude Code y Cursor también puedan buscar y citar tu bóveda. Estrictamente opcional — el agente integrado no necesita ayuda.

## ⚡ Actuar — control en tiempo real

- **Un panel de control RAG, no una barra de progreso**: métricas de la bóveda, progreso real de embeddings nota por nota, e interruptores de indexado / auto-embed que surten efecto de inmediato — incluso en plena ejecución.
- **Reconfigura sin ceremonias**: cambia el modelo de embeddings y un reindexado completo arranca automáticamente; la guía revalida tu clave y te lleva directo al paso correcto.
- **Indexado en tiempo real** que recoge cada cambio de archivo mientras escribes — y se aparta mientras tecleas, así que el editor nunca sufre tirones.
- **Control desde la paleta de comandos** sobre el indexado, MCP, el registro de depuración y el progreso.

## 🔑 BYOK — trae tu propia clave

Funciona cualquier endpoint compatible con OpenAI o Anthropic — DeepSeek, GLM, SiliconFlow, OpenAI, Anthropic, OpenRouter, Ollama, LM Studio y más de 1.800 más a través del catálogo integrado. Lo que importa:

- **Modelo de chat**: elige del catálogo con precios y ventanas de contexto a la vista, o añade un endpoint personalizado (incluidos los runtimes locales sin clave)
- **Modelo de embeddings**: un catálogo dedicado de proveedores de embeddings — SiliconFlow BGE-M3 preconfigurado; Jina, Voyage, Nomic, Mixedbread y más, o un endpoint de embeddings local sin clave
- **Tus claves, tus tarifas, cambio ilimitado** — el uso de los modelos lo factura tu proveedor; Semlink jamás ve un céntimo de ello

## 🌐 MCP — opcional, para tus otras IAs

El agente integrado es completo por sí solo. Si además usas Claude Desktop, Claude Code o Cursor, las mismas herramientas se exponen como un servidor MCP local:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Solo localhost, clave de acceso opcional. Sin relé en la nube.

## ❓ FAQ

**¿Necesito Claude Desktop, Cursor o cualquier otro cliente de IA?**
No. El agente completo — traza de razonamiento, llamadas a herramientas, citas, compartir — se ejecuta dentro del plugin. MCP existe para que las IAs externas *puedan* leer tu bóveda, nunca porque deban.

**¿Mis datos se envían a algún sitio?**
Tu índice vive en `data/`, dentro de la carpeta del plugin, en tu disco. Las únicas llamadas de red van a los proveedores que *tú* configuras. Lo compartido por LAN se queda en tu red. Consulta la [política de privacidad](https://getsemlink.com/privacy.html).

**¿En qué se diferencia de Copilot for Obsidian?**
Copilot enruta su agente a través de opencode y su RAG a través de Miyo — herramientas externas que instalas y ejecutas junto al plugin. Semlink mantiene todo el bucle dentro de Obsidian: ves el razonamiento y cada llamada a herramientas, el modelo elige qué notas leer y las respuestas citan notas concretas que puedes abrir. Si Copilot te funciona, quédatelo — Semlink es para cuando quieres el espacio de trabajo, no más clientes.

**¿Necesito una API key?**
Semlink es BYOK por diseño — pero «tu propia clave» incluye runtimes locales sin clave como Ollama, tanto para chat como para embeddings. Los niveles gratuitos de la nube (SiliconFlow, Groq…) también sirven.

**¿Dónde vive el índice?**
En `data/vault.db` (SQLite) y `data/vectors.bin`, dentro de la carpeta del plugin. Bórralos y reindexa cuando quieras; nada sale jamás de tu equipo.

**¿Qué modelo debería usar?**
Cualquier modelo de chat de contexto largo que te guste — las respuestas citan tus notas con extensión. Los embeddings son baratos e infrecuentes (BGE-M3).

## 📜 Licencia

MIT — consulta [LICENSE](LICENSE). La licencia Pro opcional es una compra de pago único y jamás una suscripción.
