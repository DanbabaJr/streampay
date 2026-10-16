# Demo walkthrough (testnet)

From a clean machine to a live, ticking payment stream in ~10 minutes. Run
the whole thing with one script, or follow the manual steps to understand
what each phase does.

> Tested against `stellar-cli` as pinned in README prerequisites; some CLI
> flag names change between stellar-cli releases — if a command below errors
> with `unexpected argument`, check `stellar contract asset create --help`
> for the current spelling of the same operation.

## One command

```bash
./scripts/deploy_testnet.sh
```

The script builds the Wasm, deploys the contract, registers a demo SAC
token, and opens a 1-hour cancelable stream of `1000000000` units (100.0
tokens at 7 decimals). It prints `contract id`, `token id`, `sender`, and
`recipient` at the end — copy the contract id.

## Manual walkthrough

### 1. Identities + funding

```bash
stellar keys generate deployer --network testnet
stellar keys generate sender   --network testnet
stellar keys generate recipient --network testnet
# Friendbot-test each account (or `--fund` at generation time):
curl "https://friendbot.stellar.org?addr=$(stellar keys address deployer)"
```

Expected: each `keys generate` prints a confirmation; friendbot returns the
funded account JSON.

### 2. Deploy the contract

```bash
stellar contract build   # in contracts/streaming-payments (sdk 28 requires stellar-cli)
stellar contract deploy \
  --wasm target/wasm32v1-none/release/streampay_contract.wasm \
  --source deployer --network testnet \
  -- --governor $(stellar keys address deployer)
```

Expected output: a contract id `C…` (46 chars). Arguments after `--` go to
the contract's constructor: `__constructor(governor)` binds the treasury
governor at deploy time (here: the deployer). Fees start disabled
(`fee_bps = 0`). Set it in `frontend/.env.local` as
`NEXT_PUBLIC_STREAMING_CONTRACT_ID`.

### 3. Demo token + approval

Register an asset (`stellar contract asset create --source deployer --network
testnet --issuer <deployer> --max-alpha4 DEMO --amount 1000000000 --salt
<32-hex>`), then mint to the sender and approve the streaming contract:

```bash
stellar contract invoke --id $TOKEN --source sender --network testnet -- \
  approve --spender $CONTRACT --amount 1000000000 --expiration_ledger +5000
```

`create_stream` pulls the deposit through this allowance — without it the
pull fails with `DepositTransferFailed` (#26): token-side failures are mapped
to distinct StreamPay codes, so a token's own error number can never
masquerade as one.

### 4. Create a stream

```bash
NOW=$(date +%s); END=$((NOW + 3600))
stellar contract invoke --id $CONTRACT --source sender --network testnet -- \
  create_stream --sender $SENDER --recipient $RECIPIENT --token $TOKEN \
  --deposit_amount 1000000000 --start_time $NOW --end_time $END --cancelable true
```

Expected output: `1` (the stream id).

### 5. Watch it stream

```bash
stellar contract invoke --id $CONTRACT --source sender --network testnet -- \
  available --stream_id 1
```

Expected: a number that grows by `deposit / duration` per second — for the
demo stream, ~`277777` units every second (1,000,000,000 / 3600, floored
per-second accrual).

### 6. Claim with `withdraw_max`

```bash
stellar contract invoke --id $CONTRACT --source recipient --network testnet -- \
  withdraw_max --stream_id 1
```

Expected output: the accrued amount paid out (an i128). Calling it again
within the same second reverts with `Error(Contract, #13)`
(`NothingToWithdraw`). A second call a minute later pays that minute's
accrual.

### 7. Cancel (pro-rata split)

```bash
stellar contract invoke --id $CONTRACT --source sender --network testnet -- \
  cancel_stream --caller $SENDER --stream_id 1
```

Expected: recipient receives everything accrued so far, sender is refunded
the unaccrued remainder, both in one transaction; `get_stream` afterwards
shows `status: Cancelled`. The recipient can also cancel because this demo
stream was created `cancelable`.

### 8. Discovery via the address indexes

```bash
stellar contract invoke --id $CONTRACT --source anyone --network testnet -- \
  recipient_streams --recipient $RECIPIENT --offset 0 --limit 50
```

Expected output: `[1, …]` — every stream id where that address is the
recipient, oldest first, clamped to 50 per page. `sender_streams` works the
same way for the funding side. This is what the frontend's **Discover
on-chain** button and the `/stream/[id]` detail page build on.

### 9. Scheduled intent + keeper

Pre-authorize a one-shot stream that a keeper materializes for you. The sender
approves the escrow exactly as in §3 (here `deposit + fee`), then schedules it:

```bash
NOW=$(date +%s)
stellar contract invoke --id $CONTRACT --source sender --network testnet -- \
  schedule_stream \
    --sender $SENDER --recipient $RECIPIENT --token $TOKEN \
    --deposit_amount 1000000 --start_time $((NOW + 60)) --end_time $((NOW + 3660)) \
    --cancelable true --interval 0 --occurrences 1 --fee_budget 100000 \
    --execute_after $NOW --expires_at $((NOW + 300))
```

Expected output: the intent id (`1`). Inspect it with `get_intent --intent_id 1`
— `status: Pending`, `occurrences_remaining: 1`.

Run the reference keeper against it (it simulates before sending):

```bash
CONTRACT_ID=$CONTRACT ONCE=1 INTENTS="1" ./scripts/keeper.sh
```

Expected: the keeper reports the intent as executable, sends the call, and the
fee is paid to the keeper. `get_intent --intent_id 1` now shows
`status: Executed`; the created stream id is in the `ScheduledStreamExecuted`
event and appears in `recipient_streams` / `sender_streams`.

For a **recurring** intent, set `--occurrences 3 --interval 86400` (three daily
streams) and the keeper will execute each occurrence as it comes due. See
[`SCHEDULED_INTENTS.md`](./SCHEDULED_INTENTS.md) for the timing model, the
keeper economics, and the threat model.

### 10. (Optional) Protocol fees + public verification

Fees are off by default. The governor (the deployer in this demo) can
configure ten basis points on new streams:

```bash
stellar contract invoke --id $CONTRACT --source deployer --network testnet -- \
  set_fee_bps --caller $(stellar keys address deployer) --new_fee_bps 10
```

Streams created afterwards charge `deposit × 10 / 10_000` on top of the
deposit (the sender's approval must cover `deposit + fee`), emit
`FeeCharged`, and accrue exactly as before — the fee never touches
per-second math. Anyone can audit the fee ledger without keys:

```bash
cd scripts && npm install
npm run verify-fees -- --contract $CONTRACT --token $TOKEN
# add --start-ledger <deploy ledger> to also reconcile the event trail
```

The script reconciles `treasury_status`, the `verify_treasury` per-stream
scan, and (optionally) the `FeeCharged` / `FeeWithdrawn` events, exiting
non-zero on any mismatch. Governor withdrawals:
`withdraw_treasury --caller <deployer> --token $TOKEN --recipient <G…> --amount N`.


## Frontend

```bash
cd frontend
cp .env.example .env.local   # paste the contract id
npm ci && npm run dev
```

Connect Freighter (testnet network), import the `sender` seed
(`stellar keys show sender`) or use any funded testnet account, and create
streams from the form. The stream list persists across reloads; each row
links to `/stream/<id>` with a live `available` read and one-click
**Withdraw max**.
