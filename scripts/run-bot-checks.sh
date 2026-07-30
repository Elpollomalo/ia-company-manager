#!/bin/bash
# Corre la bateria de preguntas de auditoria contra cada bot en produccion.
# Cada proyecto se corre por separado y un fallo (ej. TourBrain sin su API key
# todavia) no debe tumbar la corrida del otro.
#
# balam-website se quito de esta lista el 30 julio 2026 -- se migro a tareas
# nativas del panel root (ponexo-root: generar preguntas con contexto real +
# enviarlas + resumen semanal, cada una editable). Sigue corriendo aqui solo
# para gnga-web3 y tourbrain mientras no se migran tambien.
cd /root/agente-constructor || exit 1

FECHA=$(date +%F)
BASE_URL="https://archivos.creativabalam.com.mx/files/bots"
FALLOS=""
ENLACES=""
for proyecto in gnga-web3 tourbrain; do
    if node scripts/dify-chat-check.js "$proyecto"; then
        ENLACES="${ENLACES}\\n${BASE_URL}/${proyecto}/preguntas-log/${FECHA}.md"
    else
        echo "aviso: fallo el chequeo de $proyecto (ver arriba)"
        FALLOS="$FALLOS $proyecto"
    fi
done

if [ -n "$FALLOS" ]; then
    node -e "require('./scripts/telegram-notify').notificar('⚠️ dify-bot-check: fallo el chequeo de:$FALLOS')"
else
    node -e "require('./scripts/telegram-notify').notificar('✅ dify-bot-check: gnga-web3 y tourbrain respondieron bien.$ENLACES')"
fi
