# TourBrain Cozumel — Resumen Ejecutivo del Proyecto

*Documento de contexto actualizado — sesión de trabajo, 18 julio 2026*

---

## 1. Visión general

Infraestructura de IA conversacional para el sector turístico de Cozumel, con dos productos que comparten el mismo motor técnico pero se ejecutan como **bots completamente separados** (no un solo bot con lógica condicional):

1. **Bot 1 — Guía/catálogo general de Cozumel**: tono neutral, "embajador de la isla", accede a todo el catálogo de proveedores activos, recomienda, arma plan y permite reservar.
2. **Bot 2 — Concierge personalizado por hotel**: tono y marca del hotel específico, prioriza el proveedor propio del hotel (si lo tiene) y usa el catálogo general solo como respaldo.

Ambos bots comparten: la misma base de datos de proveedores, el mismo modelo de IA (DeepSeek), y la misma lógica de reservas/comisión. El catálogo general alimenta de proveedores validados (con historial y calificación real) a los concierges personalizados.

Cozumel es el laboratorio inicial; el modelo está pensado para replicarse en otros destinos una vez validado.

---

## 2. Producto 1 — Catálogo general de Cozumel

**Qué hace:** el turista entra (vía página web o WhatsApp), pregunta libremente, el bot recomienda, arma un plan y permite reservar de forma sencilla.

**Modelo de cobro a proveedores:**
- $25 USD/mes por listarse en el catálogo (ajustado desde $10 inicial — se determinó insuficiente considerando que el negocio debe ser sustentable, incluyendo financiar publicidad; se subirá paulatinamente)
- 10% de comisión sobre cada venta cerrada a través de la app
- Depósito de reserva: $10 USD por pax (parte de la comisión, no ingreso adicional)
- Garantía: devolución 100% si el tour no se realiza

**Estrategia de arranque:**
- Empezar por restaurantes (categoría más simple operativamente)
- Listado gratis por tiempo limitado al inicio (construir oferta antes de tener volumen); la comisión por venta se mantiene desde el día 1
- Ya identificados: restaurantes concretos y locales físicos donde colocar QR

**Canal de tráfico:**
- Se descartó publicidad pagada como primer canal (sin catálogo poblado, no convierte)
- Prioridad: QR en locales propios, grupos de Facebook/foros de turistas, red de contactos de Creativa Balam
- Pendiente: acceso a canal de alto volumen (muelle de cruceros — taxistas, vendedores, tour desks)

**Categorías del catálogo (ampliadas):**
Restaurantes, tours de snorkel/buceo, renta de equipo (buceo, snorkel, motos, bicicletas), transporte (taxis, traslados, renta de autos), playas/clubs de playa, compras/artesanías, vida nocturna/bares, spa/bienestar, excursiones en barco/catamarán, pesca deportiva, parques temáticos/naturales, fotografía/souvenirs, otro.

---

## 3. Producto 2 — Concierge personalizado por hotel

**Modelo de cobro:**
- Pago inicial: $200 USD (setup/configuración/personalización)
- Mensualidad: ~$100 USD/mes base, con esquema de dos niveles según consumo:
  - **Bajo uso** (pocas conversaciones/mes): ~$25-30 USD fijo
  - **Alto uso**: ~$50-70 USD fijo
- Comisión total sobre venta: 12-15%, repartida 60/40 o 70/30 a favor del hotel
- La comisión solo aplica sobre reservas cerradas a través de la app; lo que el proveedor haga fuera del sistema no se persigue

**Sobre el costo de IA/tokens:** se descartó que el hotel administre su propia cuenta de modelo de IA (fricción técnica alta para el perfil de cliente — hostales/hoteles chicos). En su lugar, Balam administra una sola cuenta de DeepSeek y absorbe/factura ese costo dentro de la estructura de niveles bajo/alto uso, evitando que el hotel perciba un cobro "técnico" alto.

**Construcción:** se arma sobre un "frame" o plantilla base reutilizable (lógica de negocio fija + bloque variable por hotel: nombre, tono, catálogo propio, políticas), no desde cero por cada hotel — esto mejora el margen del setup fee con cada hotel adicional.

---

## 4. Modelo de IA

- **DeepSeek** elegido como modelo para ambos bots — costo muy bajo ($0.14/$0.28 por millón de tokens entrada/salida aprox.) con calidad suficiente para tareas de recomendación conversacional
- Aprovechar "prompt caching" (contexto repetido del catálogo/políticas) para reducir el costo real muy por debajo del costo sin optimizar
- Plan de hacer pruebas comparativas con otros modelos (ej. Gemini Flash-Lite) una vez el sistema esté armado y en uso real, no antes

---

## 5. Canal de acceso del turista (rediseñado)

- **Punto de entrada: página web**, no solo WhatsApp — con chat embebido en la misma página (posible vía la publicación nativa de Dify como app web)
- Razón del cambio: solo ~30-32% de adultos en EE.UU. usa WhatsApp (la mayoría de cruceristas en Cozumel son estadounidenses); depender solo de WhatsApp pierde conversión con ese segmento
- Desde la página, el turista puede elegir **continuar la experiencia por WhatsApp** si lo prefiere (relevante para turistas mexicanos/latinoamericanos, con altísima adopción de WhatsApp) — la elección de canal se hace al inicio, no a medio camino, para evitar problemas de continuidad de contexto
- Al cerrar una reserva, el bot ofrece enviar confirmación/seguimiento por **WhatsApp o correo electrónico**, según preferencia del turista

**Diseño de la página (borrador):**
- Menú superior simple para navegar categorías
- Collage/carrusel de fotos de Cozumel (transición suave, sin video autoplay, para no sacrificar velocidad de carga)
- Mensaje de bienvenida / pregunta que invite a interactuar
- Botón de "Continuar por WhatsApp"
- Espacio de chat embebido para escribir directo

**Nota importante:** la IA/bot nunca manda al turista a la página de **proveedores** (el panel de alta/edición); esa es exclusiva para los prestadores de servicio. La página pública de cara al turista es un desarrollo distinto (aunque puede compartir la misma base de datos).

---

## 6. Reseñas y calificación

- Se construye sistema propio de calificación (estrellas + comentario opcional) para reservas hechas a través del bot — más confiable que reseñas externas porque son de gente verificada que reservó
- TripAdvisor: no se integran sus reseñas directamente (su API oficial requiere aprobación de partner, proceso lento, y plan gratuito muy limitado — solo 3 reseñas/2 fotos por lugar). En su lugar, se incluye un link directo al perfil de TripAdvisor del proveedor como referencia externa
- La calificación promedio del proveedor se calcula desde las reseñas propias y se usa tanto en la página pública como en la lógica de recomendación del bot

---

## 7. Estructura de base de datos

### Tabla `proveedores`
| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | |
| `nombre_negocio` | texto | |
| `categoria` | selector (ver lista ampliada arriba) | |
| `descripcion_corta` | texto (máx. 200 caract.) | |
| `fotos` | imagen (3-5) | |
| `precio_rango` | texto/número | |
| `ubicacion_lat` / `ubicacion_lng` | número | Pin de mapa |
| `whatsapp_contacto` | texto | |
| `horario` | texto simple | |
| `estado_suscripcion` | selector (activo/pendiente_pago/pausado) | Controla visibilidad en bot y página |
| `fecha_alta` | fecha (auto) | |
| `plan` | selector (gratis_fundador / $25 estándar) | |
| `link_tripadvisor` | URL | Opcional |
| `calificacion_promedio` | número (calculado) | Desde tabla `reservas` |

### Tabla `reservas`
| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | |
| `proveedor_id` | relación → `proveedores` | |
| `origen` | selector (catálogo_general / concierge_hotel) | |
| `hotel_id` | relación → `negocios_concierge` (si aplica) | |
| `metodo_contacto` | selector (whatsapp/correo) | |
| `contacto_valor` | texto | Número o email, según método elegido |
| `fecha_reserva` | fecha/hora | |
| `personas` | número | |
| `monto_total` | número | |
| `deposito_pagado` | número | |
| `comision_monto` | número (calculado) | |
| `estado` | selector (confirmada/cancelada/completada/reembolsada) | |
| `calificacion` | número (1-5) | Se llena post-experiencia |
| `comentario` | texto corto (opcional) | |

### Tabla `negocios_concierge` (producto 2)
| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | |
| `nombre_hotel` | texto | |
| `proveedor_preferido_id` | relación → `proveedores` (opcional) | |
| `whatsapp_bot` | texto | Número específico del concierge |
| `plan_pago` | selector (bajo_uso/alto_uso) | |
| `estado_pago` | selector | |

### Tabla `conversaciones`
| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | |
| `cliente_contacto` | texto | |
| `mensaje` | texto | |
| `rol` | selector (usuario/bot) | |
| `timestamp` | fecha/hora (auto) | |
| `origen` | selector (catálogo_general/concierge_hotel) | |

---

## 8. Herramientas y decisiones técnicas

- **Panel de proveedores + página pública**: Softr (plan gratuito para arrancar, hasta 10 usuarios; sube a plan de pago $49-59/mes al superar ese límite). Se evaluó y descartó WordPress (Directorist/HivePress) por esta fase — velocidad similar, pero WordPress añade responsabilidad de hosting/seguridad/mantenimiento que no encaja con el plazo de 1 semana. WordPress queda como opción de migración futura si el costo mensual de Softr pesa más adelante con el catálogo ya grande.
- **Base de datos**: Supabase o Airtable (conectado nativamente a Softr) — pendiente decisión final entre ambos
- **Motor conversacional**: Dify + DeepSeek
- **Orquestación/automatizaciones**: Make (webhooks, notificaciones, recordatorios, conexión con Stripe)
- **Pagos**: Stripe

---

## 9. Recursos y contexto disponibles

- Ya cuenta con proveedores turísticos como clientes de Creativa Balam
- Ya identificó restaurantes concretos para el catálogo y locales físicos para QR
- Planea usar Claude Cowork para estructurar áreas organizacionales (ej. un área de "desarrollo" con las herramientas necesarias para construir página + bot + catálogo), operando como CEO con múltiples agentes/ayudantes de IA por área/empresa

---

## 10. Pendientes / próximos pasos

- [ ] Decidir Supabase vs. Airtable como base de datos definitiva
- [ ] Definir contenido exacto del "bloque fijo" del frame del concierge de hotel (lógica de negocio común a todos)
- [ ] Resolver acceso a canal de alto volumen (muelle de cruceros)
- [ ] Definir flujo conversacional detallado del Bot 1 (preguntas, orden, cierre de reserva) — pendiente de armar
- [ ] Definir flujo conversacional del Bot 2 y contenido del frame reutilizable
- [ ] Diseñar a detalle la página pública (más allá del borrador de esta sesión)
- [ ] Pruebas comparativas de modelo de IA (DeepSeek vs. alternativas) una vez el sistema esté en uso real
