#!/bin/bash
# Encola la prospeccion diaria de negocios en la Peninsula de Yucatan.
# Cambia de zona cada dia: dia-del-anio modulo numero de zonas de la lista.
# Dos etapas encoladas con el MISMO 'proyecto' (mismo slug de zona) para que
# el sistema las serialice - informes-prospeccion nunca corre antes que
# prospectores termine de escribir el crudo del dia (ver ejecutarSerializadoPorProyecto
# en worker.js).
cd /root/agente-constructor || exit 1

ZONAS=(merida cancun playa-del-carmen tulum chetumal campeche valladolid cozumel progreso bacalar)
NOMBRES=("Mérida" "Cancún" "Playa del Carmen" "Tulum" "Chetumal" "Campeche" "Valladolid" "Cozumel" "Progreso" "Bacalar")

DIA_DEL_ANIO=$(date +%j)
INDICE=$((10#$DIA_DEL_ANIO % ${#ZONAS[@]}))
ZONA_SLUG="${ZONAS[$INDICE]}"
ZONA_NOMBRE="${NOMBRES[$INDICE]}"
FECHA=$(date +%Y-%m-%d)
PROYECTO="prospeccion-${ZONA_SLUG}"

node -e "require('./queue').agregarTarea('prospectores', '$PROYECTO', 'Zona de hoy: $ZONA_NOMBRE, Yucatán, México. Busca negocios reales en esa zona (turismo, restaurantes, hoteles, servicios, comercio - variedad razonable), visita sus sitios, y deja el registro crudo en vault/7-prospeccion-negocios/$ZONA_SLUG/$FECHA-crudo.md, tal como indica tu playbook.').then(() => process.exit(0))"
node -e "require('./queue').agregarTarea('informes-prospeccion', '$PROYECTO', 'Procesa vault/7-prospeccion-negocios/$ZONA_SLUG/$FECHA-crudo.md (recien escrito por prospectores) y deja el informe final en vault/7-prospeccion-negocios/$ZONA_SLUG/informes/$FECHA.md, tal como indica tu playbook.').then(() => process.exit(0))"
