#!/bin/bash
# MIGRADO AL PANEL ROOT (ponexo-root) el 31 julio 2026, con autorizacion
# explicita de Carlos. Los tres bots (balam-website, gnga-web3, tourbrain)
# ahora corren como tareas editables del panel, cada una con su propio
# renglon y boton de correr:
#   - "Preguntas fijas"          -> las mismas de PREGUNTAS_AUDITORIA de
#                                   scripts/dify-chat-check.js, ahora
#                                   editables desde el panel
#   - "Generar preguntas variables" -> un agente investiga y propone
#   - "Preguntas variables"      -> las manda al bot
# dify-bot-check.timer quedo apagado (systemctl disable --now). Este script
# se deja en el repo por si hiciera falta volver atras; scripts/dify-chat-check.js
# sigue intacto y se puede correr a mano: node scripts/dify-chat-check.js <proyecto>
echo "run-bot-checks.sh: migrado al panel root (ponexo-root). Nada que hacer aqui."
exit 0
