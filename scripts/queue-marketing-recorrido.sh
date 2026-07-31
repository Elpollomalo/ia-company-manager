#!/bin/bash
# MIGRADO AL PANEL ROOT (ponexo-root) el 31 julio 2026, con autorizacion
# explicita de Carlos. El recorrido diario de los 5 sitios ahora es la tarea
# "Recorrido diario" de la categoria Sitio de cada proyecto, editable (URL
# incluida) y con boton de correr. marketing-recorrido.timer quedo apagado.
#
# De paso se corrigio un bug latente: el proyecto Ponexo del panel es
# 'diagnostico-balam' en la cola y en el vault. Sin ese mapeo la tarea se
# habria encolado como 'ponexo' y escrito en la carpeta equivocada.
#
# Este script se deja en el repo por si hiciera falta volver atras.
echo "queue-marketing-recorrido.sh: migrado al panel root (ponexo-root). Nada que hacer aqui."
exit 0
