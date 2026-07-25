#!/bin/bash
# Encola la investigacion mensual de que giros/industrias pagan mas por publicidad digital.
# No cambia dia a dia, por eso corre mensual (no diario) - ver investigacion-mercado.timer.
cd /root/agente-constructor || exit 1

node -e "require('./queue').agregarTarea('investigadores', 'investigacion-mercado', 'Investiga que giros/industrias pagan mas por publicidad digital (costo por clic/impresion). Fuente de referencia: https://www.wordstream.com/blog/ws/2016/02/29/google-adwords-industry-benchmarks (usa fetch_url sobre esa URL). Si conoces o encuentras otras fuentes publicas de benchmarks reales durante la lectura, puedes citarlas tambien, pero no inventes datos que no leiste. Tema para la carpeta de salida: costo-publicidad-por-giro.').then(() => process.exit(0))"
