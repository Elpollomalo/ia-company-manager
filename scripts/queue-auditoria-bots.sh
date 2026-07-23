#!/bin/bash
# Encola la revision periodica de calidad de cada bot (agente auditoria-bots).
cd /root/agente-constructor || exit 1
node -e "require(\"./queue\").agregarTarea(\"auditoria-bots\", \"gnga-web3\", \"Revisa el registro acumulado de vault/5-bot-logs/gnga-web3/ desde el ultimo reporte en vault/5-bot-logs/gnga-web3/reportes/, compara contra el system prompt real y el cerebro, y deja tu reporte con propuestas concretas.\")"
node -e "require(\"./queue\").agregarTarea(\"auditoria-bots\", \"tourbrain\", \"Revisa el registro acumulado de vault/5-bot-logs/tourbrain/ desde el ultimo reporte en vault/5-bot-logs/tourbrain/reportes/, compara contra el system prompt real y el cerebro, y deja tu reporte con propuestas concretas. Si no hay logs todavia (bloqueado por falta de DIFY_CHAT_API_KEY_TOURBRAIN), repórtalo como bloqueante en vez de forzar un analisis sin datos.\")"
