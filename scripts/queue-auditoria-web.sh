#!/bin/bash
# MIGRADO AL PANEL (4 agosto 2026).
#
# Esto corria en queue-auditoria-web.timer, fuera del panel: no aparecia como tarea,
# no se podia editar ni ver, y su historial no existia en ninguna pantalla.
# Carlos: "que todo viva en el panel".
#
# Ahora es una tarea del panel con zona rotativa (ver ponexo-root:
# lib/zonas.ts zonaDeHoy, lib/tareasEspeciales.ts, lib/programadas.ts).
# El timer de systemd sigue instalado pero DESACTIVADO, listo para reactivar
# con 'systemctl enable --now queue-auditoria-web.timer' si el panel llegara a fallar.
#
# No se borra este archivo para que quien lo busque encuentre esta nota en vez
# de nada -- y para no dejar el .service de systemd apuntando al vacio.
echo "queue-auditoria-web.sh: migrado al panel (ponexo-root). Nada que hacer aqui."
exit 0
