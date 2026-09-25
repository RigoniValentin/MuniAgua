export const CLIENT_TYPES = {
  LOCAL: 'LOCAL',
  JUBILADO: 'JUBILADO',
  NO_LOCAL: 'NO_LOCAL',
  AYUDA_SOCIAL: 'AYUDA_SOCIAL',
} as const;

export type ClientType = (typeof CLIENT_TYPES)[keyof typeof CLIENT_TYPES];

export const ALL_CLIENT_TYPES: ClientType[] = Object.values(CLIENT_TYPES);

export const DOCUMENT_TYPES = {
  DNI: 'DNI',
  CUIT: 'CUIT',
  CUIL: 'CUIL',
  OTHER: 'OTHER',
} as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[keyof typeof DOCUMENT_TYPES];

export const ALL_DOCUMENT_TYPES: DocumentType[] = Object.values(DOCUMENT_TYPES);

export interface ClientTypeMeta {
  value: ClientType;
  label: string;
  description: string;
}

export const CLIENT_TYPE_META: Record<ClientType, ClientTypeMeta> = {
  LOCAL: {
    value: 'LOCAL',
    label: 'Local',
    description: 'Cliente dentro del ejido municipal',
  },
  JUBILADO: {
    value: 'JUBILADO',
    label: 'Jubilado',
    description: 'Cliente adulto mayor',
  },
  NO_LOCAL: {
    value: 'NO_LOCAL',
    label: 'No local',
    description: 'Cliente fuera del ejido municipal',
  },
  AYUDA_SOCIAL: {
    value: 'AYUDA_SOCIAL',
    label: 'Ayuda social',
    description: 'Cliente con beneficio social',
  },
};

export const DOCUMENT_TYPE_META: Record<DocumentType, string> = {
  DNI: 'DNI',
  CUIT: 'CUIT',
  CUIL: 'CUIL',
  OTHER: 'Otro',
};

export const SORTABLE_FIELDS = [
  'lastName',
  'firstName',
  'createdAt',
  'updatedAt',
] as const;

export type ClientSortableField = (typeof SORTABLE_FIELDS)[number];

export const DEFAULT_SORT_FIELD: ClientSortableField = 'lastName';
export const DEFAULT_SORT_ORDER: 'asc' | 'desc' = 'asc';
