/**
 * Citizen-facing DTO for Client. NEVER includes administrative fields.
 *
 * This DTO is the authoritative shape used by:
 *   - GET /api/clients/me
 *   - PATCH /api/clients/me (response)
 *
 * It must NEVER expose: notes, userId, createdBy, updatedBy, or any field
 * that does not belong to the citizen-facing surface.
 */
export interface CitizenClientDto {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  documentType: string | null;
  documentNumber: string | null;
  phone: string | null;
  email: string | null;
  clientType: string;
  address: {
    street: string;
    number: string | null;
    floor: string | null;
    apartment: string | null;
    neighborhood: string | null;
    locality: string;
    postalCode: string | null;
    references: string | null;
  };
  active: boolean;
  createdAt: string;
}

export interface CitizenAccessUserDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  documentNumber: string | null;
  active: boolean;
}

export interface CitizenAccessDto {
  linked: boolean;
  user: CitizenAccessUserDto | null;
}