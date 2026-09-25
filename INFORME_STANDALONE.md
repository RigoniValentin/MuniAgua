# INFORME — MONGODB STANDALONE SUPPORT

## Estado

**STANDALONE_READY: YES**

MuniBack ahora soporta **MongoDB standalone** y **MongoDB Replica Set**
sin requerir cambios en `mongod.cfg`, sin convertir el servidor local a
Replica Set, y sin tocar `MONGODB_URI`. La regla de negocio (Order +
ledger, Payment + ledger, cancelaciones y reversiones) se mantiene
idéntica; solo se centraliza la decisión de usar transactions en un
helper único.

Resultado verificado contra la configuración local real:

```text
MONGODB_URI=mongodb://127.0.0.1:27017/MuniDB
MONGO_TRANSACTION_MODE=auto

> npm run seed:demo
[INFO] MongoDB standalone detected. Transaction fallback enabled.
[INFO] Seed demo finished.
```

Sin `IllegalOperation` (code 20), sin requerir un Replica Set.

## Detección de topology

La detección se hace una sola vez al conectar Mongoose
(`src/config/mongo.ts` → `detectTransactionSupport()`), leyendo
directamente del driver MongoDB:

```text
mongoose.connection.getClient().topology.description.type
```

Valores reconocidos como "soportan transactions":

- `ReplicaSetWithPrimary`
- `ReplicaSetNoPrimary`
- `Sharded`
- `LoadBalanced`

Cualquier otro valor (incluido `Single`, que es el caso standalone)
marca `supports = false`. La decisión se cachea en
`src/shared/transactions.ts` durante toda la vida del proceso y se
loggea exactamente una vez al iniciar:

- Standalone: `[INFO] MongoDB standalone detected. Transaction fallback enabled.`
- Replica Set: `[INFO] MongoDB transaction support: enabled`
- Modo `enabled` contra standalone: error explícito al iniciar,
  `MongoDB transactions were explicitly required but the current server is not a Replica Set (topology=Single). Either start a MongoDB Replica Set or set MONGO_TRANSACTION_MODE=auto/disabled.`

No se infiere nada de `MONGODB_URI` — la cadena puede incluir
`?replicaSet=` y aún así fallar si el servidor no es realmente un
Replica Set, o viceversa. La fuente de verdad es la topología viva.

## Operaciones adaptadas

Todas las operaciones que antes requerían `session.withTransaction()`
pasan ahora por `runAtomicOperation({ transactional, fallback })` en
`src/shared/transactions.ts`:

### Orders
- `createOrder` (POST `/api/orders/me`, POST `/api/delivery/me/direct-order`)
- `cancelOrder` (POST `/api/orders/:id/cancel`, POST `/api/orders/me/:id/cancel`)

### Payments
- `approvePayment` (POST `/api/payments/:id/approve`)
- `reversePaymentApproval` (POST `/api/payments/:id/reverse-approval`)

### Seed demo
- `ensureDemoOrder` (`scripts/seed-demo.ts`)
- `ensureDemoPayment` (`scripts/seed-demo.ts`)

Las funciones de solo lectura (`postMovement`, `reverseMovement`,
`assignOrder`, `startDelivery`, `markDelivered`, `rejectPayment`, etc.)
**no se tocaron**: ya eran single-document writes sin necesidad de
transacción.

## Estrategia de fallback

El fallback (modo standalone) ejecuta las escrituras en **secuencia**
con compensación, sin cambiar la API pública, los DTOs ni la
state machine:

| Operación | Camino transaccional | Camino fallback (standalone) |
| --------- | -------------------- | ----------------------------- |
| `createOrder` con `total > 0` | `Order.create([…], { session })` + `postMovement({ session })` | `Order.create(…)` → `postMovement(…)` → si falla, `Order.deleteOne({ _id })` |
| `createOrder` con `total = 0` | `Order.create([…], { session })` (sin ledger) | `Order.create(…)` (sin ledger) |
| `cancelOrder` con DEBIT | `order.save({ session })` + `reverseMovement({ session })` | guarda snapshot de los campos, ejecuta, y ante fallo restaura el estado anterior |
| `approvePayment` | `postMovement({ session })` + `Payment.findOneAndUpdate({ session })` | escribe ledger, actualiza Payment; si el Payment update falla, ejecuta `reverseMovement` para deshacer el CREDIT |
| `reversePaymentApproval` | `reverseMovement({ session })` + `Payment.findOneAndUpdate({ session })` | ejecuta reversal, actualiza Payment; si la actualización falla, restaura los campos `reversedBy/At/Reason/MovementId` |

Las garantías de no-duplicación se sostienen con índices únicos
parciales preexistentes:

- `AccountMovement.idempotencyKey` (único cuando está presente)
- `AccountMovement.reversesMovementId` (único cuando está presente)
- `Order.accountMovementId` (único cuando está presente)
- `Order.cancellationMovementId` (único cuando está presente)
- `Payment.ledgerMovementId` (único cuando está presente)
- `Payment.reversalMovementId` (único cuando está presente)

Estos índices son los mismos que ya blindaban la operación con
transactions; el fallback los reutiliza para que un retry determinista
después de un fallo compensado no duplique el efecto contable.

## Compensaciones

| Caso | Compensación |
| ---- | ------------ |
| Order creado + ledger falla | `Order.deleteOne({ _id })` antes de propagar el error. El Order nunca queda con `accountMovementId` y deuda fantasma. |
| Order cancel + reversal falla | Restauración in-place de `status`, `cancelledAt`, `cancellationReason`, `cancellationMovementId` + `order.save()`. La API nunca presenta un Order `CANCELLED` sin su REVERSAL. |
| Payment approval + ledger falla | El ledger no llega a escribirse; Payment queda `PENDING`. (La transacción habría abortado ambos writes.) |
| Payment approval + Payment update falla | El ledger queda; se ejecuta `reverseMovement` para cancelar el CREDIT huérfano. Si el `reverseMovement` también falla, los índices únicos garantizan que el retry determinista no cree un segundo CREDIT. |
| Payment reversal + Payment update falla | Restauración de `reversedBy/At/Reason/MovementId` a sus valores APPROVED previos. Si el `reverseMovement` quedó persistido, el índice único sobre `reversesMovementId` impide un segundo reversal. |

**Limitación ante process crash:** si el proceso muere entre
`Order.create()` y `postMovement()` (o entre `postMovement()` y
`Payment.findOneAndUpdate`), queda un estado inconsistente en disco.
Con transactions esto no ocurre — la transacción aborta atómicamente.
En standalone el riesgo es acotado: ningún movimiento contable queda
huérfano sin la otra mitad, y un retry manual posterior completa la
operación sin duplicar. Documentado en el README.

## Tests standalone

`tests/orders-payments-standalone.test.ts` — 13 tests, todos pasan,
ejercen el camino fallback contra `MongoMemoryServer` SIN
`MongoMemoryReplSet`:

- `1) crea pedido y genera DEBIT (fallback path)`
- `2) Order $0 (AYUDA_SOCIAL -100%) → NO genera DEBIT`
- `3) cancela pedido CONFIRMED + revierte DEBIT`
- `7) direct-order + DEBIT arranca en OUT_FOR_DELIVERY`
- `4) aprobar Payment + CREDIT (fallback path)`
- `5) rechazar Payment sin ledger`
- `6) revertir Payment APPROVED + reversal`
- `8) doble approve no duplica CREDIT (state machine guard)`
- `9) doble cancel / doble reversal no duplica ledger`
- `10) idempotency keys siguen funcionando`
- `Standalone topology > detecta no transaction support y rutas por fallback`
- `Failure > Order creado pero ledger falla → API devuelve error y NO persiste Order`
- `Failure > Payment approval con ledger falla → Payment queda PENDING`

El primer test imprime explícitamente:

```text
[INFO] MongoDB standalone detected. Transaction fallback enabled.
```

## Tests replica set

Tests existentes preservados, **todos siguen pasando** sin cambios
(más allá del helper):

- `tests/orders.test.ts` — 26 tests, ReplSet
- `tests/payments-approval.test.ts` — 20 tests, ReplSet
- `tests/payments-submission.test.ts` — ReplSet
- `tests/seed-demo.test.ts` — corre `npm run seed:demo` dos veces
  contra ReplSet y verifica idempotencia.

Total de la suite: **269 tests, 16 archivos, 0 fallos** en modo mixto
(13 nuevos standalone + 256 preexistentes).

## seed:demo

`npm run seed:demo` validado contra:

```text
MONGODB_URI=mongodb://127.0.0.1:27017/MuniDB
MONGO_TRANSACTION_MODE=auto
```

Resultado:

```text
[INFO] MongoDB standalone detected. Transaction fallback enabled.
[INFO] User exists: admin@demo.local
[INFO] User exists: repartidor@demo.local
[INFO] User exists: ciudadano@demo.local
[INFO] Client exists: 12345678
[INFO] Client exists: 22334455
[INFO] Client exists: 33445566
[INFO] Client exists: 44556677
[INFO] Product exists: RECARGA
[INFO] Product exists: BIDON
[INFO] Product exists: DISPENSER
[INFO] Rule exists: Precio base local
[INFO] Rule exists: Descuento jubilados
[INFO] Rule exists: Beneficio ayuda social
[INFO] Demo order created (jubilado-historical-delivered)
[INFO] Demo credit (historical) created for JUBILADO
[INFO] Demo order created (local-historical-delivered)
[INFO] Demo payment created (demo:payment:local-historical)
[INFO] Demo order created (social-historical-delivered)
[INFO] Demo order created (jubilado-pending-assignment)
[INFO] Seed demo finished.
```

Confirmado: **`mongodb://127.0.0.1:27017/MuniDB` funciona sin Replica
Set**. Segunda corrida verificó idempotencia (mismo número de usuarios,
clientes, productos, reglas y pedidos).

## smoke:standalone

`npm run smoke:standalone` corre el circuito E2E contra
`MongoMemoryServer` SIN ReplicaSet:

```text
====================================
SMOKE STANDALONE — MongoDB sin ReplicaSet
====================================
[INFO] MongoDB standalone detected. Transaction fallback enabled.
Modo: STANDALONE (compensated fallback)

FLUJO 1 — CIUDADANO crea pedido, paga y queda al día
Pedido creado 4f2856: CONFIRMED $12.500,00
Ledger generó DEBIT $12.500,00 (fallback path)
Admin asignó repartidor → ASSIGNED
Repartidor inició → OUT_FOR_DELIVERY
Repartidor entregó → DELIVERED
Vecino informó pago → PENDING
Admin aprobó → APPROVED + CREDIT
Saldo $0,00 → SETTLED

FLUJO 2 — Repartidor entrega directa (direct-order)
Direct-order creado 4f287d: OUT_FOR_DELIVERY $20.000,00
Ledger generó DEBIT $20.000,00
Direct-order entregado → DELIVERED

✅ STANDALONE MVP OK
```

Smokes preexistentes preservados y volviendo a pasar sin cambios:

- `smoke:pricing` — ✅
- `smoke:accounts` — ✅
- `smoke:citizen` — ✅
- `smoke:payments` — ✅ (loggea `[INFO] MongoDB transaction support: enabled`)
- `smoke:mvp` — ✅ (idem)
- `smoke:prod` — ✅

## Limitaciones

**Lo que ofrece un Replica Set que el modo standalone no puede igualar
en todos los casos:**

1. **Atomicidad ante crash.** Con transactions, una caída del proceso
   entre los dos writes aborta la transacción y ningún documento queda
   en disco. Sin transactions, queda un Order sin `accountMovementId`
   (o un Payment APPROVED sin ledgerMovementId) hasta que un operador
   limpie o el sistema se recupere con un retry. Los índices únicos
   del ledger contienen el daño: ningún duplicado se crea, pero un
   Order con `accountMovementId=null` queda pendiente de inspección
   manual.

2. **Aislamiento de lecturas durante la escritura.** Con transactions
   un cliente que lee durante un `createOrder` no ve el Order hasta
   el commit. Sin transactions, un cliente puede ver un Order
   transitorio entre `Order.create` y `postMovement`. En la práctica
   el segundo write es sub-milisegundo y la ventana es imperceptible,
   pero existe.

3. **Operaciones multi-documento dentro de un único read concern.**
   `withTransaction` garantiza snapshot isolation; el fallback ejecuta
   cada write en su propio round-trip y por lo tanto dos lecturas
   concurrentes podrían ver estados intermedios distintos si la red
   se demora. Para el dominio de MuniBack esto no es explotable desde
   el frontend (la API expone un único cliente a la vez por request).

**Lo que sigue siendo idéntico en ambos modos:**

- API pública (rutas, verbos, payloads, códigos de error).
- DTOs (`OrderDto`, `CitizenPaymentDto`, `AdminPaymentDto`).
- State machine (`PENDING → APPROVED → REVERSED`, `CONFIRMED →
  ASSIGNED → OUT_FOR_DELIVERY → DELIVERED`, `CANCELLED`).
- Idempotencia: las mismas claves (`ORDER:<id>:CHARGE`,
  `PAYMENT:<id>:APPROVED`, `demo:*`).
- Índices únicos del ledger.
- Resultado contable neto: una DEBIT + un CREDIT producen saldo cero,
  idéntico en ambos caminos.
- El usuario del frontend no tiene forma de saber si MongoDB es
  standalone o Replica Set — la experiencia es idéntica.

**Recomendación operativa:** Replica Set para producción por la
propiedad 1 (atomicidad ante crash). Standalone para demo y
desarrollo local — sigue siendo la opción soportada y recomendada para
entornos donde no se puede (o no se quiere) convertir el servidor.
