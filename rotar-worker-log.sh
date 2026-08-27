#!/bin/bash
# Rota worker.log semanalmente. Corre por cron, 30 min antes de la tarea
# "Revisión de errores de API" (mantenimiento/ponexo, domingos 8:30am) para
# que el agente siempre lea un log de máximo una semana, nunca todo el
# historial.
#
# Por qué "copytruncate" y no mover/renombrar el archivo: worker.log lo
# escribe systemd con `StandardOutput=append:worker.log` (ver
# /etc/systemd/system/ia-company-worker.service). Systemd mantiene el
# descriptor de archivo abierto sobre el inodo original -- si el archivo se
# renombra o se borra, systemd sigue escribiendo en el archivo viejo (ahora
# sin nombre) y el `worker.log` nuevo se queda vacío para siempre, sin que
# nadie lo note hasta la próxima corrida de mantenimiento.
#
# copytruncate evita eso: se copia el contenido actual, se comprime aparte,
# y el archivo ORIGINAL se vacía en el lugar (mismo inodo, mismo descriptor).
# El worker sigue escribiendo ahí sin enterarse ni necesitar reiniciarse.
# Riesgo aceptado: una línea escrita justo entre la copia y el vaciado puede
# quedar duplicada en el archivo y en el log nuevo -- nunca perdida, y es el
# mismo trade-off que usa `logrotate` con esta misma opción.
#
# Pasó el 23 agosto 2026: worker.log llevaba 27 días sin rotarse (la única
# rotación existente, worker.log.hasta-2026-07-31.gz, se hizo a mano una vez)
# y creció a 6.8 MB / 17,277 líneas -- bastante para que el agente
# `mantenimiento`, que lee el archivo completo antes de filtrar por fecha,
# mandara 2.4 millones de tokens a DeepSeek y fallara 3 veces seguidas.

set -euo pipefail
cd /root/agente-constructor

ARCHIVO="worker.log"
[ -s "$ARCHIVO" ] || exit 0  # nada que rotar si está vacío o no existe

FECHA=$(date +%Y-%m-%d)
DESTINO="worker.log.hasta-${FECHA}.gz"

gzip -c "$ARCHIVO" > "$DESTINO"
: > "$ARCHIVO"

echo "[$(date -Iseconds)] worker.log rotado a $DESTINO" >> "$ARCHIVO"
