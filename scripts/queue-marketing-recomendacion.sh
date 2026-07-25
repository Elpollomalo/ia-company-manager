#!/bin/bash
# Encola la recomendacion semanal de marketing: revisa los recorridos diarios
# acumulados de la semana y deja un reporte en vault/6-web-notes/{proyecto}/reportes/.
cd /root/agente-constructor || exit 1

for proyecto in gnga-web3 creativa-balam diagnostico-balam tourbrain tourquesa; do
    node -e "require('./queue').agregarTarea('marketing', '$proyecto', 'Recomendacion semanal. Revisa los recorridos diarios acumulados en vault/6-web-notes/$proyecto/ de esta ultima semana y deja tu reporte en vault/6-web-notes/$proyecto/reportes/ (Tarea 3 de tu playbook).').then(() => process.exit(0))"
done
