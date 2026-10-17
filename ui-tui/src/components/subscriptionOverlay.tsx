import { randomUUID } from 'node:crypto'

import { Box, Text, useInput } from '@hermes/ink'
import { useEffect, useRef, useState } from 'react'

import type { SubscriptionOverlayState, SubscriptionPendingChange, SubscriptionResult } from '../app/interfaces.js'
import type { SubscriptionStateResponse, SubscriptionTierOption, SubscriptionUpgradeResponse } from '../gatewayTypes.js'
import { messages } from '../i18n/runtime.js'
import { useT } from '../i18n/useT.js'
import type { Theme } from '../theme.js'

import { ActionRow, footer, MenuRow, type MenuRowSpec, UsageBars, useMenu } from './overlayPrimitives.js'

const UPGRADE_CONFIRM_INTERVAL_MS = 2000
const UPGRADE_CONFIRM_ATTEMPTS = 15

interface SubscriptionOverlayProps {
  /** Close the overlay entirely. */
  onClose: () => void
  /** Merge a partial into the overlay state (screen transitions + pending/result). */
  onPatch: (next: Partial<SubscriptionOverlayState>) => void
  overlay: SubscriptionOverlayState
  t: Theme
}

/**
 * The /subscription modal — an in-terminal plan-change flow (V3). A small state
 * machine: overview → picker → confirm → result. Downgrades / cancellations /
 * resume are chargeless; an upgrade charges the card on the subscription, and an
 * SCA/decline is handed off to the portal. Starting a NEW subscription still
 * deep-links (needs a fresh card). All RPCs live in subscription.ts, reached via
 * `overlay.ctx`.
 */
export function SubscriptionOverlay({ onClose, onPatch, overlay, t }: SubscriptionOverlayProps) {
  const { screen, state: s } = overlay

  // Teams have no personal subscription — dead-end to /topup, no picker.
  if (s.context === 'team') {
    return (
      <Box borderColor={t.color.accent} borderStyle="round" flexDirection="column" paddingX={1}>
        <TeamContextScreen onClose={onClose} s={s} t={t} />
      </Box>
    )
  }

  return (
    <Box borderColor={t.color.accent} borderStyle="round" flexDirection="column" paddingX={1}>
      {screen === 'picker' && <PickerScreen onClose={onClose} onPatch={onPatch} overlay={overlay} t={t} />}
      {screen === 'confirm' && <ConfirmScreen onClose={onClose} onPatch={onPatch} overlay={overlay} t={t} />}
      {screen === 'result' && <ResultScreen onClose={onClose} overlay={overlay} t={t} />}
      {screen === 'overview' && <OverviewScreen onClose={onClose} onPatch={onPatch} overlay={overlay} t={t} />}
    </Box>
  )
}

// ── Shared helpers ───────────────────────────────────────────────────

interface ScreenProps {
  onClose: () => void
  onPatch: (next: Partial<SubscriptionOverlayState>) => void
  overlay: SubscriptionOverlayState
  t: Theme
}

/** ISO datetime → YYYY-MM-DD for display, or a soft fallback. */
function shortDate(iso?: null | string): string {
  return iso && iso.length >= 10 ? iso.slice(0, 10) : messages().subscription.shared.periodEndFallback
}

/** Integer cents → "$X.YY", or null when no amount is quoted. */
function centsDisplay(cents?: null | number): null | string {
  return typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : null
}

/** Map a failed RPC envelope to a result. */
function errorResult(r: { error?: string; message?: string; portal_url?: null | string } | null): SubscriptionResult {
  return {
    message: r?.message || r?.error || messages().subscription.result.genericError,
    ok: false,
    recoveryUrl: r?.portal_url ?? null
  }
}

/** Map a chargeless pending-change mutation (schedule / cancel / resume). */
function mutationResult(r: null | { message?: string; ok?: boolean }, okMessage: string): SubscriptionResult {
  return r?.ok ? { message: r.message || okMessage, ok: true } : errorResult(r)
}

/** Map an upgrade response, routing SCA / decline to a portal recovery. */
function upgradeResult(r: null | SubscriptionUpgradeResponse, pendingTierId?: null | string): SubscriptionResult {
  const T = messages().subscription

  if (!r) {
    // null = a transport failure (WS drop / request timeout) on the CHARGING
    // route — NAS may have already prorated + charged. Report it as ambiguous and
    // steer to a safe re-check, never a blind retry (which #2's dedup can't cover
    // once the key is lost).
    return {
      message: T.result.upgradeUnconfirmed,
      ok: false
    }
  }

  if (r.reason === 'authentication_required' || r.reason === 'subscription_payment_intent_requires_action') {
    return {
      message: T.result.verifyCard,
      ok: false,
      recoveryUrl: r.recovery_url ?? null
    }
  }

  if (r.reason === 'card_declined') {
    return {
      message: T.result.cardDeclinedTryDifferent,
      ok: false,
      recoveryUrl: r.recovery_url ?? null
    }
  }

  if (r.ok && r.status === 'already_on_tier') {
    return {
      message: T.result.alreadyOn(r.target_tier_name ?? T.shared.thisPlan),
      ok: true
    }
  }

  if (r.ok && r.status === 'upgraded') {
    return {
      message: T.result.upgraded(r.target_tier_name ?? T.shared.yourNewPlan),
      ok: true,
      pendingTierId: pendingTierId ?? null
    }
  }

  if (r.status === 'requires_action') {
    return {
      message: T.result.requiresAction,
      ok: false,
      recoveryUrl: r.recovery_url ?? null
    }
  }

  if (r.status === 'payment_failed') {
    return {
      message: T.result.paymentFailed,
      ok: false,
      recoveryUrl: r.recovery_url ?? null
    }
  }

  return errorResult(r)
}

/** Preview a tier and route: confirm (ok) or result (error). */
function previewAndRoute(
  ctx: SubscriptionOverlayState['ctx'],
  tierId: string,
  onPatch: ScreenProps['onPatch']
): Promise<void> {
  return ctx.preview(tierId).then(p => {
    if (!p) {
      return onPatch({
        result: { message: messages().subscription.result.couldNotPreview, ok: false },
        screen: 'result'
      })
    }

    if (!p.ok) {
      return onPatch({ result: errorResult(p), screen: 'result' })
    }

    // charge_now ⇒ an upgrade (charges now); everything else schedules at period
    // end. blocked/no_op still go to confirm, which shows why + no apply.
    const kind = p.effect === 'charge_now' ? 'upgrade' : 'tier_change'

    // Mint the upgrade idempotency key HERE so it rides `pending` into confirm —
    // a re-submit dedups server-side (mirrors billingOverlay's
    // pendingCharge.idempotencyKey).
    const pending: SubscriptionPendingChange =
      kind === 'upgrade'
        ? { idempotencyKey: randomUUID(), kind, preview: p, targetTierId: tierId }
        : { kind, preview: p, targetTierId: tierId }

    onPatch({ pending, screen: 'confirm' })
  })
}

/** Apply the confirmed pending change and route to the result screen. */
function applyPendingAndRoute(
  ctx: SubscriptionOverlayState['ctx'],
  pending: null | SubscriptionPendingChange,
  onPatch: ScreenProps['onPatch']
): Promise<void> {
  if (!pending) {
    // Nothing to apply (defensive) — return to the overview rather than stranding.
    onPatch({ screen: 'overview' })

    return Promise.resolve()
  }

  const finish = (result: SubscriptionResult) => onPatch({ result, screen: 'result' })

  if (pending.kind === 'cancellation') {
    return ctx.scheduleCancellation().then(r => finish(mutationResult(r, messages().subscription.result.cancellationScheduled)))
  }

  if (pending.kind === 'upgrade') {
    return ctx.upgrade(pending.targetTierId ?? '', pending.idempotencyKey).then(r => finish(upgradeResult(r, pending.targetTierId)))
  }

  return ctx
    .scheduleChange(pending.targetTierId ?? '')
    .then(r => finish(mutationResult(r, messages().subscription.result.changeScheduled)))
}

/** Resume (undo the pending change) and route to the result screen. */
function resumeAndRoute(ctx: SubscriptionOverlayState['ctx'], onPatch: ScreenProps['onPatch']): Promise<void> {
  return ctx.resume().then(r =>
    onPatch({
      result: mutationResult(r, messages().subscription.result.resumed),
      screen: 'result'
    })
  )
}

// ── The pending scheduled change (drives the banner + status echo) ──

interface PendingTransition {
  to: string
  when: string
}

/** The scheduled downgrade/cancel as a from→to transition, or null. */
function pendingTransition(c: SubscriptionStateResponse['current']): null | PendingTransition {
  if (!c) {
    return null
  }

  if (c.cancel_at_period_end) {
    return {
      to: messages().subscription.status.cancels,
      when: c.cancellation_effective_display ?? shortDate(c.cancellation_effective_at)
    }
  }

  if (c.pending_downgrade_tier_name) {
    return { to: c.pending_downgrade_tier_name, when: c.pending_downgrade_display ?? shortDate(c.pending_downgrade_at) }
  }

  return null
}

// ── Screen: Overview (plan + usage + entry to the change flow) ────────

/** Status line — dollars-only, and echoes a pending "Ultra → Plus" transition. */
function statusLine(s: SubscriptionStateResponse): string {
  const T = messages().subscription.status
  const u = s.usage
  const c = s.current
  const plan = c?.tier_name ?? u?.plan_name ?? null
  const trans = pendingTransition(c)
  const flip = plan && trans ? T.transition(trans.to) : ''
  const renewsRaw = u?.renews_display ?? null
  const renews = renewsRaw ? T.renews(renewsRaw) : ''
  const viewOnly = !s.can_change_plan

  if (!plan) {
    return T.freePlan
  }

  if (u?.status === 'low' && u.total_spendable_display) {
    return `${T.plan(plan)}${flip}${T.left(u.total_spendable_display)}`
  }

  const left = u?.total_spendable_display ? T.left(u.total_spendable_display) : ''

  return `${T.plan(plan)}${flip}${left}${viewOnly ? T.viewOnly : renews}`
}

function OverviewScreen({ onClose, onPatch, overlay, t }: ScreenProps) {
  const T = useT().subscription
  const { ctx, state: s } = overlay
  const c = s.current
  const isFree = !c?.tier_id
  const currentName = c?.tier_name ?? T.shared.yourPlan
  const trans = pendingTransition(c)
  const hasPendingChange = !!trans
  // Admin/owner on a personal paid plan can change it in-terminal; otherwise the
  // portal enforces who can act (members) / starting a new sub needs a card.
  const canChange = s.can_change_plan && !isFree

  // On Free the catalog renders inline; picking a plan hands off to the portal,
  // where starting a subscription needs card capture + checkout.
  const freePlans = isFree
    ? s.tiers.filter(tier => tier.is_enabled && tier.tier_order > 0).sort((a, b) => a.tier_order - b.tier_order)
    : []

  // Guard the async resume so a double-press cannot fire two DELETEs mid-await.
  const busyRef = useRef(false)

  const u = s.usage
  const freeNudge = isFree ? T.overview.freeNudge : null

  const lowNudge =
    u?.status === 'low' ? T.overview.lowNudge(u.total_spendable_display ?? T.overview.lowNudgeAmountFallback) : null

  const doManage = () => {
    if (s.portal_url) {
      void ctx.openManageLink()
    } else {
      ctx.sys(T.overview.noPortalUrl)
    }

    return onClose()
  }

  const doResume = () => {
    if (busyRef.current) {
      return
    }

    busyRef.current = true
    void resumeAndRoute(ctx, onPatch)
  }

  const rows: MenuRowSpec[] = []

  if (canChange) {
    // When a change is already scheduled, undo is the most likely next intent —
    // promote it to the first, highlighted action.
    if (hasPendingChange) {
      rows.push({ color: t.color.ok, label: T.overview.keepPlanUndo(currentName), run: doResume })
      rows.push({ label: T.overview.changePlan, run: () => onPatch({ pending: null, screen: 'picker' }) })
    } else {
      rows.push({ label: T.overview.changePlan, run: () => onPatch({ pending: null, screen: 'picker' }) })
      rows.push({
        label: T.overview.cancelSubscription,
        run: () => onPatch({ pending: { kind: 'cancellation', preview: null, targetTierId: null }, screen: 'confirm' })
      })
    }
  }

  for (const tier of freePlans) {
    // NAS sends a bare decimal string; tolerate pre-grouped ("1,000") too.
    const credits = Number((tier.monthly_credits ?? '').replace(/,/g, ''))

    const suffix =
      Number.isFinite(credits) && credits > 0 ? T.overview.creditsPerMonth(credits.toLocaleString('en-US')) : ''

    rows.push({
      label: `${T.overview.tierRow(tier.name, tier.dollars_per_month_display)}${suffix}`,
      run: () => {
        if (busyRef.current) {
          return
        }

        busyRef.current = true
        void ctx.openManageLink(tier.tier_id)
        onClose()
      }
    })
  }

  // The inline plan rows are the subscribe path; only a catalog-less free state
  // still needs the generic portal row.
  if (!isFree || freePlans.length === 0) {
    rows.push({ label: isFree ? T.overview.startSubscription : T.shared.manageOnPortal, run: doManage })
  }

  rows.push({ label: T.shared.close, run: onClose })

  const sel = useMenu(rows, onClose)

  return (
    <Box flexDirection="column">
      {/* Lead with the scheduled change so it can't read as "nothing happened". */}
      {trans && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={t.color.warn}>
            {T.overview.scheduledChange}
          </Text>
          <Box>
            <Text color={t.color.text}>{currentName} </Text>
            <Text color={t.color.warn}>──▶ </Text>
            <Text color={t.color.text}>{trans.to}</Text>
            <Text color={t.color.muted}> · {trans.when}</Text>
          </Box>
          <Text color={t.color.muted}>{T.overview.keepUntilThen(currentName)}</Text>
        </Box>
      )}

      <Text bold color={t.color.accent}>
        {statusLine(s)}
      </Text>
      <UsageBars model={s.usage} t={t} />
      {freeNudge && (
        <Box marginTop={1}>
          <Text color={t.color.warn}>
            {'> '}
            {freeNudge}
          </Text>
        </Box>
      )}
      {lowNudge && (
        <Box marginTop={1}>
          <Text color={t.color.warn}>
            {'! '}
            {lowNudge}
          </Text>
        </Box>
      )}
      {s.org_name && (
        <Text color={t.color.muted}>
          {T.overview.org(s.org_name)}
          {s.role ? ` · ${s.role}` : ''}
        </Text>
      )}

      <Text />
      {rows.map((row, i) => (
        <MenuRow active={sel === i} index={i + 1} key={row.label} label={row.label} t={t} />
      ))}

      <Text />
      {footer(T.overview.hint, t)}
    </Box>
  )
}

// ── Screen: Picker (choose a tier → preview → confirm) ───────────────

function PickerScreen({ onPatch, overlay, t }: ScreenProps) {
  const T = useT().subscription
  const { ctx, state: s } = overlay
  const currentOrder = s.tiers.find(tier => tier.is_current)?.tier_order ?? 0

  // Selectable = enabled, not the current plan, and not the free/no-sub tier
  // (going to free is a cancellation, offered on the overview). Sorted by price.
  const choices: SubscriptionTierOption[] = s.tiers
    .filter(tier => tier.is_enabled && !tier.is_current && tier.tier_order > 0)
    .sort((a, b) => a.tier_order - b.tier_order)

  // Guard the async preview so a double-press cannot fire two quotes.
  const busyRef = useRef(false)

  const pick = (tier: SubscriptionTierOption) => {
    if (busyRef.current) {
      return
    }

    busyRef.current = true
    void previewAndRoute(ctx, tier.tier_id, onPatch)
  }

  const back = () => onPatch({ screen: 'overview' })

  const rows: MenuRowSpec[] = choices.map(tier => {
    const direction = tier.tier_order > currentOrder ? T.picker.upgrade : T.picker.downgrade

    return {
      label: T.picker.tierRow(tier.name, tier.dollars_per_month_display, direction),
      run: () => pick(tier)
    }
  })

  rows.push({ label: T.shared.back, run: back })

  const sel = useMenu(rows, back)

  return (
    <Box flexDirection="column">
      <Text bold color={t.color.accent}>
        {T.picker.title}
      </Text>
      <Text color={t.color.muted}>{T.picker.current(s.current?.tier_name ?? T.shared.freePlan)}</Text>
      <Text />
      {choices.length === 0 && <Text color={t.color.muted}>{T.picker.noOtherPlans}</Text>}
      {rows.map((row, i) => (
        <MenuRow active={sel === i} index={i + 1} key={row.label} label={row.label} t={t} />
      ))}
      <Text />
      {footer(T.picker.hint, t)}
    </Box>
  )
}

// ── Screen: Confirm (show the previewed effect, then apply) ──────────

function ConfirmScreen({ onClose, onPatch, overlay, t }: ScreenProps) {
  const T = useT().subscription
  const { ctx, state: s } = overlay
  const pending: null | SubscriptionPendingChange = overlay.pending ?? null
  const preview = pending?.preview ?? null
  const isCancellation = pending?.kind === 'cancellation'
  // Cancellation is always a scheduled (chargeless) effect; otherwise trust the
  // quote (default to blocked so a missing quote never offers an apply).
  const effect = isCancellation ? 'scheduled' : (preview?.effect ?? 'blocked')

  const [submitting, setSubmitting] = useState(false)
  // Synchronous guard: two key events can both see submitting===false before
  // React commits, double-firing the mutation/charge.
  const submittingRef = useRef(false)

  const back = () => {
    // Don't navigate away while an apply is in flight: the screen hasn't changed
    // yet (applyPendingAndRoute patches only after the RPC resolves), so a fresh
    // re-mount would re-fire the mutation — a second charge on the upgrade path.
    if (submittingRef.current) {
      return
    }

    onPatch({ pending: null, screen: isCancellation ? 'overview' : 'picker' })
  }

  const apply = () => {
    if (submittingRef.current || !pending) {
      return
    }

    submittingRef.current = true
    setSubmitting(true)
    void applyPendingAndRoute(ctx, pending, onPatch)
  }

  const manage = () => {
    void ctx.openManageLink()

    return onClose()
  }

  // WHICH card the upgrade will charge (brand + last4) — best-effort via
  // billing.state, shown only when the resolver rung matches what a
  // subscription charge actually uses (subPin / customerDefault, mirroring
  // Stripe's own precedence). Anything else → the generic line stands.
  const [chargeCard, setChargeCard] = useState<null | string>(null)

  useEffect(() => {
    if (isCancellation || effect !== 'charge_now') {
      return
    }

    let cancelled = false

    void ctx.fetchCard().then(card => {
      if (!cancelled && card && (card.resolved_via === 'subPin' || card.resolved_via === 'customerDefault')) {
        setChargeCard(card.masked)
      }
    })

    return () => {
      cancelled = true
    }
  }, [ctx, effect, isCancellation])

  const amount = centsDisplay(preview?.amount_due_now_cents)
  const targetName = isCancellation ? '' : (preview?.target_tier_name ?? T.shared.theSelectedPlan)

  let primary: MenuRowSpec | null = null

  if (isCancellation) {
    primary = { color: t.color.warn, label: T.overview.cancelSubscription, run: apply }
  } else if (effect === 'charge_now') {
    primary = {
      color: t.color.ok,
      label: amount ? T.confirm.payAndUpgrade(amount) : T.confirm.upgradeNowProrated,
      run: apply
    }
  } else if (effect === 'scheduled') {
    primary = { color: t.color.ok, label: T.confirm.scheduleChangeTo(targetName), run: apply }
  } else if (effect === 'blocked') {
    primary = { label: T.shared.manageOnPortal, run: manage }
  }

  const backRow: MenuRowSpec = { label: T.shared.back, run: back }
  const rows: MenuRowSpec[] = primary ? [primary, backRow] : [backRow]
  const sel = useMenu(rows, back)

  // Chip contrasts an immediate charge vs a period-end schedule at a glance.
  const chip =
    effect === 'charge_now'
      ? { color: t.color.ok, label: T.confirm.chipChargedNow }
      : effect === 'scheduled'
        ? { color: t.color.warn, label: T.confirm.chipScheduled }
        : null

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={t.color.accent}>
          {isCancellation ? T.confirm.titleCancellation : T.confirm.titleChange}
        </Text>
        {chip && <Text color={chip.color}> · {chip.label}</Text>}
      </Box>
      {submitting && <Text color={t.color.muted}>{T.confirm.working}</Text>}

      {isCancellation && (
        <>
          <Text color={t.color.text}>
            {T.confirm.cancelBody(s.current?.tier_name ?? T.shared.yourPlan, shortDate(s.current?.cycle_ends_at))}
          </Text>
          <Text color={t.color.muted}>{T.confirm.cancelKeepCredits}</Text>
        </>
      )}

      {effect === 'charge_now' && !isCancellation && (
        <>
          <Text color={t.color.text}>
            {T.confirm.upgradeTo(targetName)} {amount ? T.confirm.chargedNow(amount) : T.confirm.chargedProrated}
          </Text>
          {preview?.monthly_credits_delta && (
            <Text color={t.color.muted}>{T.confirm.creditsDelta(preview.monthly_credits_delta)}</Text>
          )}
          <Text color={t.color.muted}>
            {chargeCard ? T.confirm.cardCharged(chargeCard) : T.confirm.cardChargedGeneric}
          </Text>
        </>
      )}

      {effect === 'scheduled' && !isCancellation && (
        <>
          <Text color={t.color.text}>{T.confirm.scheduledBody(targetName, shortDate(preview?.effective_at))}</Text>
          {preview?.monthly_credits_delta && (
            <Text color={t.color.muted}>{T.confirm.creditsDelta(preview.monthly_credits_delta)}</Text>
          )}
        </>
      )}

      {effect === 'no_op' && !isCancellation && <Text color={t.color.muted}>{T.confirm.noOp(targetName)}</Text>}

      {effect === 'blocked' && !isCancellation && (
        <Text color={t.color.warn}>{preview?.reason ?? T.confirm.blockedFallback}</Text>
      )}

      <Text />
      {rows.map((row, i) => (
        <ActionRow active={sel === i} color={row.color} key={row.label} label={row.label} t={t} />
      ))}
      <Text />
      {footer(T.confirm.hint, t)}
    </Box>
  )
}

// ── Screen: Result (outcome + optional portal recovery) ──────────────

function ResultScreen({ onClose, overlay, t }: Omit<ScreenProps, 'onPatch'>) {
  const T = useT().subscription
  const { ctx } = overlay
  const result = overlay.result ?? null
  const recoveryUrl = result?.recoveryUrl ?? null
  const pendingTierId = result?.pendingTierId ?? null

  const [applyState, setApplyState] = useState<'applying' | 'confirmed' | 'timed_out'>(
    pendingTierId ? 'applying' : 'confirmed'
  )

  useEffect(() => {
    if (!pendingTierId) {
      return
    }

    let attempts = 0
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const scheduleOrFinish = () => {
      if (cancelled) {
        return
      }

      if (attempts >= UPGRADE_CONFIRM_ATTEMPTS) {
        setApplyState('timed_out')

        return
      }

      timer = setTimeout(tick, UPGRADE_CONFIRM_INTERVAL_MS)
    }

    const tick = () => {
      attempts += 1
      void ctx
        .refreshState()
        .then(fresh => {
          if (cancelled) {
            return
          }

          if (fresh?.current?.tier_id === pendingTierId) {
            setApplyState('confirmed')

            return
          }

          scheduleOrFinish()
        })
        .catch(scheduleOrFinish)
    }

    timer = setTimeout(tick, UPGRADE_CONFIRM_INTERVAL_MS)

    return () => {
      cancelled = true

      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [ctx, pendingTierId])

  const applying = result?.ok && applyState === 'applying'
  const timedOut = result?.ok && applyState === 'timed_out'

  const message = timedOut ? T.resultScreen.stillApplying : (result?.message ?? '')

  const openRecovery = () => {
    if (recoveryUrl) {
      ctx.openPortal(recoveryUrl)
    }

    return onClose()
  }

  const rows: MenuRowSpec[] = recoveryUrl
    ? [
        { color: t.color.accent, label: T.resultScreen.openPortalToFinish, run: openRecovery },
        { label: T.shared.close, run: onClose }
      ]
    : [{ label: T.shared.close, run: onClose }]

  const sel = useMenu(rows, onClose)

  return (
    <Box flexDirection="column">
      <Text bold color={result?.ok ? t.color.ok : t.color.warn}>
        {applying
          ? T.resultScreen.titleApplying
          : timedOut
            ? T.resultScreen.titleStillApplying
            : result?.ok
              ? T.resultScreen.titleDone
              : T.resultScreen.titleFailed}
      </Text>
      <Text color={t.color.text}>{message}</Text>
      {result?.ok && !applying && !timedOut && <Text color={t.color.muted}>{T.resultScreen.rerunHint}</Text>}
      <Text />
      {rows.map((row, i) => (
        <ActionRow active={sel === i} color={row.color} key={row.label} label={row.label} t={t} />
      ))}
      <Text />
      {footer(T.resultScreen.hint, t)}
    </Box>
  )
}

// ── Screen: Team context (no tier picker — teams use shared credits) ──

interface TeamContextScreenProps {
  onClose: () => void
  s: SubscriptionStateResponse
  t: Theme
}

function TeamContextScreen({ onClose, s, t }: TeamContextScreenProps) {
  const T = useT().subscription
  useInput((_ch, key) => {
    if (key.escape || key.return) {
      return onClose()
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold color={t.color.accent}>
        {T.team.title}
      </Text>
      {s.org_name && (
        <Text color={t.color.muted}>
          {T.overview.org(s.org_name)}
          {s.role ? ` · ${s.role}` : ''}
        </Text>
      )}
      <Text />
      <Text color={t.color.text}>{T.team.body(s.org_name ?? T.team.orgFallback)}</Text>
      <Text color={t.color.muted}>{T.team.personalNote}</Text>

      <Text />
      {footer(T.team.hint, t)}
    </Box>
  )
}
