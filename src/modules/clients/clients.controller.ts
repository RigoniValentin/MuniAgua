import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import {
  clientListQuerySchema,
  createClientSchema,
  linkCitizenAccessSchema,
  updateClientSchema,
  updateSelfClientSchema,
} from './clients.validation.js';
import {
  createClient,
  getClientOrThrow,
  getCitizenAccess,
  getSelfClientOrThrow,
  linkCitizenAccess,
  listClients,
  toCitizenClientDto,
  toClientDto,
  unlinkCitizenAccess,
  updateClient,
  updateSelfClient,
} from './clients.service.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { ValidationError } from '../../shared/errors.js';

export const listClientsController = asyncHandler(async (req: Request, res: Response) => {
  const query = clientListQuerySchema.parse(req.query);
  const result = await listClients(query);
  res.json(ok(result));
});

export const getClientController = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) {
    throw new ValidationError('Identificador requerido');
  }
  if (!Types.ObjectId.isValid(id)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  const client = await getClientOrThrow(id);
  res.json(ok({ client: toClientDto(client) }));
});

export const createClientController = asyncHandler(async (req: Request, res: Response) => {
  const data = createClientSchema.parse(req.body);
  const createdBy = req.user?.id ?? null;
  const client = await createClient({ ...data, createdBy });
  res.status(201).json(ok({ client: toClientDto(client) }));
});

export const updateClientController = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) {
    throw new ValidationError('Identificador requerido');
  }
  if (!Types.ObjectId.isValid(id)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  const data = updateClientSchema.parse(req.body);
  const updatedBy = req.user?.id ?? null;
  const client = await updateClient(id, { ...data, updatedBy });
  res.json(ok({ client: toClientDto(client) }));
});

// ============================================================================
// Citizen self endpoints — registered before /:id so Express never maps "me"
// to an ObjectId.
// ============================================================================

function requireUserId(req: Request): string {
  const id = req.user?.id;
  if (!id) {
    throw new ValidationError('No autenticado');
  }
  return id;
}

export const getSelfClientController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const client = await getSelfClientOrThrow(userId);
    res.json(ok({ client: toCitizenClientDto(client) }));
  },
);

export const updateSelfClientController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const data = updateSelfClientSchema.parse(req.body);
    const client = await updateSelfClient(userId, data);
    res.json(ok({ client: toCitizenClientDto(client) }));
  },
);

// ============================================================================
// Administrative citizen-access endpoints
// ============================================================================

function requireObjectIdParam(value: string | undefined, label: string): string {
  if (!value) {
    throw new ValidationError(`${label} requerido`);
  }
  if (!Types.ObjectId.isValid(value)) {
    throw new ValidationError(`${label} inválido`);
  }
  return value;
}

export const getCitizenAccessController = asyncHandler(
  async (req: Request, res: Response) => {
    const clientId = requireObjectIdParam(req.params.clientId, 'Identificador de cliente');
    const access = await getCitizenAccess(clientId);
    res.json(ok({ access }));
  },
);

export const postCitizenAccessController = asyncHandler(
  async (req: Request, res: Response) => {
    const clientId = requireObjectIdParam(req.params.clientId, 'Identificador de cliente');
    const data = linkCitizenAccessSchema.parse(req.body);
    const actorId = req.user?.id ?? null;
    const result = await linkCitizenAccess(clientId, data.identifier, actorId);
    res.status(200).json(
      ok({
        linked: result.linked,
        client: { id: result.client._id.toString() },
        access: {
          linked: true,
          user: {
            id: result.user._id.toString(),
            firstName: result.user.firstName,
            lastName: result.user.lastName,
            email: result.user.email,
            documentNumber: result.user.documentNumber ?? null,
            active: result.user.active,
          },
        },
      }),
    );
  },
);

export const deleteCitizenAccessController = asyncHandler(
  async (req: Request, res: Response) => {
    const clientId = requireObjectIdParam(req.params.clientId, 'Identificador de cliente');
    const actorId = req.user?.id ?? null;
    const client = await unlinkCitizenAccess(clientId, actorId);
    res.json(ok({ access: { linked: false, user: null }, clientId: client._id.toString() }));
  },
);