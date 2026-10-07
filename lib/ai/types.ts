// Shared types for the LALUM automated pipeline. Erasable TypeScript only (no enums, no
// parameter properties) so the same files run under Deno (edge function), Node >= 22 and tsc.

export type PracticeArea = 'REAL_ESTATE' | 'COMMERCIAL_MA' | 'LABOR_LAW' | 'AI_GOVERNANCE' | 'LITIGATION';
export const PRACTICE_AREAS: readonly PracticeArea[] = ['REAL_ESTATE', 'COMMERCIAL_MA', 'LABOR_LAW', 'AI_GOVERNANCE', 'LITIGATION'];

export type PiiKind = 'ID_NUMBER' | 'COMPANY_REG' | 'EMAIL' | 'PHONE' | 'LAND_PARCEL' | 'CLIENT_NAME' | 'BANK_ACCOUNT' | 'ADDRESS';
export type PartyRole = 'CLIENT' | 'ADVERSE' | 'OTHER';
export type TrafficLight = 'GREEN' | 'YELLOW' | 'RED';
/** Stored (Prisma-compatible) conflict status. GREEN=CLEAN, YELLOW=POTENTIAL, RED=DIRECT_CONFLICT. */
export type ConflictStatus = 'CLEAN' | 'POTENTIAL' | 'DIRECT_CONFLICT';
export type PipelineSource = 'UPLOAD' | 'INTAKE_WEBHOOK' | 'CHAT';

export interface DeclaredParty {
  name?: string;
  aliases?: string[];
  role: PartyRole;
  idNumber?: string;
  companyReg?: string;
}

/** What leaves the trusted zone: no values. */
export interface PublicEntity {
  token: string;
  kind: PiiKind;
  start: number; // offsets into the ORIGINAL text, which only the submitting browser still holds
  end: number;
}

/** In-memory only. Never log, persist or return this. */
export interface SensitiveDetection extends PublicEntity {
  value: string;
  confidence: number;
  role: PartyRole | 'UNKNOWN';
}

export class PiiLeakError extends Error {
  kinds: string[];
  constructor(kinds: string[]) {
    super(`Residual PII detected after masking: ${kinds.join(', ')}`);
    this.name = 'PiiLeakError';
    this.kinds = kinds;
  }
}

export class PipelineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
  }
}
