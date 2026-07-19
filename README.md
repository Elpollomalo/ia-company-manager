# 🤖 ia-company-manager

Sistema multi-agente genérico y agnóstico para la gestión de proyectos a través de un pipeline de refinamiento de datos por etapas, orquestado con colas (BullMQ + Redis) y ejecutado por agentes de Claude con acceso real a herramientas de filesystem.

- Operando localmente en Linux Mint mediante Claude Code.
- Estructura desacoplada: los agentes procesan procesos puros; el contexto de cada proyecto se inyecta dinámicamente desde `vault/sources/`.

---

## Arquitectura

```
ingest.js ──▶ vault/0-raw/ ──▶ [Redis / BullMQ] ──▶ worker.js ──▶ Claude (Sonnet 5)
                                                          │
                                                          ├─ lee house-rules.md + agents/{agente}.md + vault/sources/{proyecto}/
                                                          ├─ invoca herramientas reales: list_files, read_file, write_file
                                                          └─ escribe solo dentro de las rutas autorizadas del agente (write_paths)
```

**Flujo de un dato, de principio a fin:**

1. Se deja una nota cruda (`.md`/`.txt`) en `vault/0-raw/`.
2. `ingest.js` la detecta, identifica a qué proyecto pertenece por el nombre del archivo, **mueve** el archivo a `vault/sources/{proyecto}/` (nunca lo borra — necesita quedar como fuente verificable) y encola una tarea para el agente `catalogadores` en Redis.
3. `worker.js` (BullMQ Worker) toma la tarea de la cola, arma el contexto del agente (estatutos + playbook + fuentes del proyecto) y llama a Claude con acceso a herramientas de filesystem reales.
4. El agente actúa: explora el vault, lee fuentes, y solo escribe dentro de las carpetas que su playbook autoriza (`write_paths`). Cualquier intento fuera de esas rutas es rechazado en código, no solo por instrucción.
5. Se guarda un resumen legible de cada corrida en `vault/1-desk/` (qué hizo el agente, qué herramientas invocó).
6. `vault/` se commitea al repo privado después de cada corrida, para poder revertir si un agente comete un error (ver `house-rules.md`).

---

## Estructura de carpetas

```
ia-company-manager/
├── config.js          # Conexión a Redis (ioredis)
├── queue.js            # Productor: agregarTarea(agente, proyecto, tarea) → encola en BullMQ
├── worker.js            # Consumidor: loop agéntico con tool-use real contra el filesystem
├── ingest.js             # Escanea vault/0-raw/, detecta proyecto, mueve fuente y encola tarea
├── trigger.js             # Dispara una tarea de prueba manual a la cola
│
├── house-rules.md          # Estatuto del sistema — se inyecta en TODAS las llamadas a Claude
│
├── agents/                  # Playbooks — un rol por archivo, con frontmatter de configuración
│   ├── scouts.md
│   ├── catalogadores.md
│   ├── cartografos.md
│   ├── criticos.md
│   ├── editores.md
│   ├── programadores.md
│   ├── marketing.md
│   └── auditoria.md
│
└── vault/                    # 🔒 Repo git PRIVADO independiente (ia-company-manager-vault)
    ├── 0-raw/                  # Bandeja de entrada de notas crudas (se vacía tras ingest.js)
    ├── 1-desk/                  # Resumen de cada corrida del worker (salida temporal/auditoría)
    ├── 2-atoms/                   # Notas atómicas — una idea por archivo, con [[wikilinks]]
    ├── 3-threads/                  # Documentos vivos por proyecto, síntesis de clusters de átomos
    ├── sources/                     # Fuentes reales por proyecto — solo lectura, nunca se editan
    ├── briefings/                     # Reportes diarios/de auditoría (editores, auditoria)
    ├── estado-proyectos/               # Tablero de control humano: un archivo corto por proyecto
    │                                     # (dónde vamos, qué falta que el humano haga/decida/pegue)
    └── 4-bot-brain/                     # Documentos breves por tema, en lenguaje simple, para que
                                            # un bot conversacional los use como contexto — cada uno
                                            # remite a vault/3-threads/ para el detalle completo
```

> `sources/` y `briefings/` viven **dentro** de `vault/` (no en la raíz) para que un único repo privado respalde todo el material confidencial del sistema — incluidos los reportes de auditoría, que pueden contener análisis de negocio real (precios, decisiones) de un proyecto.

---

## Los agentes

Cada archivo en `agents/` es un playbook con frontmatter de configuración + instrucciones de rol:

```
---
temperature: 0            # 0 = preciso/determinista, >0 = con voz propia (ver nota abajo)
write_paths: vault/2-atoms, vault/1-desk    # únicas rutas donde este agente puede escribir
---
# Nombre del rol
## Misión / Antes de actuar / Proceso / Autoridad de escritura / Límites y seguridad
```

| Agente | Rol | Escribe en |
|---|---|---|
| `scouts` | Captura fuentes externas (links/referencias) y las guarda con metadata | `vault/sources/`, `vault/1-desk/` |
| `catalogadores` | Convierte fuentes en notas atómicas (una idea por archivo) | `vault/2-atoms/`, `vault/1-desk/` |
| `cartografos` | Enlaza notas atómicas relacionadas con `[[wikilinks]]` | `vault/2-atoms/`, `vault/1-desk/` |
| `criticos` | Detecta contradicciones entre notas, marca `[FRICTION]`, nunca resuelve solo | `vault/2-atoms/`, `vault/1-desk/` |
| `editores` | Sintetiza clusters de átomos en threads por proyecto + briefing diario | `vault/3-threads/`, `vault/briefings/`, `vault/1-desk/` |
| `programadores` | Construye/mantiene código, siempre en staging, nunca deploy sin aprobación | `vault/1-desk/` |
| `marketing` | Redacta borradores de cara afuera basados solo en `vault/3-threads/`, deja en cola de aprobación | `vault/1-desk/` |
| `auditoria` | Barrido periódico del vault (huérfanas, `[FRICTION]` sin resolver, notas sin fuente); reporte dual (briefing + notifica al asistente principal) | `vault/briefings/` |

**Nota sobre `temperature`:** `claude-sonnet-5` ya no acepta ese parámetro en la API (la rechaza con 400). El valor en el frontmatter se usa como *clasificación* — si es mayor a 0, `worker.js` inyecta una instrucción de prompt pidiendo voz propia y variación, en vez de un parámetro numérico de sampling.

**Autoridad de escritura real, no solo por instrucción:** `worker.js` lee `write_paths` del frontmatter y lo hace cumplir en código — la herramienta `write_file` rechaza cualquier ruta fuera de esa lista antes de tocar el disco, sin importar lo que el modelo intente.

---

## Herramientas del agente (tool-use)

`worker.js` corre un loop agéntico real (hasta 15 turnos por tarea) dándole a Claude 3 herramientas:

- **`list_files(ruta)`** — lista archivos/carpetas relativas a la raíz del proyecto.
- **`read_file(ruta)`** — lee el contenido completo de un archivo.
- **`write_file(ruta, contenido)`** — crea/sobreescribe un archivo, solo si `ruta` está dentro de las `write_paths` del agente.

Todas las rutas se resuelven de forma segura (`resolverRutaSegura`) para impedir salir de la raíz del proyecto.

---

## Las 2 reglas de oro (`house-rules.md`)

1. **Sin fuente, no hay nota** — si algo no está en `vault/sources/` o `vault/0-raw/`, no existe. Prohibido inventar o asumir.
2. **`vault/sources/` es de solo lectura** — ningún agente lo modifica jamás.

Estas reglas se inyectan textualmente en el system prompt de **cada** llamada a Claude, sin importar el agente.

---

## Repositorios

| Repo | Visibilidad | Contenido |
|---|---|---|
| `github.com/Elpollomalo/ia-company-manager` | Público | Código: `worker.js`, `queue.js`, `config.js`, `ingest.js`, `trigger.js`, `agents/`, `house-rules.md` |
| `github.com/Elpollomalo/ia-company-manager-vault` | **Privado** | `vault/` completo — datos reales de cada proyecto, nunca sale de aquí |

`vault/` es un repositorio git **independiente** anidado dentro del proyecto (no un submódulo) — se commitea/pushea por separado, típicamente después de cada corrida del worker.

---

## Setup

```bash
npm install
```

Variables de entorno (`.env`, nunca se sube — ya está en `.gitignore`):

```
ANTHROPIC_API_KEY=sk-ant-...
WORKER_CONCURRENCY=3       # opcional, default 3
REDIS_HOST=127.0.0.1        # opcional, default 127.0.0.1
REDIS_PORT=6379               # opcional, default 6379
```

Requiere una instancia de Redis corriendo localmente (o accesible vía `REDIS_HOST`/`REDIS_PORT`).

### Correr el sistema

```bash
node worker.js      # levanta el orquestador, queda escuchando la cola
node ingest.js       # procesa notas nuevas en vault/0-raw/ y las encola
node trigger.js       # dispara una tarea de prueba manual
```
