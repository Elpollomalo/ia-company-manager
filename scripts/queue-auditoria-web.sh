#!/bin/bash
# Encola la auditoria diaria de PageSpeed sobre los sitios ya prospectados de una zona.
#
# A diferencia de queue-prospeccion-negocios.sh (que rota sobre una lista fija de 10 zonas),
# aqui la rotacion es solo sobre las zonas que YA TIENEN un informe de prospeccion. Si rotara
# sobre la lista fija, la mayoria de los dias caeria en una zona todavia sin prospectar y no
# haria nada: la prospeccion visita cada zona cada 10 dias, asi que las zonas con datos van
# apareciendo de a poco. Rotando sobre las que existen, el cron siempre hace trabajo util y
# se reparte parejo entre ellas.
#
# Toma el informe de prospeccion MAS RECIENTE de esa zona (no el de hoy: la prospeccion de
# una zona corre cada 10 dias, no diario).
cd /root/agente-constructor || exit 1

FECHA=$(date +%Y-%m-%d)

# Zonas con al menos un informe de prospeccion, en orden alfabetico estable.
ZONAS_CON_DATOS=()
for dir in vault/7-prospeccion-negocios/*/; do
  slug=$(basename "$dir")
  if ls "$dir"informes/*.md >/dev/null 2>&1; then
    ZONAS_CON_DATOS+=("$slug")
  fi
done

if [ ${#ZONAS_CON_DATOS[@]} -eq 0 ]; then
  echo "Todavia no hay ningun informe de prospeccion — no se encola nada."
  exit 0
fi

DIA_DEL_ANIO=$(date +%j)
INDICE=$(( 10#$DIA_DEL_ANIO % ${#ZONAS_CON_DATOS[@]} ))
ZONA_SLUG="${ZONAS_CON_DATOS[$INDICE]}"
ZONA_NOMBRE="$ZONA_SLUG"

DIR_INFORMES="vault/7-prospeccion-negocios/${ZONA_SLUG}/informes"
ULTIMO_INFORME=$(ls -1 "$DIR_INFORMES"/*.md 2>/dev/null | sort | tail -1)

if [ -z "$ULTIMO_INFORME" ]; then
  echo "Sin informes de prospeccion para ${ZONA_SLUG} — no se encola nada."
  exit 0
fi

echo "Auditando ${ZONA_NOMBRE} con ${ULTIMO_INFORME}"

node -e "require('./queue').agregarTarea('auditoria-web', 'auditoria-web-${ZONA_SLUG}', 'Zona: ${ZONA_NOMBRE}. Lee el informe de prospeccion ${ULTIMO_INFORME} y mide con pagespeed_check los sitios web de los negocios que ahi aparezcan. Deja el informe final en vault/9-auditoria-web/${ZONA_SLUG}/${FECHA}.md, tal como indica tu playbook.').then(() => process.exit(0))"
