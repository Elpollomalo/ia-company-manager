# Prueba del candado de buzón

Lote fijo para comprobar que `enviar-diario.js` **no manda** un correo a un buzón
que no existe. No se usa en producción: es la evidencia de que el candado 3 y el
registro `SALTADO` funcionan.

Tres destinatarios:

| correo | qué prueba |
|---|---|
| `info@spanishschools.com.mx` | rebote real del 3 nov 2026 (Rackspace, 550 5.1.1) |
| `buzon-que-no-existe-8f3a2b9c@gmail.com` | buzón inventado en un proveedor grande (Gmail, 550 5.1.1) |
| `cristina@cedral.com` | control: buzón válido, **no** debe ser bloqueado |

Cómo correrlo (no envía nada: la API key va falsa y Telegram apagado):

```bash
cd /root/agente-constructor
rm -f prospeccion-diaria/prueba-candado-buzon/enviados.log
TELEGRAM_BOT_TOKEN='' TELEGRAM_CHAT_ID='' RESEND_API_KEY='clave-falsa-de-prueba' \
NODE_PATH=/root/agente-constructor/node_modules \
PROSPECCION_DIA=prueba-candado-buzon node prospeccion-diaria/enviar-diario.js auto
```

Resultado esperado en `enviados.log`:

```
SALTADO info@spanishschools.com.mx  buzón inexistente (550 5.1.1 ...)
SALTADO buzon-que-no-existe-8f3a2b9c@gmail.com  buzón inexistente (550 5.1.1 ...)
FALLO cristina@cedral.com  {"message":"API key is invalid",...,"statusCode":401}
```

Los dos muertos se saltan; el válido **sí intenta salir** (truena sólo por la key
falsa). Eso es exactamente lo que tiene que pasar.

`PROSPECCION_DIA` es la variable que permite apuntar el envío a otra carpeta de
día; existe por esta prueba y sirve igual para reprocesar un lote.
