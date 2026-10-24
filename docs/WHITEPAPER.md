# StreamPay: a formal account of the protocol

**Status:** draft for review. **Pinned commit:** `952fa32` (the `main` tip this paper was written against). Every code claim is tagged `[Cn]` and resolves to a `file:line` and an anchor snippet in [Appendix A](#appendix-a--claim-to-code-traceability). `scripts/check_whitepaper_claims.py` checks in CI that each anchor still appears at its cited lines, so this paper fails loudly when the code moves under it.

**Honesty standard.** Every argument here is labelled either **Proof**, meaning complete given the stated assumptions and the cited code, or **Argument sketch**, meaning it depends on a property this paper does not prove, which is named. Nothing unlabelled is claimed to be proven.

**Scope.** This covers the stream core: creation, accrual, withdrawal, top-up and cancellation, plus the fee layer and storage rent. Scheduled intents appear only where they create streams or hold escrow. Governance, the upgrade timelock and the asset policy module are out of scope, except where a policy bound narrows an input domain.

---

## Contents

1. [Notation and machine model](#1-notation-and-machine-model)
2. [The stream model](#2-the-stream-model)
3. [The floor-accrual function](#3-the-floor-accrual-function)
4. [Per-stream accounting invariant](#4-per-stream-accounting-invariant)
5. [Endowment and contract solvency](#5-endowment-and-contract-solvency)
6. [Cancellation-refund correctness](#6-cancellation-refund-correctness)
7. [The fee layer](#7-the-fee-layer)
8. [Rent and economics](#8-rent-and-economics)
9. [Assumptions, and what is not proven](#9-assumptions-and-what-is-not-proven)
- [Appendix A — claim-to-code traceability](#appendix-a--claim-to-code-traceability)

---

## 1. Notation and machine model

| Symbol | Meaning |
|---|---|
| $\mathbb{Z}$, $\mathbb{N}$ | Integers; naturals including $0$ |
| $\lfloor x \rfloor$ | Floor of a real $x$ |
| $U$ | $2^{128}-1$, the largest `u128` |
| $I$ | $2^{127}-1$, the largest `i128` |
| $T_{\max}$ | $3{,}155{,}760{,}000$ s (100 Julian years) `[C1]` |
| $b_{\max}$ | $100$ basis points `[C2]` |
| $B$ | $10^4$, the basis-point denominator `[C3]` |
| $t$ | Ledger timestamp (seconds) at which an entrypoint runs |
| $a \div b$ | Integer (truncating) division; on non-negative operands equal to $\lfloor a/b \rfloor$ |

**Machine model.** An entrypoint is a transaction: it either returns `Ok` and commits all of its writes, or returns `Err` / traps and commits none of them. Token transfers made inside a failed entrypoint are rolled back with it. This is Soroban host semantics, not something the contract proves. It is assumption **A1** (§9), and every atomicity argument below rests on it.

**Arithmetic.** Contract arithmetic is checked: an operation that would leave its type returns `MathOverflow` (or a named branch of it) instead of wrapping `[C4]`. By A1, a checked failure is a reverted transaction, so no wrapped value is ever stored.

---

## 2. The stream model

A **stream** is a tuple

$$
s = (\sigma,\ \rho,\ \tau,\ D,\ W,\ t_0,\ t_1,\ c,\ \varphi)
$$

| Field | Code | Domain | Meaning |
|---|---|---|---|
| $\sigma$ | `sender` | address | Funds the stream |
| $\rho$ | `recipient` | address | Receives accrual |
| $\tau$ | `token` | address | SEP-41 asset |
| $D$ | `deposit` | $\mathbb{Z}$ | Total funded: creation deposit plus top-ups |
| $W$ | `withdrawn` | $\mathbb{Z}$ | Total paid to $\rho$: withdrawals plus the cancel payout |
| $t_0, t_1$ | `start_time`, `end_time` | $\mathbb{N}$ (`u64`) | The window |
| $c$ | `cancelable` | bool | Whether $\rho$ may also cancel |
| $\varphi$ | `status` | $\{\textsf{Active},\textsf{Cancelled},\textsf{Depleted}\}$ | Lifecycle state |

The layout is `[C5]`. We write $T(s) = t_1 - t_0$ for the **duration**.

### 2.1 Admissible streams

A stream is **admissible** when

$$
\mathcal{A}(s) \;:\Longleftrightarrow\; D \ge 1 \;\wedge\; 1 \le T \le T_{\max} \;\wedge\; D \cdot T \le U .
$$

The last conjunct is the **capacity bound**, and §3 shows it is exactly what makes accrual total.

> **Lemma 2.1 (every stored stream is admissible).** Every stream the contract persists satisfies $\mathcal{A}$, and keeps satisfying it.
>
> **Proof.** Two things need checking: that every write path persists only admissible values, and that nothing writes $D$ or the window except those paths.
>
> *Creation, single and batch.* `create_stream` `[C6]` and `create_streams` `[C52]` both run `validate_stream_creation` before persisting. It rejects $D \le 0$; it rejects $t_1 \le t_0$, so $T \ge 1$; it rejects $T > T_{\max}$; and it calls `validate_capacity(D, T)` `[C7]`. That function rejects iff $D > \lfloor U/T \rfloor$, after casting $D$ to `u128`, which is exact since $D \ge 1$ by then `[C8]`. For integers $D \ge 0$ and $T \ge 1$:
> $$D \le \lfloor U/T \rfloor \iff D\cdot T \le U.$$
> ($\Rightarrow$: $D\,T \le \lfloor U/T\rfloor\,T \le U$. $\Leftarrow$: $D \le U/T$ and $D \in \mathbb{Z}$ give $D \le \lfloor U/T \rfloor$.) So creation persists only admissible streams.
>
> *Scheduled creation.* `schedule_stream` runs `validate_schedule`, which checks $D \ge 1$, $T \le T_{\max}$ and `validate_capacity(D, T)` `[C9]`. Each occurrence shifts the window by $k \cdot \textit{interval}$ `[C10]`. Validation checks with checked arithmetic that the last shifted end fits in `u64` `[C11]`, so the saturating shift never saturates and every occurrence keeps the same $T$. The stream that `execute_scheduled` persists `[C12]` therefore has the validated $D$ and $T$.
>
> *Top-up* is the only other writer of $D$ `[C13]`. It requires an amount $a \ge 1$ `[C14]`, so $D' = D + a > D \ge 1$. It re-runs `validate_capacity(D', T)` before writing `[C15]`, so $D' T \le U$.
>
> *No other writer.* No code path assigns $t_0$, $t_1$ or $D$ outside creation and top-up `[C13]`. Storage migration reads each stream and re-stores it unchanged `[C16]`. $\blacksquare$

### 2.2 Lifecycle

$$
\textsf{Active} \xrightarrow{\ \texttt{cancel\_stream}\ } \textsf{Cancelled}
\qquad
\textsf{Active} \xrightarrow{\ \texttt{withdraw*},\ W = D\ } \textsf{Depleted}
$$

Both targets are terminal. Every mutating entrypoint on a stream first requires $\varphi = \textsf{Active}$: withdraw and withdraw_max `[C17]`, cancel `[C53]`, top_up `[C54]`, so nothing leaves a terminal state. A payout that makes $W = D$ sets $\textsf{Depleted}$ `[C18]`.

---

## 3. The floor-accrual function

### 3.1 Definition

The **elapsed time** of window $[t_0, t_1)$ at ledger time $t$ is the clamp `[C19]`

$$
\varepsilon(t) \;=\; \min\big(\max(t - t_0,\ 0),\ T\big)
\;=\;
\begin{cases}
0 & t \le t_0\\
t - t_0 & t_0 < t < t_1\\
T & t \ge t_1 .
\end{cases}
$$

The **accrual function** `streamed_at` `[C20]` is

$$
\mathrm{acc}(D, T, e) \;=\;
\begin{cases}
0 & e = 0 \;\vee\; D \le 0 \;\vee\; T = 0\\[2pt]
\min\!\big(\,(D\cdot e) \div T,\ D\,\big) & \text{otherwise,}
\end{cases}
$$

where $D \cdot e$ is a checked `u128` product that returns `MathOverflow` if it exceeds $U$. The amount **streamed** at time $t$ is $S(t) = \mathrm{acc}\big(D, T, \varepsilon(t)\big)$ `[C21]`.

### 3.2 Well-definedness

> **Theorem 3.1 (accrual is total on stored streams).** For every admissible $s$ and every $t \in \mathbb{N}$, the computation of $S(t)$ performs no failing operation, and
> $$S(t) = \left\lfloor \frac{D\,\varepsilon(t)}{T} \right\rfloor \in [0, D].$$
>
> **Proof.** Let $e = \varepsilon(t)$, so $0 \le e \le T$ by the clamp. If $e = 0$ the function returns $0$ with no arithmetic. Otherwise $D \ge 1$ and $T \ge 1$, so the guard is skipped and the following steps run.
> - **Casts.** `deposit as u128` is exact because $1 \le D \le I < U$. `elapsed as u128` is exact because it widens from `u64`.
> - **Product.** $D\,e \le D\,T \le U$ by $e \le T$ and the capacity bound. So `checked_mul` succeeds, and the `RateProductOverflow` branch is unreachable for admissible streams.
> - **Division.** The divisor is `duration.max(1)` $= T \ge 1$. It never divides by zero, and on non-negative operands $\div$ is $\lfloor\cdot\rfloor$.
> - **Cap.** $\lfloor D e / T\rfloor \le D e / T \le D$ because $e \le T$. So `.min(deposit)` returns the floor unchanged. It is a defensive cap that never binds on stored streams.
> - **Narrowing.** The result is at most $D \le I$, so the cast back to `i128` is exact.
>
> Each step is total, and the value is $\lfloor D e / T \rfloor \in [0, D]$. $\blacksquare$

**Corollary 3.2.** The parameter bounds in `acc` are tight. Without the capacity bound, $D = I$ and $T = T_{\max}$ give $D\,T \approx 5.4 \times 10^{47} > U \approx 3.4 \times 10^{38}$, and `checked_mul` would fail at $e = T$. The bound is what turns "returns `MathOverflow`" into "never fails". `[C7]` enforces it at every write of $D$ or $T$.

### 3.3 Properties

> **Lemma 3.3.** For admissible $s$, and $e, e' \in [0, T]$:
> 1. *Endpoints:* $\mathrm{acc}(D,T,0) = 0$ and $\mathrm{acc}(D,T,T) = D$.
> 2. *Monotone:* $e \le e' \Rightarrow \mathrm{acc}(D,T,e) \le \mathrm{acc}(D,T,e')$.
> 3. *Strictly below deposit before the end:* $e < T \Rightarrow \mathrm{acc}(D,T,e) < D$.
> 4. *Floor error:* $\dfrac{De}{T} - 1 < \mathrm{acc}(D,T,e) \le \dfrac{De}{T}$.
> 5. *Monotone in deposit:* $D \le D'$ (both admissible with the same $T$) $\Rightarrow \mathrm{acc}(D,T,e) \le \mathrm{acc}(D',T,e)$.
> 6. *Per-second increment:* $\mathrm{acc}(D,T,e+1) - \mathrm{acc}(D,T,e) \in \big\{\lfloor D/T \rfloor,\ \lceil D/T \rceil\big\}$ for $e < T$.
>
> **Proof.** All six follow from Theorem 3.1, which reduces $\mathrm{acc}$ to $\lfloor De/T\rfloor$.
> - (1) $\lfloor 0 \rfloor = 0$ and $\lfloor DT/T \rfloor = D$.
> - (2) $x \mapsto \lfloor x \rfloor$ is non-decreasing, and so is $e \mapsto De/T$ because $D, T > 0$.
> - (3) $e < T$ gives $De < DT$, so $De/T < D$. Since $D$ is an integer, $\lfloor De/T \rfloor \le D - 1$.
> - (4) This is $x - 1 < \lfloor x \rfloor \le x$.
> - (5) This is the same monotonicity argument as (2), in $D$.
> - (6) Write $De = qT + r$ with $0 \le r < T$, and $D = pT + d$ with $0 \le d < T$. Then $D(e+1) = (q+p)T + (r + d)$, so the increment is $p + \lfloor (r+d)/T \rfloor$. Since $0 \le r + d < 2T$, this is $p$ or $p + 1$. Here $p = \lfloor D/T \rfloor$, and $p+1 = \lceil D/T \rceil$ whenever $d > 0$ (if $d = 0$ then $r + d < T$, so the increment is $p$). $\blacksquare$

(3) is what makes depletion meaningful. A stream can only be fully withdrawn once its window has ended.

> **Corollary 3.4.** $\varphi = \textsf{Depleted} \Rightarrow t \ge t_1$ at the moment of depletion.
>
> **Proof.** Depletion requires $W = D$ `[C18]`, and Theorem 4.1 gives $W \le S(t)$, so $S(t) = D$. By Lemma 3.3(3), $\varepsilon(t) = T$, i.e. $t \ge t_1$. $\blacksquare$

---

## 4. Per-stream accounting invariant

Write $A(t) = S(t) - W$ for the **available** balance of an active stream `[C22]`.

> **Theorem 4.1 (accrual dominates payouts).** Assume ledger time is non-decreasing (**A2**). For every stream, at every time while $\varphi = \textsf{Active}$:
> $$0 \;\le\; W \;\le\; S(t) \;\le\; D. \tag{INV}$$
> Consequently $A(t) \ge 0$, the `AvailableBalanceOverflow` branch is unreachable, and `available` returns a value in $[0, D]$.
>
> **Proof.** By induction over the events that change $W$, $D$ or $t$. $S(t) \le D$ always holds by Theorem 3.1. We show $0 \le W \le S(t)$ is established at creation and preserved by every event.
> - *Create.* $W = 0$ `[C23]`, and $S(t) \ge 0$.
> - *Time advances,* $t \to t'$ with $t' \ge t$ by A2. Then $\varepsilon(t') \ge \varepsilon(t)$, so $S(t') \ge S(t) \ge W$ by Lemma 3.3(2).
> - *`withdraw(a)`.* It requires $a \ge 1$ and $a \le A(t)$ `[C24]`, then sets $W' = W + a$ `[C25]`. So $W < W' \le W + (S(t) - W) = S(t)$.
> - *`withdraw_max`.* It sets $a = A(t)$ and requires $a \ge 1$ `[C26]`, so $W' = S(t)$.
> - *`top_up(a)`.* $D' = D + a$ with $T$ unchanged, so $S'(t) \ge S(t) \ge W$ by Lemma 3.3(5).
> - *`cancel_stream`.* This makes $\varphi$ terminal, so the claim no longer needs to hold. §6 treats what it pays.
>
> $W$ is non-negative because it starts at $0$ and only ever gains positive amounts. $\blacksquare$

> **Remark 4.2 (top-up is retroactive).** Because $T$ is fixed and $S$ is linear in $D$, a top-up of $a$ at elapsed $e$ immediately makes about $a\,e/T$ more tokens available. The rate rises *and* the past is re-priced at the new rate, as if the whole deposit had been there from $t_0$. This is the documented pro-rata behaviour. It is a property of the model, not a bug, but integrators who expect top-ups to fund only the future window will be surprised.

---

## 5. Endowment and contract solvency

### 5.1 Endowment: each stream is fully funded up front

For a stream, define the **owed rate** $r = D/T$ (tokens per second, real-valued) and the **horizon** $T$. The endowment condition "deposit $\ge$ owed-rate $\times$ horizon" holds with **equality**, and is checkable at every instant:

> **Proposition 5.1 (exact endowment).** For admissible $s$:
> $$D \;=\; r \cdot T, \qquad S(t) \;\le\; r\cdot\varepsilon(t) \;\;\forall t, \qquad \textstyle\sup_t S(t) = S(t_1) = D.$$
> No stream ever owes more than it was funded with, and the full funding is owed by $t_1$.
>
> **Proof.** The first equation is the definition of $r$. The inequality is Lemma 3.3(4): $S = \lfloor D\varepsilon/T \rfloor \le D\varepsilon/T = r\varepsilon$. The supremum is Lemma 3.3(1) together with (2). Top-ups preserve all three with $r' = D'/T$. $\blacksquare$

Endowment is therefore structural: a StreamPay stream is never under-collateralised, because $D$ is escrowed at creation `[C27]` (and at each top-up `[C28]`) *before* any of it can accrue.

### 5.2 Contract-wide solvency

Fix a token $\tau$. Let $\mathcal{S}_\tau$ be the active streams in $\tau$, $\mathcal{I}_\tau$ the pending scheduled intents in $\tau$, and $\mathrm{coll}_\tau$ the treasury's collectible fees `[C29]`. Define the contract's **obligations** in $\tau$:

$$
O_\tau \;=\; \sum_{s \in \mathcal{S}_\tau} (D_s - W_s) \;+\; \mathrm{coll}_\tau \;+\; \sum_{i \in \mathcal{I}_\tau} \mathrm{esc}_i ,
$$

where $\mathrm{esc}_i = (D_i + \textit{fee\_budget}_i)\cdot\textit{occurrences\_remaining}_i$ is an intent's locked escrow `[C30]`.

> **Theorem 5.2 (solvency) — Argument sketch.** Under A1, A2 and A3 (§9: $\tau$ is a standard SEP-41 token, with no transfer fees, rebasing or third-party clawback of the contract's balance), at every committed state:
> $$\mathrm{balance}_\tau(\text{contract}) \;\ge\; O_\tau .$$
> Equality holds unless someone has transferred $\tau$ to the contract outside its entrypoints.
>
> **Sketch.** Check that every entrypoint changes $\mathrm{balance}_\tau$ and $O_\tau$ by the same amount.
>
> | Entrypoint | $\Delta\,\mathrm{balance}_\tau$ | $\Delta\,O_\tau$ | Cites |
> |---|---|---|---|
> | `create_stream(D)`, fee $f$ | $+(D + f)$ | $+D$ from the new stream, $+f$ to $\mathrm{coll}$ | `[C27]` `[C31]` |
> | `create_streams` | $+\sum (D_k + f_k)$, one pull per token | the same sum | `[C32]` |
> | `withdraw(a)`, `withdraw_max` | $-a$ | $-a$, since $W$ rises by $a$ | `[C25]` `[C33]` |
> | `top_up(a)` | $+a$ | $+a$, since $D$ rises by $a$ | `[C28]` `[C13]` |
> | `cancel_stream` | $-(r + s)$ | $-(D - W) = -(r+s)$ by Theorem 6.1(ii); the stream leaves $\mathcal{S}_\tau$ | `[C34]` |
> | `withdraw_treasury(a)` | $-a$ | $-a$ from $\mathrm{coll}$, which requires $a \le \mathrm{coll}$ | `[C35]` |
> | `schedule_stream` | $+\mathrm{esc}_i$ | $+\mathrm{esc}_i$ | `[C30]` `[C36]` |
> | `execute_scheduled` (one occurrence) | $-\textit{fee\_budget}$ to the keeper | $-(D + \textit{fee\_budget})$ from $\mathrm{esc}$, $+D$ from the new stream | `[C12]` |
>
> The intent's other exits (cancel and reclaim) refund the remaining escrow and remove it from $O_\tau$ in the same way. Each row nets to zero, and A1 means no partial row ever commits.
>
> This is a sketch, not a proof, for three reasons. The table is a manual enumeration of entrypoints. A3 is an assumption about the token, which the contract cannot verify. And the scheduled-intent rows are summarised rather than derived line by line. `fuzz/fuzz_targets/conservation.rs` tests the same equality mechanically (without intents) over random multi-token sequences.

The table also shows why an active stream's term is $D - W$ and not $S - W$. Unaccrued escrow still belongs to someone (the sender, on cancel), so it must stay in the vault.

---

## 6. Cancellation-refund correctness

`cancel_stream(caller, s)` at time $t$, with $e = \varepsilon(t)$, computes `[C37]`

$$
r = S(t) - W \quad(\text{to } \rho), \qquad s_{\text{ref}} = D - S(t) \quad(\text{to } \sigma),
$$

then sets $W \leftarrow W + r$ and $\varphi \leftarrow \textsf{Cancelled}$ *before* any transfer `[C34]`, and pushes $r$ and $s_{\text{ref}}$ only when they are positive `[C38]`.

> **Theorem 6.1 (cancel splits the escrow exactly).** For an active admissible stream:
> 1. *Non-negativity:* $r \ge 0$ and $s_{\text{ref}} \ge 0$.
> 2. *Exactness:* $r + s_{\text{ref}} = D - W$. The split is exactly the remaining escrow, with nothing created or lost.
> 3. *Recipient gets precisely what accrued:* after cancel, $W' = S(t)$. Over its life the recipient received $S(t)$, no more and no less.
> 4. *Sender pays precisely what accrued:* net of the refund, the sender funded $D - s_{\text{ref}} = S(t)$, plus any creation fee (§7), which is never refunded.
> 5. *Rounding favours the sender, by less than one unit:* $0 \le s_{\text{ref}} - \big(D - De/T\big) < 1$.
> 6. *Boundary cases:* cancel at or before $t_0$ gives $(r, s_{\text{ref}}) = (0, D - W) = (0, D)$; cancel at or after $t_1$ gives $(D - W,\ 0)$.
>
> **Proof.**
> - (1) By INV, $W \le S(t) \le D$, so both differences are non-negative. Their checked subtractions therefore cannot fail, and the `CancelSplitOverflow` branch is unreachable for active streams.
> - (2) $r + s_{\text{ref}} = (S - W) + (D - S) = D - W$.
> - (3) $W' = W + r = S(t)$.
> - (4) The sender put in $D$ (creation plus top-ups) and gets $s_{\text{ref}}$ back, so $D - s_{\text{ref}} = S(t)$.
> - (5) $s_{\text{ref}} = D - \lfloor De/T\rfloor$, so this is Lemma 3.3(4) rearranged.
> - (6) At $t \le t_0$, $e = 0$ so $S = 0$; and $W = 0$ by INV. At $t \ge t_1$, $S = D$ by Lemma 3.3(1). $\blacksquare$

> **Proposition 6.2 (authorisation) — Proof.** Cancel succeeds only if one of two cases holds `[C39]`:
> - $\textit{caller} = \sigma$; or
> - $\textit{caller} = \rho$ and $c = \text{true}$.
>
> Any other caller gets `NotAuthorized`, and a recipient of a non-cancelable stream gets `StreamNotCancellable`. Either way, $\textit{caller}$'s signature is required first. Withdrawals require $\rho$'s signature `[C40]`, and top-ups require $\sigma$'s `[C41]`. $\blacksquare$

> **Proposition 6.3 (atomic settlement) — Argument sketch.** The state change (Cancelled, $W' = S$) and the event are committed before either push `[C34]`. If a push fails, the entrypoint returns `RecipientPayoutFailed` or `SenderRefundFailed` `[C38]`, and by A1 the state change rolls back with it. So a cancel either moves both legs or moves nothing.
>
> It is a sketch because it rests entirely on A1. One consequence is worth stating: a recipient whose account refuses the token, for example a missing trustline on a classic asset, also blocks the *sender's* cancel. That is a liveness cost of all-or-nothing settlement, not a safety failure.

**Re-entrancy.** Effects precede every outbound push on the withdraw and cancel paths `[C33]` `[C34]`. A token contract that called back in would observe the post-state ($\textsf{Cancelled}$, or $W$ already raised), and the status guard `[C17]` rejects a second withdrawal or cancel. The creation and top-up paths pull *before* writing `[C27]` `[C28]`. That is safe for a different reason: there is no stream state yet to corrupt, or the $D$ in hand is the pre-pull value. A failed pull reverts everything by A1.

---

## 7. The fee layer

The protocol fee on a creation deposit $D$ at rate $b$ basis points is `[C42]`

$$
f(D, b) = \begin{cases} 0 & b = 0 \;\vee\; D \le 0\\ (D \cdot b) \div B & \text{otherwise,}\end{cases}
\qquad 0 \le b \le b_{\max} = 100 .
$$

The cap on $b$ is enforced on every update `[C43]`.

The sender pays $D + f$ in one pull. The stream records $D$ alone `[C31]`, and $f$ is added to the token's treasury `[C44]`.

> **Proposition 7.1 — Proof.**
> 1. *Fee is isolated from accrual:* no quantity in §3–§6 depends on $f$, because the stored deposit is $D$.
> 2. *Bounded:* $0 \le f \le D\,b_{\max}/B = D/100$, so the fee is at most 1% of the creation deposit.
> 3. *Zero below threshold:* $f = 0 \iff D\,b < B$, i.e. $D < 10^4/b$. With $b = 100$, any deposit under 100 base units pays nothing.
> 4. *Overflow:* the product is checked. With $D \le I$ and $b \le 100$, $D\,b$ exceeds $U$ only when $D > U/b$, which is about $3.4\times 10^{36}$ for $b = 100$. That is not reachable with any realistic supply, and fails safely as `MathOverflow` if it ever is.
>
> **Proof.** (1) by `[C31]`. (2) $f \le Db/B \le D\,b_{\max}/B$. (3) by the definition of floor. (4) by the checked multiplication in `[C42]`. $\blacksquare$

**Observation 7.2 (fee coverage gaps — design questions, not bugs).** The fee is defined by `fee_amount` `[C42]`, and its only call sites are `create_stream` `[C45]` and `create_streams` `[C55]`. A repository search finds no other caller; that negative claim is checked by search, not by the anchor audit. As a result:
- **Top-ups pay no fee** `[C28]`. A sender can create with a minimal deposit, possibly under the zero-fee threshold of 7.1(3), and top up to any size fee-free.
- **Scheduled streams pay no protocol fee.** `execute_scheduled` creates through an internal path that never calls `fee_amount` `[C12]`. Its `fee_budget` pays the keeper, not the treasury.
- **Splitting** a deposit into streams each below $10^4/b$ avoids the fee, at the cost of transaction and rent fees per stream.

At $b = 0$, the default and the only state any v0.3 deployment ran in, none of these matter. They should be decided before the fee is switched on.

---

## 8. Rent and economics

### 8.1 Storage rent: who keeps a stream alive, and for how long

Stream, index, treasury and per-stream-fee entries live in **persistent** storage. Every write of one of them is followed by `extend_ttl(200_000, 500_000)` (constants `[C46]`; stream `[C47]`, treasury `[C48]`), which extends the entry's TTL to 500,000 ledgers whenever it has fallen below 200,000.

> **Proposition 8.1 (a touched entry stays live) — Proof, given A4.** Let A4 be the host semantics of `extend_ttl(th, to)`: if the remaining TTL is below `th`, set it to `to`. Then immediately after any entrypoint writes a stream, that stream's remaining TTL is at least 200,000 ledgers, about 11.6 days at 5 s per ledger.
>
> **Proof.** Either the TTL was already at least 200,000 and is unchanged, or it was below and is now 500,000. $\blacksquare$

What does **not** extend a stream:
- The read-only views `get_stream` and `available` `[C49]`. A recipient who only *watches* a stream does not keep it alive.
- The `NextStreamId` counter, which is written without an extension `[C50]`.

Paging the address indexes *does* extend them `[C51]`.

**Consequences.**
- A stream whose parties do nothing for more than about 11.6 days (the worst case after its last write) to about 29 days (right after a fresh extension) is **archived**. That is not a loss of funds: archived persistent entries are restorable, at a fee paid by whoever restores. But the next `withdraw` or `cancel` must restore first.
- For a 100-year stream (§2.1 allows one) this is the normal case, not an edge case. The cost of keeping a long, idle stream live falls on whoever extends it. The protocol lets anyone extend any entry, and `infra/ttl-sentinel` can do so as a funded keeper.
- **Measured rent figures are cited, not re-derived:** `docs/ARCHITECTURE.md` §12 measures 504 B per stream entry and about 0.021 XLM per live stream per month at the floor fee, against the CAP-0066 fee curve.

**Observation 8.2 (index growth) — Argument sketch.** Each address index is one persistent `Vec<u64>`. Creation appends to it by reading the whole vector and writing it back `[C51]`, so the write cost and entry size grow linearly in the number of streams an address has ever had. Terminal streams are never removed. Anyone can create streams *to* any recipient, at the sender's expense. Once a recipient's index reaches the network's maximum contract-data entry size, `create_stream` to that recipient will fail.

This is a sketch: the exact limit depends on the network's ledger-entry size setting, and on the XDR size per element. Neither is verified here. It is an availability concern for recipients with very high stream counts. It does not affect existing streams, whose entries are separate.

### 8.2 Accrual economics

- **Granularity.** By Lemma 3.3(6), the stream pays $\lfloor D/T\rfloor$ or $\lceil D/T\rceil$ per second. When $D < T$, most seconds pay $0$, and one unit accrues every $T/D$ seconds or so. For example, $D = 100$ base units over one year accrues one unit roughly every 3.65 days. Senders who want smooth streaming should denominate in the token's smallest unit and keep $D \gg T$.
- **The rounding residual goes to the sender.** Theorem 6.1(5). The recipient's shortfall against continuous accrual is under one base unit at any instant, and exactly zero at $t_1$, by Lemma 3.3(1).
- **Withdrawal timing is the recipient's choice.** Accrual does not depend on how often one withdraws, because $S$ depends only on $t$. Each withdrawal costs a transaction fee, so a rational recipient withdraws when $A(t)$ exceeds that cost. Unwithdrawn accrual is safe, because it stays in the escrow counted by Theorem 5.2.
- **Sender's option to cancel.** $\sigma$ may stop a stream at any time and recover all unaccrued funds, by Theorem 6.1(4). A recipient's guarantee is therefore only "what has accrued so far", not "the whole deposit", unless the sender commits not to cancel off-chain. The `cancelable` flag gives the *recipient*, not the sender, a matching option.

---

## 9. Assumptions, and what is not proven

| ID | Assumption | Used by |
|---|---|---|
| **A1** | Entrypoints are atomic: an `Err` or trap reverts every write and every token transfer made in it (Soroban host semantics). | §1, Theorem 5.2, Propositions 6.3 and 8.2 |
| **A2** | Ledger timestamps are non-decreasing across committed transactions. | Theorem 4.1, and everything built on it |
| **A3** | The token is a standard SEP-41 asset: a transfer moves exactly the stated amount, and there is no rebasing, transfer fee or external clawback of the contract's balance. | Theorem 5.2 |
| **A4** | `extend_ttl(th, to)` sets TTL to `to` iff the current TTL is below `th`. | Proposition 8.1 |

**Not proven here.**
- **Auth soundness of `require_auth`.** That is host semantics.
- **Governance and upgrades.** Notably, a malicious upgrade could change any of the above. `docs/UPGRADES.md` covers the timelock.
- **Scheduled-intent internals** beyond their escrow row in Theorem 5.2.
- **The batch path's per-stream details.** Lemma 2.1 relies on `create_streams` running the same validation as `create_stream`, which `[C52]` shows. Its fee and pull aggregation is summarised rather than proved line by line.
- **Observation 8.2's numeric limit.**

**Checked mechanically, not proven.** `contracts/streaming-payments/src/differential_harness.rs` checks the contract against the pure reference model in `model/` step by step. `fuzz/fuzz_targets/conservation.rs` checks a conservation equality closely related to Theorem 5.2. These are evidence, not proof.

### 9.1 The event surface is a declared interface

Consumer-facing event shapes are not prose. Each event is declared once as a `#[contractevent]` struct, and `schemas/events/`, both generated TypeScript modules and `docs/EVENTS.md` are derived from that declaration. What is enforced, rather than merely documented:

- **Coverage is two-sided.** An event cannot be published before it is declared `[C56]`, and a declaration nothing emits is rejected too, so the registry cannot promise an event that never fires `[C57]`.
- **Layout is part of the identity.** A payload-enum's variant names and payload types fold into the event's canonical shape, so reordering a variant's payload moves its fingerprint `[C58]`; positional topics are schema-typed alongside the data fields `[C59]`, and every event is catalogued with that fingerprint `[C60]`.
- **Deletion is breaking.** Removing an event `[C61]`, a positional topic `[C62]` or a data field `[C64]`, or renaming a topic in place `[C63]`, fails the compatibility gate. Addition is allowed, but only with an event-changelog entry `[C65]`.
- **The indexer reads the registry, not a guess.** A governed event missing a declared field is a hard error `[C66]`; the indexed stream id comes only from a topic the registry declares as `stream_id`, so an event about fees, governance, the oracle or the index carries `stream_id: null` instead of a value lifted from its first positional topic `[C67]`, and writes no stream projection `[C69]`; traffic from another contract id is journalled without any stream claim `[C68]`.

None of this proves the *meaning* of an event is right — only that its shape cannot change silently underneath a consumer.

---

## Appendix A — claim-to-code traceability

Each row names a claim, the lines that implement it at the pinned commit, and an **anchor**: a snippet that must appear within those lines. `python3 scripts/check_whitepaper_claims.py` verifies for every row that:
- the file exists;
- the line range is inside the file;
- the anchor is present in the cited lines (whitespace-insensitive).

It also checks that every `[Cn]` cited in the text has a row, and that every row is cited. CI runs it on every pull request (`.github/workflows/whitepaper-claims.yml`). When code moves, fix the row, and re-read the claim while you are there.

<!-- claims:begin -->
| ID | Claim | Location | Anchor |
|---|---|---|---|
| C1 |   Maximum duration is 3,155,760,000 s   | `contracts/streaming-payments/src/stream.rs:40` | `MAX_DURATION_SECONDS: u64 = 3_155_760_000` |
| C2 |   Fee rate is capped at 100 bps   | `contracts/streaming-payments/src/treasury.rs:64` | `MAX_FEE_BPS: u32 = 100` |
| C3 |   Basis-point denominator is 10,000   | `contracts/streaming-payments/src/treasury.rs:56` | `BPS_DENOMINATOR: u32 = 10_000` |
| C4 |   Accrual arithmetic is checked and reports overflow rather than wrapping   | `contracts/streaming-payments/src/stream.rs:649` | `.checked_mul(elapsed as u128)` |
| C5 |   Stream layout: sender, recipient, token, deposit, withdrawn, window, cancelable, status   | `contracts/streaming-payments/src/stream.rs:349` | `pub withdrawn: i128,` |
| C6 |   Single creation runs `validate_stream_creation`   | `contracts/streaming-payments/src/lib.rs:449` | `Self::validate_stream_creation(now, deposit_amount, start_time, end_time)?;` |
| C7 |   Creation rejects non-positive deposit, empty window, over-long window, and over-capacity deposit   | `contracts/streaming-payments/src/lib.rs:516` | `stream::validate_capacity(deposit_amount, duration)` |
| C8 |   Capacity check: reject iff `deposit > u128::MAX / duration`   | `contracts/streaming-payments/src/stream.rs:629` | `let cap = u128::MAX / (duration.max(1) as u128);` |
| C9 |   Scheduling validates positive deposit, duration bound and capacity   | `contracts/streaming-payments/src/schedule.rs:284` | `stream::validate_capacity(deposit, duration)?;` |
| C10 |   Each occurrence shifts the window by `interval * index`   | `contracts/streaming-payments/src/schedule.rs:178` | `let shift = self.interval.saturating_mul(index as u64);` |
| C11 |   The last shifted window end is checked to fit in u64   | `contracts/streaming-payments/src/schedule.rs:319` | `.checked_add(last_shift)` |
| C12 |   Scheduled execution creates the stream internally (no protocol fee) and pays the keeper   | `contracts/streaming-payments/src/lib.rs:3000` | `let stream_id = Self::persist_new_stream(` |
| C13 |   Top-up is the only post-creation writer of `deposit`   | `contracts/streaming-payments/src/lib.rs:1445` | `s.deposit = new_deposit;` |
| C14 |   Top-up requires a positive amount   | `contracts/streaming-payments/src/lib.rs:1403` | `return Err(surface::reject(Branch::TopUpAmountNonPositive));` |
| C15 |   Top-up re-validates capacity for the new deposit   | `contracts/streaming-payments/src/lib.rs:1424` | `stream::validate_capacity(new_deposit, s.duration())?;` |
| C16 |   Migration re-stores each stream unchanged   | `contracts/streaming-payments/src/lib.rs:4124` | `stream::put_stream(&env, &s);` |
| C17 |   The withdrawal path requires Active status   | `contracts/streaming-payments/src/lib.rs:1069` | `if s.status != StreamStatus::Active {` |
| C18 |   A payout that makes withdrawn equal deposit marks the stream Depleted   | `contracts/streaming-payments/src/lib.rs:1093` | `s.status = StreamStatus::Depleted;` |
| C19 |   Elapsed time is the window-clamped `now - start_time`   | `contracts/streaming-payments/src/stream.rs:599` | `if now <= start_time {` |
| C20 |   Accrual: `min(deposit * elapsed / duration, deposit)`, zero on degenerate input   | `contracts/streaming-payments/src/stream.rs:651` | `let streamed = (product / (duration.max(1) as u128)).min(deposit as u128);` |
| C21 |   Streamed amount applies accrual to the stream's own deposit and duration   | `contracts/streaming-payments/src/stream.rs:659` | `streamed_at(stream.deposit, stream.duration(), elapsed)` |
| C22 |   Available is streamed minus withdrawn (zero once cancelled)   | `contracts/streaming-payments/src/stream.rs:718` | `.checked_sub(stream.withdrawn)` |
| C23 |   A new stream starts with withdrawn = 0   | `contracts/streaming-payments/src/lib.rs:568` | `withdrawn: 0,` |
| C24 |   Withdraw requires a positive amount not exceeding available   | `contracts/streaming-payments/src/lib.rs:999` | `if amount > available {` |
| C25 |   A payout raises withdrawn by the amount, persists, then pushes   | `contracts/streaming-payments/src/lib.rs:1090` | `.checked_add(amount)` |
| C26 |   Withdraw-max pays the whole available balance, refusing zero   | `contracts/streaming-payments/src/lib.rs:1049` | `let amount = stream::available_amount_with_plan(&env, &s, resolved.timestamp)?;` |
| C27 |   Creation pulls deposit + fee before persisting the stream   | `contracts/streaming-payments/src/lib.rs:463` | `let pull_amount = deposit_amount` |
| C28 |   Top-up pulls the added amount (no fee) before writing   | `contracts/streaming-payments/src/lib.rs:1441` | `Branch::TopUpTransferFailed,` |
| C29 |   Treasury collectible is charged minus withdrawn   | `contracts/streaming-payments/src/treasury.rs:100` | `.checked_sub(self.withdrawn_total)` |
| C30 |   An intent's locked escrow is (deposit + fee_budget) * remaining occurrences   | `contracts/streaming-payments/src/schedule.rs:197` | `per.checked_mul(self.occurrences_remaining as i128)` |
| C31 |   The stored stream deposit is the requested amount; the fee is applied separately   | `contracts/streaming-payments/src/lib.rs:580` | `treasury::apply_fee(env, &token, id, fee)?;` |
| C32 |   Batch creation sums deposit + fee per token and pulls once per token   | `contracts/streaming-payments/src/lib.rs:700` | `pull_totals.push_back((input.token, pull_amount));` |
| C33 |   Payout pushes to the recipient after state and event are committed   | `contracts/streaming-payments/src/lib.rs:1112` | `Branch::RecipientPayoutFailed,` |
| C34 |   Cancel finalises status and withdrawn before any transfer   | `contracts/streaming-payments/src/lib.rs:1287` | `s.status = StreamStatus::Cancelled;` |
| C35 |   Treasury withdrawal is bounded by collectible   | `contracts/streaming-payments/src/lib.rs:3397` | `if amount > t.collectible()? {` |
| C36 |   Scheduling pulls the whole escrow into the contract   | `contracts/streaming-payments/src/lib.rs:2908` | `&total_escrow,` |
| C37 |   Cancel split: recipient gets streamed - withdrawn, sender gets deposit - streamed   | `contracts/streaming-payments/src/stream.rs:733` | `let sender_amount = stream` |
| C38 |   Cancel pushes each leg only if positive, mapping failures to distinct codes   | `contracts/streaming-payments/src/lib.rs:1328` | `Branch::SenderRefundFailed,` |
| C39 |   Cancel authorisation: sender always; recipient only if cancelable   | `contracts/streaming-payments/src/lib.rs:1275` | `return Err(surface::reject(Branch::CancelStreamNotCancellable));` |
| C40 |   Withdrawals require the recipient's authorisation   | `contracts/streaming-payments/src/lib.rs:1068` | `s.recipient.require_auth();` |
| C41 |   Top-ups require the sender's authorisation   | `contracts/streaming-payments/src/lib.rs:1409` | `s.sender.require_auth();` |
| C42 |   Fee = floor(deposit * bps / 10,000), checked; zero at 0 bps or non-positive deposit   | `contracts/streaming-payments/src/treasury.rs:141` | `Ok((product / (BPS_DENOMINATOR as u128)) as i128)` |
| C43 |   Setting the fee rejects rates above the cap   | `contracts/streaming-payments/src/lib.rs:3261` | `if new_fee_bps > MAX_FEE_BPS {` |
| C44 |   Charged fees accumulate into the token's charged_total   | `contracts/streaming-payments/src/treasury.rs:226` | `treasury.charged_total = treasury` |
| C45 |   Single creation computes the fee   | `contracts/streaming-payments/src/lib.rs:462` | `let fee = treasury::fee_amount(deposit_amount, fee_bps)?;` |
| C46 |   TTL threshold 200,000 ledgers, extension 500,000 ledgers   | `contracts/streaming-payments/src/stream.rs:93` | `TTL_EXTEND_LEDGERS: u32 = 500_000;` |
| C47 |   Every stream write extends the stream entry's TTL   | `contracts/streaming-payments/src/stream.rs:906` | `.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);` |
| C48 |   Treasury writes extend the treasury entry's TTL   | `contracts/streaming-payments/src/treasury.rs:211` | `.extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);` |
| C49 |   The get_stream and available views read without extending TTL   | `contracts/streaming-payments/src/lib.rs:998` | `stream::available_amount_with_plan(&env, &s, resolved.timestamp)` |
| C50 |   The stream-id counter is written without a TTL extension   | `contracts/streaming-payments/src/stream.rs:873` | `env.storage().persistent().set(&key, &id.saturating_add(1));` |
| C51 |   Index append rewrites the whole vector and extends it; paging extends too   | `contracts/streaming-payments/src/stream.rs:1094` | `ids.push_back(id);` |
| C52 |   Batch creation runs `validate_stream_creation` for every input   | `contracts/streaming-payments/src/lib.rs:449` | `Self::validate_stream_creation(` |
| C53 |   Cancel requires Active status   | `contracts/streaming-payments/src/lib.rs:1267` | `return Err(surface::reject(Branch::StreamNotActive));` |
| C54 |   Top-up requires Active status   | `contracts/streaming-payments/src/lib.rs:1407` | `return Err(surface::reject(Branch::StreamNotActive));` |
| C55 |   Batch creation computes the fee per input   | `contracts/streaming-payments/src/lib.rs:673` | `let fee = treasury::fee_amount(input.deposit_amount, fee_bps)?;` |
| C56 |   An event with no declaration cannot be published, the registry scan fails the build   | `contracts/streaming-payments/src/event_registry.rs:1040` | `Some(name) if !declared.contains(name.as_str()) => problems.push(format!(` |
| C57 |   A declaration nothing emits is rejected too, so the registry cannot promise an event that never fires   | `contracts/streaming-payments/src/event_registry.rs:1066` | `declared events with no publish site: {never:?}` |
| C58 |   Payload-enum variant names and their payload types fold into the canonical shape, so variant order is wire-visible   | `contracts/streaming-payments/src/event_registry.rs:148` | `"{name}{{payload_enum:{}}}",` |
| C59 |   Each event publishes a JSON Schema for its positional topics, not only its data fields   | `contracts/streaming-payments/src/event_registry.rs:817` | `let mut topic_properties = Map::new();` |
| C60 |   The catalog indexes every event with its structural fingerprint   | `contracts/streaming-payments/src/event_registry.rs:863` | `"fingerprint": e.fingerprint(defs),` |
| C61 |   Deleting a published event is a breaking change and fails the compatibility gate   | `scripts/event_compat_check.mjs:68` | `REMOVED event ${name}` |
| C62 |   Deleting a positional topic is breaking   | `scripts/event_compat_check.mjs:83` | `REMOVED topic field ${name}.${t.name} (position ${i})` |
| C63 |   Renaming a topic at a position is breaking, because topics are positional   | `scripts/event_compat_check.mjs:86` | `topic at position ${i} changed name` |
| C64 |   Deleting a data field is breaking, because consumers decode it by name   | `scripts/event_compat_check.mjs:109` | `REMOVED data field ${name}.${field}: ${type}` |
| C65 |   An added field is allowed only when the event changelog records it   | `scripts/event_compat_check.mjs:98` | `MISSING CHANGELOG: added topic ${name}.${t.name} must be recorded in` |
| C66 |   The indexer refuses a governed event that omits a declared data field   | `indexer/src/decoder.ts:74` | `is missing registry data field(s):` |
| C67 |   The indexed stream id comes only from a topic the registry declares as stream_id   | `indexer/src/decoder.ts:69` | `if (field.name === "stream_id") streamId = String(positional[i]);` |
| C68 |   Events from another contract id are journalled without a stream claim   | `indexer/src/decoder.ts:80` | `if (!fromGovernedContract) {` |
| C69 |   An event with no stream id writes no stream projection   | `indexer/src/store.ts:223` | `if (event.streamId === null) {` |
<!-- claims:end -->
