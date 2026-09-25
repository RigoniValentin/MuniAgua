# MuniBack

Backend de la plataforma digital de la **Municipalidad de Buchardo**.

API REST en Node.js + TypeScript + Express + MongoDB, con autenticación JWT, control de acceso por permisos (RBAC), y un módulo modular preparado para escalar a múltiples servicios municipales.

## Demo MVP

Para preparar y ejecutar la **demo frente a la Municipalidad** consultá
[`DEMO_CHECKLIST.md`](../DEMO_CHECKLIST.md) (credenciales, recorrido sugerido
paso a paso y verificación de cada pantalla). Las mejoras post-MVP que
**no se incluyen** en esta entrega están listadas en
[`POST_MVP.md`](../POST_MVP.md).

## Stack

- Node.js 20+
- TypeScript (strict)
- Express
- MongoDB + Mongoose
- Zod
- JWT (access + refresh con cookie HttpOnly)
- bcrypt
- nodemailer (recuperación de contraseña por email)
- helmet, express-rate-limit, cookie-parser, cors
- Vitest + Supertest

## MongoDB — topología soportada

MuniBack soporta **dos** topologías de MongoDB sin modificar la
instalación local:

| Topología               | Soporte | Comentario                                          |
| ----------------------- | ------- | --------------------------------------------------- |
| Standalone (single)     | ✅      | Modo soportado para demo y desarrollo local         |
| Replica Set / mongos    | ✅      | Recomendado en producción por atomicidad extra      |

La decisión se hace **una sola vez** al iniciar el proceso, leyendo la
topología real del servidor (no la cadena de conexión):

```text
[INFO] MongoDB transaction support: enabled
[INFO] MongoDB standalone detected. Transaction fallback enabled.
```

El control fino vive en la variable de entorno `MONGO_TRANSACTION_MODE`:

| Valor      | Comportamiento                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `auto`     | (default) Detecta al iniciar. Si soporta transactions, las usa. Si no, aplica un fallback compensado.   |
| `enabled`  | Exige transactions. Falla al iniciar si el servidor es standalone con un mensaje claro.                |
| `disabled` | Nunca usa transactions, aunque estén disponibles (útil para diagnóstico o tests).                       |

### Por qué funciona sin Replica Set

La regla de negocio (Order + AccountMovement DEBIT, Payment +
AccountMovement CREDIT, Order cancel + REVERSAL) está centralizada en
`src/shared/transactions.ts` mediante `runAtomicOperation({ transactional, fallback })`.
Cuando MongoDB **sí** soporta transactions, ambos writes viven en una
sola sesión `session.withTransaction(...)`. Cuando **no**, se ejecutan
en secuencia y, si el segundo write falla, el primero se compensa
(borrar el Order recién creado o revertir el estado del Payment).
La idempotencia + los índices parciales únicos sobre
`AccountMovement.idempotencyKey` y `AccountMovement.reversesMovementId`
garantizan que un retry determinista nunca duplique un movimiento
contable.

### Limitación ante process crash

El fallback compensado **asume** que el proceso sigue vivo entre el
primer y el segundo write. Si el proceso muere entre `Order.create()`
y `postMovement()` (sin transacción), podría quedar un Order sin
`accountMovementId` en disco. Los índices únicos del ledger
garantizan que un retry posterior no duplique el DEBIT — el Order
huérfano queda visible para inspección manual pero no genera deuda
fantasma. En Replica Set este riesgo se elimina porque la transacción
aborta atómicamente.

### Tests

- `npm test` — sigue usando `MongoMemoryReplSet` (transaccional).
- `tests/orders-payments-standalone.test.ts` — específicamente
  apunta al fallback con `MongoMemoryServer` SIN ReplicaSet.
- `npm run smoke:standalone` — circuito E2E completo contra
  MongoDB standalone.

## Requisitos

- Node.js >= 20
- npm >= 10
- MongoDB local o remoto. Funciona tanto en **standalone** como en
  **Replica Set** (ver sección "MongoDB — topología soportada" abajo).
  Para los tests se usa `mongodb-memory-server`.

## Instalación

```bash
npm install
cp .env.example .env
# editar .env con sus valores
```

Variables de entorno:

| Sección     | Variable               | Descripción                                                    |
| ----------- | ---------------------- | -------------------------------------------------------------- |
| SERVER      | `NODE_ENV`             | `development` / `production` / `test`                          |
| SERVER      | `PORT`                 | Puerto HTTP (default `3000`)                                   |
| DATABASE    | `MONGODB_URI`          | Cadena de conexión MongoDB                                     |
| DATABASE    | `MONGO_TRANSACTION_MODE` | `auto` (default) / `enabled` / `disabled`                  |
| AUTH        | `JWT_ACCESS_SECRET`    | Secreto JWT access (>= 16 chars)                               |
| AUTH        | `JWT_REFRESH_SECRET`   | Secreto JWT refresh (>= 16 chars)                              |
| AUTH        | `JWT_ACCESS_EXPIRES_IN`  | Duración access (ej. `390m` = 6h30m)                         |
| AUTH        | `JWT_REFRESH_EXPIRES_IN` | Duración refresh (ej. `7d`)                                  |
| AUTH        | `REFRESH_COOKIE_NAME`  | Nombre de la cookie de refresh (default `muni_rt`)             |
| FRONTEND    | `FRONTEND_URL`         | Origen permitido para CORS                                     |
| PAYMENTS    | `PAYMENT_RECEIPTS_DIR` | Carpeta de comprobantes (NO dentro de `public/`)               |
| PAYMENTS    | `PAYMENT_SUBMIT_RATE_LIMIT` | `enabled` (default) o `disabled` (sólo tests)             |
| DEMO        | `DEMO_ADMIN_*`         | Credenciales sembradas para `admin@demo.local`                  |
| DEMO        | `DEMO_DRIVER_*`        | Credenciales sembradas para `repartidor@demo.local`             |
| DEMO        | `DEMO_CITIZEN_*`       | Credenciales sembradas para `ciudadano@demo.local`              |
| REAL USERS  | `TREASURY_ADMIN_*`     | Operadora real — Tesorería (Maribel Arduzzo)                   |
| REAL USERS  | `ACCOUNTING_ADMIN_*`   | Operadora real — Secretaría contable (Macarena Gonzalez)        |
| REAL USERS  | `DRIVER_EZEQUIEL_*`    | Repartidor real — Ezequiel Biasini                              |
| REAL USERS  | `DRIVER_ROBERTINO_*`   | Repartidor real — Robertino Goggi                               |

Si una variable esencial falta, la aplicación falla al iniciar con un mensaje claro.

## Desarrollo

```bash
npm run dev
# MuniBack escucha en http://localhost:3000
```

El frontend (`MuniFront`) puede ejecutarse por separado en `http://localhost:5173`. Vite redirige todo lo que comienza con `/api` hacia este backend.

## Build

Compila TypeScript a `dist/`:

```bash
npm run build
npm start
```

## Build integrado (frontend + backend)

`npm run build:full` realiza:

1. Build del frontend (`MuniFront`).
2. Limpia `MuniBack/public`.
3. Copia `MuniFront/dist` a `MuniBack/public` (script Node.js cross-platform).
4. Compila MuniBack.

```bash
npm run build:full
npm start
```

Luego:

- `http://localhost:3000/` → React app
- `http://localhost:3000/admin` → SPA route
- `http://localhost:3000/api/health` → API
- `http://localhost:3000/api/inexistente` → JSON 404 (NO index.html)

## Tests

```bash
npm test
```

Los tests usan `mongodb-memory-server`, así que no requieren MongoDB local.

## Estructura

```
src/
├── config/        # env validation, mongo connection
├── middlewares/   # error handler, auth, authorize, rate limit
├── modules/
│   ├── auth/      # login, refresh, logout, me + JWT utils
│   ├── clients/   # FASE 2 + FASE 5 — model + RBAC + CRUD + citizen self
│   ├── products/  # FASE 3 — catálogo de productos + RBAC
│   ├── pricing/   # FASE 3 — reglas + motor; FASE 5 agrega /me/quote
│   ├── accounts/  # FASE 4 — ledger, summary, movements, /me/*
│   ├── users/     # model + RBAC
│   └── health/
├── shared/        # api-response, errors, logger, money helpers
├── app.ts
└── server.ts
```

## Endpoints actuales

| Método | Endpoint                | Auth | Descripción                           |
| ------ | ----------------------- | ---- | ------------------------------------- |
| GET    | `/api`                  | No   | Metadata del API                      |
| GET    | `/api/health`           | No   | Estado del servicio + DB              |
| POST   | `/api/auth/login`       | No   | Login (rate-limited)                  |
| POST   | `/api/auth/refresh`     | No\* | Refresca access usando cookie HttpOnly |
| POST   | `/api/auth/logout`      | No\* | Revoca refresh y limpia cookie        |
| GET    | `/api/auth/me`          | Sí   | Devuelve el usuario autenticado       |
| POST   | `/api/auth/forgot-password`        | No | Solicita enlace de recuperación (rate-limited, anti-enumeración) |
| GET    | `/api/auth/reset-password/validate`| No | Verifica si un token es válido (rate-limited) |
| POST   | `/api/auth/reset-password`         | No | Consume el token y setea nueva contraseña (rate-limited) |
| GET    | `/api/users`            | Sí (users.manage) | Lista usuarios               |
| POST   | `/api/users`            | Sí (users.manage) | Crea usuario                |
| PATCH  | `/api/users/:id`        | Sí (users.manage) | Actualiza usuario           |
| GET    | `/api/clients`          | Sí (clients.read) | Lista clientes paginados    |
| GET    | `/api/clients/:id`      | Sí (clients.read) | Obtiene cliente por ID      |
| POST   | `/api/clients`          | Sí (clients.create) | Crea cliente              |
| PATCH  | `/api/clients/:id`      | Sí (clients.update) | Actualiza cliente          |
| GET    | `/api/products`         | Sí (products.read) | Lista productos paginados  |
| GET    | `/api/products/:id`     | Sí (products.read) | Obtiene producto por ID    |
| POST   | `/api/products`         | Sí (products.create) | Crea producto            |
| PATCH  | `/api/products/:id`     | Sí (products.update) | Actualiza producto       |
| GET    | `/api/pricing/rules`    | Sí (pricing.read) | Lista reglas comerciales   |
| GET    | `/api/pricing/rules/:id`| Sí (pricing.read) | Obtiene regla por ID       |
| POST   | `/api/pricing/rules`    | Sí (pricing.manage) | Crea regla                |
| PATCH  | `/api/pricing/rules/:id`| Sí (pricing.manage) | Actualiza regla          |
| POST   | `/api/pricing/quote`    | Sí (pricing.quote) | Cotiza un pedido (NO crea pedido) |
| GET    | `/api/accounts`         | Sí (accounts.read) | Lista cuentas corrientes paginadas con resumen |
| GET    | `/api/accounts/:clientId/summary`   | Sí (accounts.read) | Resumen (totales + saldo + estado) |
| GET    | `/api/accounts/:clientId/movements` | Sí (accounts.read) | Historial paginado y filtrable |
| POST   | `/api/accounts/:clientId/adjustments` | Sí (accounts.adjust) | Ajuste manual (DEBIT/CREDIT) |
| POST   | `/api/accounts/movements/:movementId/reverse` | Sí (accounts.reverse) | Revierte un movimiento |
| GET    | `/api/accounts/me/summary`    | Sí (accounts.self) | Resumen del cliente vinculado al ciudadano |
| GET    | `/api/accounts/me/movements`  | Sí (accounts.self) | Historial del cliente vinculado al ciudadano |
| GET    | `/api/clients/me`             | Sí (clients.self)  | Devuelve el Client vinculado al User autenticado (DTO seguro) |
| PATCH  | `/api/clients/me`             | Sí (clients.self)  | Edita SOLO phone/email/address del propio Client (mass-assignment guard) |
| GET    | `/api/clients/:clientId/citizen-access`  | Sí (clients.linkUser) | Inspecciona el User vinculado al Client |
| POST   | `/api/clients/:clientId/citizen-access`  | Sí (clients.linkUser) | Vincula un User CIUDADANO al Client |
| DELETE | `/api/clients/:clientId/citizen-access`  | Sí (clients.linkUser) | Desvincula (NO elimina Client/User/ledger) |
| POST   | `/api/pricing/me/quote`       | Sí (pricing.quote) | Cotiza para el Client vinculado (sin enviar clientId) |

\* Las rutas `/refresh` y `/logout` usan cookie HttpOnly, no Authorization header.

## Módulo Clients (FASE 2)

Modelo `Client` representa a las personas registradas como clientes del servicio municipal.

### Campos

| Campo               | Tipo                | Descripción                                       |
| ------------------- | ------------------- | ------------------------------------------------- |
| `firstName`         | string              | Nombre (requerido)                                |
| `lastName`          | string              | Apellido (requerido)                              |
| `documentType`      | enum                | `DNI`, `CUIT`, `CUIL`, `OTHER`                    |
| `documentNumber`    | string              | Normalizado (mayúsculas, sin puntos/guiones)       |
| `phone`             | string?             | Teléfono (opcional)                               |
| `email`             | string?             | Email en minúsculas (opcional)                    |
| `clientType`        | enum                | `LOCAL`, `JUBILADO`, `NO_LOCAL`, `AYUDA_SOCIAL`   |
| `address`           | subdoc              | Calle, número, piso, dpto, barrio, localidad, CP  |
| `userId`            | ObjectId? (User)    | Relación opcional a User                          |
| `notes`             | string?             | Observaciones internas                            |
| `active`            | boolean             | Soft-delete                                       |
| `createdAt/updatedAt` | Date              | Timestamps automáticos                            |
| `createdBy/updatedBy` | ObjectId? (User)  | Auditoría básica (preparada para AuditLog)        |

> **Nota:** El módulo NO incluye porcentajes ni reglas comerciales. Los tipos de cliente se almacenan como dato explícito. Las reglas comerciales (descuentos/recargos) se implementarán en FASE 3 mediante un módulo de pricing.

### Índices

- `documentType + documentNumber` único (parcial, permite `documentNumber` opcional)
- `clientType`, `active`
- `lastName + firstName`
- `userId` único parcial (permite clientes sin cuenta)

### Búsqueda y filtros

`GET /api/clients` acepta query params:

| Param        | Descripción                                                |
| ------------ | ---------------------------------------------------------- |
| `page`       | Página (default 1)                                         |
| `limit`      | Resultados por página (default 20, máx 100)                |
| `search`     | Busca por nombre, apellido, documento, teléfono o calle    |
| `clientType` | Filtra por tipo (`LOCAL`, `JUBILADO`, etc.)                |
| `active`     | `true` / `false`                                           |
| `sortBy`     | Whitelist: `lastName`, `firstName`, `createdAt`, `updatedAt` |
| `sortOrder`  | `asc` / `desc`                                             |

Respuesta:

```json
{
  "success": true,
  "data": {
    "items": [ /* Client[] */ ],
    "pagination": { "page": 1, "limit": 20, "total": 150, "pages": 8 }
  }
}
```

### Códigos de error

- `400 VALIDATION_ERROR` — datos inválidos o ID con formato incorrecto
- `403 FORBIDDEN` — permisos insuficientes
- `404 NOT_FOUND` — cliente inexistente
- `409 CONFLICT` — documento duplicado

### Permisos del módulo clients

| Permiso          | SUPER_ADMIN | ADMIN | OPERADOR | REPARTIDOR | CIUDADANO |
| ---------------- | :---------: | :---: | :------: | :--------: | :-------: |
| `clients.read`   |     ✓       |   ✓   |    ✓     |     ✓      |     —     |
| `clients.create` |     ✓       |   ✓   |    ✓     |     —      |     —     |
| `clients.update` |     ✓       |   ✓   |    ✓     |     —      |     —     |

`CIUDADANO` no accede al listado general; las operaciones del ciudadano sobre su propio `Client` se implementarán en una fase posterior.

## Seed inicial

```bash
npm run seed:admin
```

Crea un SUPER_ADMIN si no existe (lee `SEED_ADMIN_*` del entorno o usa defaults). No se ejecuta automáticamente al iniciar.

## FASE 3 — Productos y Pricing

FASE 3 introduce el catálogo de productos, el motor de precios y la gestión de reglas comerciales. Es la **única fuente de verdad para calcular precios**: el frontend nunca reconstruye reglas, los controllers nunca calculan importes finales.

### Modelo Product

| Campo            | Tipo                              | Descripción                                       |
| ---------------- | --------------------------------- | ------------------------------------------------- |
| `code`           | string (uppercase, `_` allowed)   | SKU / código interno único                        |
| `name`           | string                            | Nombre comercial                                  |
| `description`    | string?                           | Descripción opcional                              |
| `productType`    | enum                              | `WATER_REFILL`, `CONTAINER`, `DISPENSER`, `OTHER` |
| `basePriceMinor` | integer (centavos)                | Precio base en unidades menores enteras           |
| `tracksStock`    | boolean                           | Define si el producto controla stock (FASE 9)     |
| `active`         | boolean                           | Soft-delete                                       |
| `createdAt/updatedAt` | Date                        | Timestamps automáticos                            |
| `createdBy/updatedBy` | ObjectId? (User)              | Auditoría básica                                  |

### Modelo PricingRule

| Campo             | Tipo                          | Descripción                                            |
| ----------------- | ----------------------------- | ------------------------------------------------------ |
| `name`            | string                        | Nombre legible de la regla                             |
| `clientType`      | enum                          | Tipo de cliente al que aplica                          |
| `scope`           | enum                          | `ALL_PRODUCTS`, `PRODUCT_TYPE`, `PRODUCT`              |
| `productType`     | enum?                         | Requerido si `scope = PRODUCT_TYPE`                    |
| `productId`       | ObjectId (Product)?           | Requerido si `scope = PRODUCT`                         |
| `adjustmentType`  | enum                          | `PERCENTAGE` (único en esta fase)                      |
| `adjustmentValue` | integer (-100 a 1000)         | Porcentaje (negativo = descuento, positivo = recargo)  |
| `priority`        | integer                       | Mayor gana dentro de la misma especificidad           |
| `active`          | boolean                       | Soft-delete                                            |

> Las reglas NO almacenan porcentajes hardcodeados por cliente. La asociación se hace por `clientType` y se almacena como dato configurable.

### Motor de precios

Función pura: `buildQuote(clientId, items)` → `QuoteResult`. Algoritmo:

1. Carga el cliente y los productos.
2. Para cada ítem, busca reglas activas aplicables (`scope = ALL_PRODUCTS / PRODUCT_TYPE / PRODUCT` con coincidencia por `clientType`).
3. Selecciona la regla aplicable según:
   - 1° especificidad: `PRODUCT` > `PRODUCT_TYPE` > `ALL_PRODUCTS`.
   - 2° mayor `priority`.
   - 3° desempate estable por `createdAt`.
4. Calcula `unitFinalPriceMinor` aplicando el porcentaje con redondeo half-up.
5. Acumula totales: `baseMinor`, `adjustmentMinor`, `finalMinor`.
6. Nunca devuelve precios negativos (clamp a 0).

Ver `src/modules/pricing/pricing.engine.ts` y `src/modules/pricing/pricing.types.ts`.

### Dinero — minor units

- 1 unidad mayor = 100 unidades menores (centavos ARS).
- Todos los importes son `integer` (`basePriceMinor`, `unitFinalPriceMinor`, etc.).
- Helpers centralizados en `src/shared/money.ts`:
  - `toMinorUnits`, `toMajorUnits`, `computeAdjustment`, `applyPercentageAdjustmentMinor`.
- Redondeo: half-up matemático al centavo más cercano (centralizado en `applyPercentageAdjustmentMinor`).
- El backend **nunca** utiliza `Float` como fuente de verdad monetaria.
- El frontend muestra importes con `Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })`.

### Permisos nuevos

| Permiso            | SUPER_ADMIN | ADMIN | OPERADOR | REPARTIDOR | CIUDADANO |
| ------------------ | :---------: | :---: | :------: | :--------: | :-------: |
| `products.read`    | ✓           | ✓     | ✓        | ✓          | ✓         |
| `products.create`  | ✓           | ✓     | ✓        | —          | —         |
| `products.update`  | ✓           | ✓     | ✓        | —          | —         |
| `pricing.read`     | ✓           | ✓     | ✓        | —          | —         |
| `pricing.manage`   | ✓           | ✓     | —        | —          | —         |
| `pricing.quote`    | ✓           | ✓     | ✓        | ✓          | ✓         |

Notas:

- El ciudadano puede cotizar (`pricing.quote`), pero el backend valida que el `clientId` recibido corresponda a su `userId`; en caso contrario responde `403 FORBIDDEN`.
- `OPERADOR` no tiene `pricing.manage` (sólo cotiza). `ADMIN` y `SUPER_ADMIN` gestionan reglas.

### Endpoint de cotización

`POST /api/pricing/quote`

Body:

```json
{
  "clientId": "...",
  "items": [{ "productId": "...", "quantity": 2 }]
}
```

Respuesta (ejemplo):

```json
{
  "success": true,
  "data": {
    "client": {
      "id": "...", "name": "Ana Pérez", "clientType": "JUBILADO", "active": true, "hasUserAccount": false
    },
    "items": [
      {
        "productId": "...", "productCode": "AGUA_RECARGA", "productName": "Recarga de agua",
        "productType": "WATER_REFILL", "quantity": 2,
        "unitBasePriceMinor": 1000000, "appliedRule": {
          "id": "...", "name": "Descuento jubilados", "scope": "ALL_PRODUCTS",
          "clientType": "JUBILADO", "productType": null, "productId": null,
          "adjustmentType": "PERCENTAGE", "adjustmentValue": -50, "priority": 0
        },
        "adjustmentPercentage": -50, "unitFinalPriceMinor": 500000,
        "subtotalBaseMinor": 2000000, "subtotalFinalMinor": 1000000
      }
    ],
    "totals": { "baseMinor": 2000000, "adjustmentMinor": -1000000, "finalMinor": 1000000 }
  }
}
```

> Este endpoint **NO** crea pedidos, NO descuenta stock, NO genera movimientos contables. Sólo cotiza. La respuesta trae suficiente información (`unitBasePriceMinor`, `adjustmentValue`, `unitFinalPriceMinor`, `appliedRule.id`) para que FASE 7 construya un snapshot histórico al guardar el pedido.

### Conflictos entre reglas

Si dos reglas activas tienen exactamente el mismo `(clientType, scope, productType, productId, priority)`, el backend rechaza la creación con `409 CONFLICT`. La base de datos nunca queda en un estado ambiguo: la primera regla activa equivalente gana y bloquea a las siguientes.

### Seeds

```bash
npm run seed:admin      # crea SUPER_ADMIN inicial
npm run seed:pricing    # crea las 4 reglas globales (LOCAL, JUBILADO, NO_LOCAL, AYUDA_SOCIAL)
```

`seed:pricing` es **idempotente**: si ya existe una regla activa equivalente para `(clientType, ALL_PRODUCTS, priority=0)`, la omite. Nunca pisa reglas modificadas manualmente.

### Smoke test E2E

```bash
npm run smoke:pricing
```

Crea productos, clientes, reglas y demuestra que cambiar `JUBILADO: -50% → -30%` modifica las cotizaciones sin tocar código, y que reglas `PRODUCT` específicas ganan sobre reglas `ALL_PRODUCTS` globales.

## FASE 4 — Cuenta corriente y ledger de movimientos

FASE 4 introduce la **cuenta corriente** por cliente, sustentada por un **ledger inmutable** de `AccountMovement`. La cuenta corriente **NO se calcula desde un campo cacheado en `Client`**; el saldo siempre se deriva de los movimientos.

### Convención contable (NO invertir)

| `balanceMinor` | Significado                                  | Estado (`status`) |
| -------------- | -------------------------------------------- | ----------------- |
| `> 0`          | El cliente **debe** dinero a la Municipalidad | `DEBT`            |
| `=== 0`        | Cuenta al día                                | `SETTLED`         |
| `< 0`          | El cliente tiene **saldo a favor**           | `CREDIT`          |

`amountMinor` siempre es un entero **positivo**. La dirección lleva el signo:

- `DEBIT`  → aumenta la deuda (`+amountMinor`).
- `CREDIT` → reduce la deuda / genera saldo a favor (`-amountMinor`).

El frontend nunca debe mostrar el signo crudo: usar `Debe $…`, `Saldo a favor $…` o `Al día`.

### Modelo `AccountMovement`

| Campo               | Tipo                                  | Descripción |
| ------------------- | ------------------------------------- | ----------- |
| `_id`               | ObjectId                              | Identificador |
| `clientId`          | ObjectId (Client)                     | Cliente afectado |
| `direction`         | `DEBIT` \| `CREDIT`                   | Dirección del movimiento |
| `amountMinor`       | integer (> 0)                         | Importe en unidades menores |
| `movementType`      | `MANUAL_ADJUSTMENT` \| `ORDER_CHARGE` \| `PAYMENT` \| `REVERSAL` \| `OPENING_BALANCE` | Naturaleza contable |
| `description`       | string                                | Texto obligatorio |
| `occurredAt`        | Date                                  | Cuándo aplica contablemente |
| `sourceType`        | `MANUAL` \| `ORDER` \| `PAYMENT` \| `SYSTEM` \| `REVERSAL` | Origen del movimiento |
| `sourceId`          | ObjectId?                             | Identificador externo opcional |
| `idempotencyKey`    | string?                               | Clave opcional para deduplicación |
| `reversesMovementId`| ObjectId? (AccountMovement)           | Apunta al movimiento revertido |
| `createdBy`         | ObjectId? (User)                      | Auditoría |
| `createdAt`/`updatedAt` | Date                              | Timestamps |

En FASE 4 sólo se crean públicamente movimientos de tipo `MANUAL_ADJUSTMENT` y `REVERSAL`. Los demás tipos existen para mantener la **forward-compatibility** con FASE 6 (Payments) y FASE 7 (Orders).

### Inmutabilidad

`AccountMovement` es **inmutable**. El backend **NO** expone:

- `PATCH /api/accounts/movements/:id` → responde `404 NOT_FOUND`.
- `DELETE /api/accounts/movements/:id` → responde `404 NOT_FOUND`.

Ante un error, se genera un movimiento de tipo `REVERSAL` que apunta al original mediante `reversesMovementId`. El movimiento original nunca se modifica.

### Reversión

`POST /api/accounts/movements/:movementId/reverse`

Body:

```json
{ "description": "Reversión de ajuste incorrecto." }
```

Reglas:

1. El movimiento original debe existir (`404 NOT_FOUND` si no).
2. El original **NO** debe ser ya de tipo `REVERSAL` (`400 VALIDATION_ERROR`).
3. El original **NO** debe estar revertido (`409 CONFLICT`).
4. Se crea un nuevo `AccountMovement` con:
   - `direction` invertida (`DEBIT` ↔ `CREDIT`).
   - `amountMinor` igual al original.
   - `movementType = REVERSAL`.
   - `sourceType = REVERSAL`.
   - `sourceId = original._id`.
   - `reversesMovementId = original._id`.

La unicidad la garantiza un **índice único parcial sobre `reversesMovementId`** (independiente de la verificación de la capa de servicio). Esto cubre la race condition entre dos reversiones concurrentes.

### Idempotencia

`postMovement()` acepta `idempotencyKey` opcional. La estrategia es:

1. Si la key existe con un payload **idéntico** (`clientId + direction + amountMinor + movementType`), se devuelve el movimiento existente sin crear uno nuevo.
2. Si la key existe con un payload **distinto**, se lanza `IdempotencyConflictError` (mapeado a `409 CONFLICT` por el controller).
3. Si la key no existe, se intenta insertar. Ante un error de clave duplicada por concurrencia se re-lee y se aplica la misma regla.
4. Sin `idempotencyKey`, cada llamada crea un movimiento nuevo (comportamiento por defecto).

El índice único parcial sobre `idempotencyKey` es la garantía última a nivel de base de datos.

### Cálculo del saldo

```ts
balanceMinor = sum(DEBIT) - sum(CREDIT);
status = balance > 0 ? 'DEBT' : balance < 0 ? 'CREDIT' : 'SETTLED';
```

El saldo se calcula **siempre** en línea (`aggregate` de Mongoose). No se persiste `currentBalanceMinor` en `Client`. La justificación: el ledger es la única fuente de verdad, no hay riesgo de desincronización y se evita la necesidad de transacciones que actualicen dos documentos. Si en el futuro aparece un problema real de performance, se introducirá un cache derivado explícito.

### `postMovement` service (única vía)

Todos los controllers llaman a `postMovement(...)`. **Nunca** se llama a `AccountMovement.create()` directamente desde un controller. Esto permite que `Orders` (FASE 7) y `Payments` (FASE 6) reusen el mismo servicio.

```ts
postMovement({
  clientId, direction, amountMinor, movementType,
  description, sourceType, sourceId?, idempotencyKey?, createdBy?, occurredAt?, session?
})
```

El parámetro `session?: ClientSession` permite, en fases futuras, registrar movimientos dentro de la misma transacción MongoDB que crea un `Order` u otro documento.

### Helper centralizado

- `getClientAccountSummary(clientId)` → `{ totalDebitsMinor, totalCreditsMinor, balanceMinor, status, lastMovementAt }`.

Los controllers y otros services nunca recalculan manualmente.

### Endpoints

| Método | Endpoint                                          | Permiso            | Descripción |
| ------ | ------------------------------------------------- | ------------------ | ----------- |
| GET    | `/api/accounts`                                   | `accounts.read`    | Listado paginado con resumen por cliente. Soporta `search`, `clientType`, `clientActive`, `balanceStatus` (`DEBT` \| `CREDIT` \| `SETTLED`). La paginación refleja correctamente el filtro de `balanceStatus`. |
| GET    | `/api/accounts/:clientId/summary`                 | `accounts.read`    | Resumen de cuenta (cliente + totales + saldo + estado + último movimiento). |
| GET    | `/api/accounts/:clientId/movements`               | `accounts.read`    | Historial paginado (`page`, `limit`, máx 100, default 20) ordenado por `occurredAt DESC, _id DESC`. Filtros: `direction`, `movementType`, `dateFrom`, `dateTo`. |
| POST   | `/api/accounts/:clientId/adjustments`             | `accounts.adjust`  | Crea un movimiento `MANUAL_ADJUSTMENT` (DEBIT o CREDIT). Body: `{ direction, amountMinor, description }`. |
| POST   | `/api/accounts/movements/:movementId/reverse`     | `accounts.reverse` | Genera un `REVERSAL` del movimiento indicado. Body: `{ description }`. |
| GET    | `/api/accounts/me/summary`                        | `accounts.self`    | Resumen del cliente vinculado al usuario `CIUDADANO` autenticado. **No** acepta `clientId` por query ni por path. |
| GET    | `/api/accounts/me/movements`                      | `accounts.self`    | Historial del cliente vinculado al usuario `CIUDADANO` autenticado. |

> Las rutas `/me/*` se registran **antes** que `/:clientId/*` para que Express nunca interprete `"me"` como un ObjectId.

### Permisos

| Permiso             | SUPER_ADMIN | ADMIN | OPERADOR | REPARTIDOR | CIUDADANO |
| ------------------- | :---------: | :---: | :------: | :--------: | :-------: |
| `accounts.read`     | ✓           | ✓     | ✓        | ✓          | —         |
| `accounts.adjust`   | ✓           | ✓     | ✓        | —          | —         |
| `accounts.reverse`  | ✓           | ✓     | —        | —          | —         |
| `accounts.self`     | ✓           | —     | —        | —          | ✓         |

> `OPERADOR` puede cargar ajustes pero **no** revertir. `REPARTIDOR` es solo lectura. `CIUDADANO` accede únicamente a su propia cuenta. **Nunca** se reutiliza `accounts.read` para exponer cuentas a `CIUDADANO`.

### Clientes inactivos

**No** se bloquea la lectura ni la registración de movimientos sobre clientes inactivos. Un cliente inactivo puede tener deuda histórica pendiente y la Municipalidad debe poder regularizarla. La restricción de "cliente inactivo no puede generar nueva cotización" del motor de pricing **no se replica** acá: la cuenta corriente y la habilitación para nuevas ventas son dominios independientes.

### Índices del ledger

- `clientId + occurredAt DESC + _id DESC` (lectura principal del historial).
- `clientId + movementType + occurredAt DESC`.
- `idempotencyKey` único parcial (`{ $type: 'string' }`).
- `reversesMovementId` único parcial (`{ $type: 'objectId' }`).
- `createdAt DESC`.

### Smoke test E2E

```bash
npm run smoke:accounts
```

Crea un `SUPER_ADMIN`, dos clientes `LOCAL`, dos ciudadanos vinculados, ejercita el flujo completo:

1. cuenta vacía → `SETTLED` ($0).
2. `DEBIT $10.000` → `DEBT $10.000`.
3. `CREDIT $4.000`  → `DEBT $6.000`.
4. `CREDIT $8.000`  → `CREDIT $2.000` (saldo a favor).
5. Reversión del `CREDIT $8.000` → `DEBT $6.000`.
6. Verifica que el original y la reversión siguen existiendo.
7. Segunda reversión → `409 CONFLICT`.
8. Idempotencia con `postMovement` → mismo `_id`.
9. `REPARTIDOR` → `200` lectura, `403` ajuste.
10. `OPERADOR` → `201` ajuste, `403` reversión.
11. `CIUDADANO` → `200` en `/me/summary`, `403` sobre la cuenta de otro ciudadano.

## FASE 5 — Portal Ciudadano

FASE 5 expone la experiencia autenticada del ciudadano. NO crea pedidos, pagos ni comprobantes — sólo construye una base ciudadana real sobre los módulos existentes (Clients, Accounts, Pricing).

### Principio de privacidad

Un ciudadano NUNCA envía `clientId` para consultar sus propios datos. El backend identifica automáticamente su `Client` mediante `Client.userId === req.user._id`. La identidad autenticada es la fuente de verdad.

Para endpoints ciudadanos se usa el patrón `/api/.../me/...`. NO se confían en IDs enviados por el frontend para identificar al cliente del ciudadano.

### User y Client siguen siendo entidades distintas

`User` es identidad de autenticación. `Client` es el registro municipal del servicio. Un `Client` puede existir sin `User`; un `User CIUDADANO` debe estar vinculado a un único `Client` para usar el portal. La relación actual `Client.userId` se mantiene.

### Permisos nuevos

| Permiso          | Asignación                                                          |
| ---------------- | ------------------------------------------------------------------- |
| `clients.self`   | `CIUDADANO` (también SUPER_ADMIN por spread `ALL_PERMISSIONS`)       |
| `clients.linkUser` | `SUPER_ADMIN` + `ADMIN` (NO `OPERADOR` / `REPARTIDOR` / `CIUDADANO`) |

El ciudadano NO obtiene `clients.read` general. Sus endpoints `/me` están protegidos por `clients.self`.

### `GET /api/clients/me`

Devuelve el `Client` vinculado al `User` autenticado. Registrado **antes** de `/:id` para que Express no interprete `"me"` como `ObjectId`.

Si el `User` no tiene `Client` vinculado:

```
404 NOT_FOUND
code: CLIENT_NOT_LINKED
message: "Tu usuario todavía no está vinculado a un cliente."
```

### DTO `CitizenClientDto`

El DTO NUNCA expone:

- `notes` (observaciones administrativas)
- `userId`
- `createdBy`, `updatedBy`
- `passwordHash` ni ningún campo de `User`

Sólo expone campos seguros:

```
id, firstName, lastName, fullName, documentType, documentNumber,
phone, email, clientType, address { ... }, active, createdAt
```

### `PATCH /api/clients/me`

Sólo permite modificar:

- `phone`
- `email`
- `address.street`, `address.number`, `address.floor`, `address.apartment`,
  `address.neighborhood`, `address.postalCode`, `address.references`

NO permite (rechaza con `400`):

- `firstName`, `lastName`, `documentType`, `documentNumber`
- `clientType`, `active`, `userId`, `createdBy`, `updatedBy`, `notes`
- `address.locality` (administrada por el personal municipal porque puede
  condicionar el tratamiento comercial LOCAL/NO_LOCAL)

Schema Zod **strict**: cualquier campo extra es `400 VALIDATION_ERROR`. NO se
hace `Object.assign(client, req.body)`.

### Vinculación administrativa

`POST /api/clients/:clientId/citizen-access`

- `authenticate`
- `requirePermission('clients.linkUser')`

Body:

```json
{ "email": "ciudadano@email.com" }
```

El backend:

1. normaliza email;
2. busca `User`;
3. `User.role === CIUDADANO`;
4. `User.active === true`;
5. `Client` debe existir;
6. `User` no puede estar vinculado a otro `Client`;
7. `Client` no puede estar vinculado a otro `User` sin desvincular primero.

Si la misma pareja `User ↔ Client` ya está vinculada: respuesta idempotente `200`.

Si la operación intentara vincular a otro Client/User: `409 CONFLICT`.

El índice `unique partial` sobre `Client.userId` sigue siendo la última garantía
concurrente.

### `DELETE /api/clients/:clientId/citizen-access`

NO elimina `User`, `Client`, ni movimientos del ledger. Sólo `Client.userId = null`.
Registra `updatedBy` para auditoría.

Un ciudadano desvinculado pierde inmediatamente acceso a `/api/clients/me`,
`/api/accounts/me/*`, `/api/pricing/me/*`. Su historial financiero se conserva.

### `POST /api/pricing/me/quote`

Body (sin `clientId`):

```json
{
  "items": [
    { "productId": "...", "quantity": 1 }
  ]
}
```

El backend:

1. obtiene `req.user`;
2. encuentra `Client` vinculado;
3. invoca `buildQuote()` del Pricing Engine existente;
4. devuelve la cotización.

NO se duplica lógica de pricing. El endpoint `/api/pricing/quote` (con `clientId`)
sigue existiendo para uso del staff. El frontend ciudadano SIEMPRE usa `/me/quote`.

### Cliente inactivo

Un `Client` con `active = false`:

- SÍ puede ver perfil, cuenta corriente y movimientos.
- NO puede obtener cotizaciones (Pricing Engine rechaza al inactivo).

El frontend interpreta el error y muestra:

> "Tu cuenta no está habilitada actualmente para nuevas operaciones. Podés seguir consultando tu cuenta y movimientos."

### Cliente no vinculado

Si el `User CIUDADANO` no tiene `Client` asociado, el portal muestra:

> "Tu cuenta todavía no está vinculada a un registro de cliente."

NO redirige en bucle, NO crea Client automáticamente, NO expone stack trace.

### Privacidad e IDOR

- El ciudadano NO puede cambiar URL para acceder a otro Client (faltan permisos).
- NO puede enviar `clientId` de otro cliente (los endpoints `/me` lo ignoran).
- NO puede cambiar `clientType`, `documentNumber`, `active`, `userId`, ni leer `notes`.
- NO puede leer movimientos de cuenta de otro cliente.
- NO puede cotizar en nombre de otro cliente.

Tests explícitos en `tests/clients-self.test.ts` y `tests/pricing-self.test.ts`.

### Smoke test

```bash
npm run smoke:citizen
```

Flujo completo en memoria: SUPER_ADMIN + CIUDADANO + Client JUBILADO + producto + regla -50% + ledger → link → /me → pricing rule change dinámico → unlink → verificación de persistencia.

## FASE 6 — Pagos y comprobantes

FASE 6 implementa el ciclo de pagos informados por los ciudadanos: subida de comprobante → revisión municipal → acreditación en la cuenta corriente → posibilidad de revertir aprobaciones incorrectas. **NO** implementa pedidos ni cobros en reparto.

### Principio contable

`Payment` es el registro del flujo administrativo de un pago. **NO** es el saldo.

- `Payment PENDING` → no genera movimiento en el ledger.
- `Payment APPROVED`  → genera `CREDIT` (movementType=PAYMENT).
- `Payment REJECTED`  → no genera movimiento.
- `Payment REVERSED`  → genera un movimiento `REVERSAL` del `CREDIT` original.

El saldo se sigue derivando **exclusivamente** desde `AccountMovement` (ver FASE 4). Nunca se hace `client.balance -= amount`.

### Máquina de estados

```
PENDING ──► APPROVED ──► REVERSED  (terminal)
   │
   └────► REJECTED         (terminal)
```

No se permite `REJECTED → APPROVED`, `APPROVED → REJECTED` ni `PENDING → REVERSED`. Si el ciudadano necesita reenviar un comprobante, debe crear un nuevo Payment.

El backend garantiza unicidad del efecto financiero mediante:

- `idempotencyKey = "PAYMENT:<paymentId>:APPROVED"` en el ledger.
- Índice `unique partial` sobre `AccountMovement.idempotencyKey`.
- Transacción MongoDB que une `postMovement()` + update del Payment (atomic).
- `unique partial` sobre `Payment.ledgerMovementId` y `Payment.reversalMovementId`.

### Receipts

Los comprobantes se almacenan en un directorio privado configurable por `PAYMENT_RECEIPTS_DIR` (default `./storage/payment-receipts`). El directorio está en `.gitignore`.

- **NO** se sirven vía `express.static`. El endpoint `/receipt` transmite el archivo con headers `Content-Type` correcto, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
- **NO** se acepta SVG, ZIP, HTML, scripts, ejecutables, ni documentos Office.
- Validación por **magic bytes** (no se confía en la extensión ni en el `Content-Type` enviado por el navegador). Se usa `file-type`.
- Magic bytes permitidos: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.
- Tamaño máximo: **8 MB** (`MAX_RECEIPT_SIZE_BYTES`).
- Nombre en disco: UUID + extensión detectada. El `originalName` se conserva sólo como metadata.

### Abstracción de storage

`PaymentReceiptStorage` (en `src/modules/payments/payments.storage.ts`) expone:

```ts
save(storageKey, sourcePath): Promise<string>;
openReadStream(storageKey): ReadStream;
exists(storageKey): Promise<boolean>;
delete(storageKey): Promise<void>;
resolveAbsolutePath(storageKey): string;
```

La implementación por defecto es `LocalPaymentReceiptStorage` (filesystem). Cambiar la implementación es un drop-in replacement para S3/R2/otro.

### Endpoints ciudadano

| Método | Endpoint | Permiso | Descripción |
|---|---|---|---|
| `POST` | `/api/payments/me` | `payments.self` | Informa un pago. `multipart/form-data` con `receipt` (obligatorio), `amountMinor`, `paymentMethod`, `note?`. Rate-limit 10/15min/usuario. |
| `GET` | `/api/payments/me` | `payments.self` | Lista pagos del ciudadano con paginación + filtro `status`. |
| `GET` | `/api/payments/me/:id` | `payments.self` | Detalle de un Payment del ciudadano. |
| `GET` | `/api/payments/me/:id/receipt` | `payments.self` | Stream autenticado del comprobante. |

### Endpoints administración

| Método | Endpoint | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/payments` | `payments.read` | Lista pagos con búsqueda + filtros (status, method, clientType, rango de fechas) + sort. |
| `GET` | `/api/payments/:id` | `payments.read` | Detalle admin. |
| `POST` | `/api/payments/:id/approve` | `payments.review` | Aprueba y crea `CREDIT` en el ledger. Idempotente: `409` en reintentos. |
| `POST` | `/api/payments/:id/reject` | `payments.review` | Rechaza. Body: `{ reason }` obligatorio. No genera ledger. |
| `POST` | `/api/payments/:id/reverse-approval` | `payments.reverse` | Revierte una aprobación. Crea `REVERSAL` del `CREDIT` original. Idempotente. |
| `GET` | `/api/payments/:id/receipt` | `payments.read` | Stream autenticado del comprobante. |

### Permisos

| Permiso | SUPER_ADMIN | ADMIN | OPERADOR | REPARTIDOR | CIUDADANO |
|---|---|---|---|---|---|
| `payments.read` | ✓ | ✓ | ✓ | — | — |
| `payments.review` | ✓ | ✓ | — | — | — |
| `payments.reverse` | ✓ | ✓ | — | — | — |
| `payments.self` | ✓ | — | — | — | ✓ |

`OPERADOR` puede **leer** pero **NO** aprobar, rechazar ni revertir.

### Variables de entorno

```
PAYMENT_RECEIPTS_DIR=./storage/payment-receipts
PAYMENT_SUBMIT_RATE_LIMIT=   # "disabled" desactiva el rate-limit (tests)
```

### Smoke test E2E

```bash
npm run smoke:payments
```

Usa `MongoMemoryReplSet` (porque FASE 6 requiere transacciones). Crea usuarios, ledger inicial, dos pagos del ciudadano A, prueba approve/reject/reverse con todos los RBAC, valida el saldo en cada paso y verifica que los comprobantes se conservan para todos los estados finales.

## FASE 7 + FASE 8 MVP — Pedidos y reparto

El módulo `src/modules/orders/` implementa el circuito principal de la DEMO MVP: el ciudadano pide, se genera un cargo en cuenta corriente, la administración asigna un repartidor y el repartidor entrega desde el celular. Existe además la "entrega directa" del repartidor para clientes que reciben sin pedido previo.

### Modelo Order

```
{
  _id, clientId, origin (CITIZEN | STAFF), status,
  items: [{ productId, productCode, productName, productType,
            quantity,
            unitBasePriceMinor, adjustmentPercentage,
            unitFinalPriceMinor,
            subtotalBaseMinor, subtotalFinalMinor,
            appliedRuleId?, appliedRuleName? }],
  totalBaseMinor, totalFinalMinor,
  deliveryAddressSnapshot: { street, number, floor?, apartment?,
                             neighborhood?, locality, postalCode?, references? },
  customerNote?,
  accountMovementId?,          // DEBIT ledger entry (omitido si total=0)
  assignedTo?, assignedAt?,
  startedDeliveryAt?, deliveredAt?,
  cancelledAt?, cancellationReason?, cancellationMovementId?,
  createdBy, createdAt, updatedAt
}
```

### Estados

```
CONFIRMED → ASSIGNED → OUT_FOR_DELIVERY → DELIVERED
CONFIRMED → CANCELLED
ASSIGNED  → CANCELLED
```

`DELIVERED` y `CANCELLED` son terminales. `OUT_FOR_DELIVERY → CANCELLED` no se permite en el MVP.

### Snapshot de precios

Al crear un pedido el backend **recalcula** el precio con el `Pricing Engine` y persiste los totales como `*Minor` enteros. Cambiar una regla de precios (p. ej. JUBILADO -50% → -20%) **NO** afecta pedidos ya generados: el snapshot en `Order.items` queda congelado para siempre.

### Integración con el ledger

`POST /api/orders/me` (y `POST /api/delivery/me/direct-order`) crean `Order + AccountMovement(DEBIT, ORDER_CHARGE)` dentro de una transacción Mongo. Si el total es **$0**, no se crea el `AccountMovement` (la cuenta corriente no se modifica). La cancelación revierte el DEBIT con un REVERSAL atómico.

### Endpoints principales

| Método | Ruta | Permiso |
| ------ | ---- | ------- |
| POST   | `/api/orders/me`                 | `orders.self` |
| GET    | `/api/orders/me`                 | `orders.self` |
| GET    | `/api/orders/me/:id`             | `orders.self` |
| POST   | `/api/orders/me/:id/cancel`      | `orders.self` |
| GET    | `/api/orders`                    | `orders.read` |
| GET    | `/api/orders/available-drivers`  | `orders.assign` |
| GET    | `/api/orders/:id`                | `orders.read` |
| POST   | `/api/orders/:id/assign`         | `orders.assign` |
| POST   | `/api/orders/:id/cancel`         | `orders.cancel` |
| GET    | `/api/delivery/me/orders`        | `delivery.read` |
| GET    | `/api/delivery/me/orders/:id`    | `delivery.read` |
| POST   | `/api/delivery/me/orders/:id/start`   | `delivery.update` |
| POST   | `/api/delivery/me/orders/:id/deliver` | `delivery.update` |
| POST   | `/api/delivery/me/direct-order`  | `delivery.create` |

### Operadores reales (producción)

1. Configurar `.env` con las variables `REAL USERS` (ver bloque dedicado
   en `.env.example`). Cada operador tiene tres variables: `_EMAIL`,
   `_PASSWORD` y `_PHONE`. Los defaults apuntan a las cuentas reales
   de la Municipalidad.

2. Sembrar los 4 usuarios reales (idempotente — omite los que ya existen):
   ```
   npm run seed:real-users
   ```
   Crea:
   - `ADMIN` — Tesorería (Maribel Arduzzo)
   - `ADMIN` — Secretaría contable (Macarena Gonzalez)
   - `REPARTIDOR` — Ezequiel Biasini
   - `REPARTIDOR` — Robertino Goggi

   Para crear el `SUPER_ADMIN` propio:
   ```
   # Editar SEED_ADMIN_* en .env con las credenciales deseadas
   npm run seed:admin
   ```

3. Arrancar la app:
   ```
   npm run build:full && npm start
   ```

### DEMO MVP — instrucciones (testing, opcional)

> Las cuentas `*@demo.local` son ficticias. Úsalas solo si querés
> volver a poblar la base con datos de prueba después de haber corrido
> `seed:real-users`. Para limpiar esos artefactos después, usá
> `npm run cleanup:testing`.

1. Configurar `.env` con las variables `DEMO_*`:
   ```
   DEMO_ADMIN_PASSWORD=…
   DEMO_DRIVER_PASSWORD=…
   DEMO_CITIZEN_PASSWORD=…
   ```
   Las cuentas de email (`DEMO_*_EMAIL`) tienen defaults seguros para demo.
   En `NODE_ENV=production` el seed aborta si las contraseñas siguen siendo
   los placeholders `DemoXxx123!`.

2. Sembrar datos demo (idempotente):
   ```
   npm run seed:demo
   ```
   Crea usuarios (`admin@demo.local`, `repartidor@demo.local`, `ciudadano@demo.local`),
   clientes `JUBILADO` (vinculado al ciudadano) / `LOCAL` / `AYUDA_SOCIAL`,
   productos `RECARGA $10.000 / BIDÓN $15.000 / DISPENSER $35.000`,
   reglas de precio (`LOCAL 0%`, `JUBILADO -50%`, `AYUDA_SOCIAL -100%`)
   y datos históricos para que las pantallas no aparezcan vacías al inicio
   (un pedido entregado+pagado del ciudadano JUBILADO, una entrega directa
   del cliente LOCAL con pago pendiente, una entrega AYUDA_SOCIAL y un
   pedido JUBILADO CONFIRMED esperando asignación).

3. Arrancar la app:
   ```
   npm run build:full && npm start
   ```
4. Recorrido sugerido:
   - Login `ciudadano@demo.local` → Hacer pedido → Confirmar.
   - Login `admin@demo.local` → Inicio → ver "Pedidos por asignar" → Pedidos → Asignar repartidor.
   - Login `repartidor@demo.local` → Iniciar → Marcar entregado.
   - Login `ciudadano@demo.local` → Informar pago → $0 en cuenta.
   - Login `repartidor@demo.local` → Nueva entrega (buscar cliente LOCAL) → Confirmar → Entregar.

5. Smoke tests E2E:
   ```
   npm run smoke:pricing
   npm run smoke:accounts
   npm run smoke:citizen
   npm run smoke:payments
   npm run smoke:mvp          # usa MongoMemoryReplSet (transaccional)
   npm run smoke:standalone   # usa MongoMemoryServer SIN replset (fallback)
   ```

   `smoke:mvp` valida el circuito completo (ciudadano + admin +
   repartidor + pago) con transactions. `smoke:standalone` valida el
   mismo circuito contra MongoDB sin Replica Set para confirmar que
   el fallback compensado mantiene la consistencia.

### Limpiar artefactos de testing

```
npm run cleanup:testing -- --dry-run   # ver qué se borraría, sin tocar la DB
npm run cleanup:testing                # borrar usuarios/clientes/pedidos/pagos/movimientos/comprobantes del seed:demo
```

El script preserva productos y reglas de pricing (catálogo) y cualquier
registro que no esté marcado como demo (por ejemplo, órdenes o pagos
creados por usuarios reales durante operación normal).

## Licencia

Privado.
