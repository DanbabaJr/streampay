export type EventValue = string | number | bigint | boolean | null | EventValue[] | { [key: string]: EventValue };

export interface DecodedEvent {
  id: string;
  pagingToken: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  name: string;
  streamId: string;
  data: Record<string, EventValue>;
}

export interface RpcEvent {
  id: string;
  pagingToken?: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: (string | unknown)[];
  value: string | unknown;
}

export interface Stream {
  id?: string;
  streamId: string;
  sender: string | null;
  recipient: string | null;
  token: string | null;
  deposit: string | null;
  withdrawn: string;
  startTime: string | null;
  endTime: string | null;
  cancelable: boolean | null;
  status: string;
  cancelled_by?: string | null;
  recipient_amount?: string | null;
  sender_amount?: string | null;
  lastLedger: number;
  updatedAt: string;
}
