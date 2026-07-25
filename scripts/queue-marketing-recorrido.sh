#!/bin/bash
# Encola el recorrido diario de marketing: visita el sitio real de cada proyecto
# y deja notas de lo que encuentra en vault/6-web-notes/{proyecto}/{fecha}.md.
cd /root/agente-constructor || exit 1

node -e "require('./queue').agregarTarea('marketing', 'gnga-web3', 'Recorrido diario. Visita https://gnga.tech con fetch_url y registra tus notas en vault/6-web-notes/gnga-web3/ (Tarea 2 de tu playbook).').then(() => process.exit(0))"
node -e "require('./queue').agregarTarea('marketing', 'creativa-balam', 'Recorrido diario. Visita https://creativabalam.com.mx con fetch_url y registra tus notas en vault/6-web-notes/creativa-balam/ (Tarea 2 de tu playbook).').then(() => process.exit(0))"
node -e "require('./queue').agregarTarea('marketing', 'diagnostico-balam', 'Recorrido diario. Visita https://diagnostico.creativabalam.com.mx con fetch_url y registra tus notas en vault/6-web-notes/diagnostico-balam/ (Tarea 2 de tu playbook). Si el deploy todavia no existe (DEPLOYMENT_NOT_FOUND), registralo como tal, sin forzar nada mas.').then(() => process.exit(0))"
node -e "require('./queue').agregarTarea('marketing', 'tourbrain', 'Recorrido diario. Visita https://tourbrain-app.vercel.app con fetch_url y registra tus notas en vault/6-web-notes/tourbrain/ (Tarea 2 de tu playbook).').then(() => process.exit(0))"
node -e "require('./queue').agregarTarea('marketing', 'tourquesa', 'Recorrido diario. Visita https://tourquesa.vercel.app con fetch_url y registra tus notas en vault/6-web-notes/tourquesa/ (Tarea 2 de tu playbook).').then(() => process.exit(0))"
