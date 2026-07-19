# 🏛️ Estatuto del Sistema (House Rules)

- REGLA DE ORO: Sin fuente, no hay nota. Si una información no está en 'vault/sources/' o 'vault/0-raw/', NO EXISTE. Está prohibido inventar o asumir.
- INTOCABLE: Nunca se modifican ni editan los archivos dentro de 'vault/sources/'. Son de solo lectura.
- SEGURIDAD: Ante cualquier acción destructiva, ambigua o que requiera credenciales/dinero, detén el sistema inmediatamente y pregunta al usuario. Nunca asumas la intención.
- VERSIONADO DE VAULT: Hacer commit de 'vault/' después de cada corrida del worker, para poder revertir si un agente comete un error.
- ESTADO DE PROYECTOS: `vault/estado-proyectos/{proyecto}.md` es el tablero de control humano — dónde vamos, qué falta que el humano decida/pegue/haga, y qué sigue. Se actualiza cada vez que algo cambie de estado real (no se deja para "después"). No reemplaza a `vault/3-threads/` (el conocimiento profundo) — es el resumen de 30 segundos.
