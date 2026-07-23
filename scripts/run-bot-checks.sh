#!/bin/bash
# Corre la bateria de preguntas de auditoria contra cada bot en produccion.
# Cada proyecto se corre por separado y un fallo (ej. TourBrain sin su API key
# todavia) no debe tumbar la corrida del otro.
cd /root/agente-constructor || exit 1
for proyecto in gnga-web3 tourbrain; do
    node scripts/dify-chat-check.js "$proyecto" || echo "aviso: fallo el chequeo de $proyecto (ver arriba)"
done
