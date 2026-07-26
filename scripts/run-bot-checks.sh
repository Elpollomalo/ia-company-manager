#!/bin/bash
# Corre la bateria de preguntas de auditoria contra cada bot en produccion.
# Cada proyecto se corre por separado y un fallo (ej. TourBrain sin su API key
# todavia) no debe tumbar la corrida del otro.
cd /root/agente-constructor || exit 1

FALLOS=""
for proyecto in gnga-web3 tourbrain balam-website; do
    if ! node scripts/dify-chat-check.js "$proyecto"; then
        echo "aviso: fallo el chequeo de $proyecto (ver arriba)"
        FALLOS="$FALLOS $proyecto"
    fi
done

if [ -n "$FALLOS" ]; then
    node -e "require('./scripts/telegram-notify').notificar('⚠️ dify-bot-check: fallo el chequeo de:$FALLOS')"
else
    node -e "require('./scripts/telegram-notify').notificar('✅ dify-bot-check: gnga-web3, tourbrain y balam-website respondieron bien.')"
fi
