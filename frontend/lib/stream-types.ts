export interface StreamView {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  startTime: number;
  endTime: number;
  cancelable: boolean;
  status: string;
}

export interface StreamArgs {
  token: string;
  recipient: string;
  /** Deposit in smallest token units (stroops for classic assets), as a string. */
  deposit: string;
  /** Stream length in days (start = now). */
  days: string;
  cancelable: boolean;
}

export interface StreamPolicyView {
  minDeposit: string;
  minDuration: number;
  maxDuration: number;
  minRate: string;
  maxRate: string;
}