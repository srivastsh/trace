import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ActivitySnapshot, Metric, Quota } from '../contracts';
import { Icon } from './icons';

const FRESH_WINDOW = 5 * 60 * 1000;
const amount = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const localDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const CONTEXT_ALERT = 'This reply’s reported input approached the reported context limit.';

const stateMessage = {
  waiting: 'Waiting for reply metadata',
  streaming: 'Reply in progress',
  reported: '',
  partial: 'Some activity details are unavailable',
  unavailable: 'Activity unavailable on this page',
};

function date(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? localDate.format(value) : 'Not reported';
}

export function contextAssessment(snapshot: ActivitySnapshot) {
  const input = snapshot.input?.value;
  const limit = snapshot.effectiveWindow?.value;
  if (snapshot.state !== 'reported' && snapshot.state !== 'partial') return { kind: 'unknown' } as const;
  if (input === undefined || !Number.isFinite(input) || input < 0 || limit === undefined || !Number.isFinite(limit)
    || limit <= 0) return { kind: 'unknown' } as const;
  if (input > limit && (snapshot.comparable || snapshot.comparableReason === 'Conflicting reported values')) {
    return { kind: 'conflict', input, limit } as const;
  }
  if (!snapshot.comparable) return { kind: 'unknown' } as const;
  return { kind: 'comparable', input, limit, percentage: 100 * input / limit } as const;
}

export function quotaDeadline(quota: Quota): number | undefined {
  return quota.deadline?.value ?? (quota.resetSeconds === undefined ? undefined : quota.observedAt + 1000 * quota.resetSeconds.value);
}

function Pair({ label, value }: { label: string; value?: string | number }) {
  return <div class="trace-pair"><dt>{label}</dt><dd>{value ?? 'Not reported'}</dd></div>;
}

function MetricSource({ label, metric }: { label: string; metric?: Metric<string | number> }) {
  if (!metric) return null;
  return <div class="trace-source">
    <dt>{label}</dt>
    <dd>{metric.sourceKind} · {metric.endpoint} · <code>{metric.sourceField}</code>
      <span>{metric.adapterVersion} · {date(metric.observedAt)}{metric.replyId ? ` · Reply ${metric.replyId}` : ''}</span>
    </dd>
  </div>;
}

function Limits({ quotas }: { quotas: Quota[] }) {
  const rows = useMemo(() => quotas.filter((quota) => quota.remaining !== undefined || quota.used !== undefined
    || quota.total !== undefined || quota.deadline !== undefined || quota.resetSeconds !== undefined)
    .map((quota) => ({ quota, deadline: quotaDeadline(quota) })), [quotas]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const current = Date.now();
    const boundaries = rows.flatMap(({ quota, deadline }) => [quota.observedAt + FRESH_WINDOW, deadline])
      .filter((time): time is number => time !== undefined && Number.isFinite(time) && time > current);
    if (!boundaries.length) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.min(...boundaries) - current + 10));
    return () => window.clearTimeout(timer);
  }, [rows, now]);
  if (!rows.length) return null;
  const clock = Math.max(now, Date.now());
  return <section aria-label="Limits" class="trace-activity-section">
    <h3>Limits</h3>
    {rows.map(({ quota, deadline }) => <details key={`${quota.scope}/${quota.feature}`} class="trace-disclosure">
      <summary>{quota.feature}{quota.remaining === undefined ? '' : ` · ${amount.format(quota.remaining.value)} remaining`}</summary>
      <dl>
        {quota.remaining && <Pair label="Remaining" value={amount.format(quota.remaining.value)}/>}
        {quota.used && <Pair label="Used" value={amount.format(quota.used.value)}/>}
        {quota.total && <Pair label="Reported limit" value={amount.format(quota.total.value)}/>}
        {deadline !== undefined && <Pair label={quota.deadline?.status === 'reported' ? 'Reported reset' : 'Estimated reset'}
          value={deadline <= clock ? 'Awaiting refreshed limit' : date(deadline)}/>}
        <Pair label={clock >= quota.observedAt + FRESH_WINDOW ? 'Last observed' : 'Observed'} value={date(quota.observedAt)}/>
        <MetricSource label="Source" metric={quota.remaining ?? quota.used ?? quota.total ?? quota.deadline ?? quota.resetSeconds}/>
      </dl>
    </details>)}
  </section>;
}

interface ActivityProps {
  snapshot: ActivitySnapshot;
  onClose: () => void;
  onAction?: (action: 'export' | 'handoff' | 'pause', event: MouseEvent) => void;
  pauseLabel?: string;
  warning?: boolean;
  onDismissWarning?: () => void;
  status?: string;
}

export function Activity({ snapshot, onClose, onAction, pauseLabel, warning, onDismissWarning, status }: ActivityProps) {
  const hasReply = snapshot.state === 'reported' || snapshot.state === 'partial';
  const input = hasReply ? snapshot.input : undefined;
  const output = hasReply ? snapshot.output : undefined;
  const model = hasReply ? snapshot.model : undefined;
  const context = contextAssessment(snapshot);
  const supportedQuotas = snapshot.quotas.some((quota) => quota.remaining || quota.used || quota.total || quota.deadline || quota.resetSeconds);
  return <>
    <div class="trace-surface-header">
      <h2>Activity</h2>
      <button class="trace-icon-button" data-trace-close type="button" aria-label="Close Activity" onClick={onClose}><Icon name="close"/></button>
    </div>
    {stateMessage[snapshot.state] && <p class="trace-secondary" role="status">{stateMessage[snapshot.state]}</p>}
    {snapshot.state !== 'unavailable' && <>
      <section class="trace-activity-section" aria-label="Latest reply">
        <h3>Latest reply</h3>
        <dl>
          <Pair label="Reported response model" value={model ? snapshot.displayModel?.value ?? model.value : undefined}/>
          {(input || output) && <>
            <Pair label="Input tokens" value={input && amount.format(input.value)}/>
            <Pair label="Output tokens" value={output && amount.format(output.value)}/>
          </>}
        </dl>
        {!input && !output && <p class="trace-secondary">Token counts unavailable</p>}
      </section>
      {(context.kind !== 'unknown' || snapshot.catalogMaximum || (hasReply && snapshot.effectiveWindow)) &&
        <section class="trace-activity-section" aria-label="Context">
          <h3>Context</h3>
          {context.kind === 'comparable' && <>
            <div class="trace-meter-label">
              <span>{amount.format(context.input)} / {amount.format(context.limit)} tokens</span>
              <span>{percent.format(context.percentage)}%</span>
            </div>
            <div role="meter" aria-label="Reported context use" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={context.percentage} class="trace-meter">
              <div style={{ width: `${context.percentage}%` }}/>
            </div>
          </>}
          {context.kind === 'conflict' && <>
            <div class="trace-secondary">Conflicting reported values</div>
            <dl><Pair label="Reported input" value={amount.format(context.input)}/>
              <Pair label="Reported context limit" value={amount.format(context.limit)}/></dl>
          </>}
          {context.kind === 'unknown' && hasReply && snapshot.effectiveWindow && <dl>
            <Pair label="Reported context limit" value={amount.format(snapshot.effectiveWindow.value)}/>
          </dl>}
          {snapshot.catalogMaximum && <dl>
            <Pair label="Model catalog maximum" value={amount.format(snapshot.catalogMaximum.value)}/>
          </dl>}
          {warning && <div class="trace-warning" role="status"><span>{CONTEXT_ALERT}</span>
            <button type="button" class="trace-icon-button" aria-label="Dismiss context alert" onClick={onDismissWarning}><Icon name="close"/></button>
          </div>}
        </section>}
      <Limits quotas={snapshot.quotas}/>
    </>}
    <details class="trace-disclosure trace-details">
      <summary>Details</summary>
      <dl>
        <Pair label="Adapter" value={snapshot.adapterVersion}/>
        <Pair label="Activity state" value={snapshot.state}/>
        {model && <Pair label="Raw model identifier" value={model.value}/>}
        {hasReply && snapshot.requestedModel && <Pair label="Requested model" value={snapshot.requestedModel.value}/>}
        {snapshot.conversationDefault && <Pair label="Conversation default" value={snapshot.conversationDefault.value}/>}
        {snapshot.accountDefault && <Pair label="Account default" value={snapshot.accountDefault.value}/>}
        {snapshot.observedAt !== undefined && <Pair label="Observed" value={date(snapshot.observedAt)}/>}
        {hasReply && snapshot.comparableReason && <Pair label="Context evidence" value={snapshot.comparableReason}/>}
        <MetricSource label="Response model source" metric={model}/>
        {hasReply && <MetricSource label="Display model source" metric={snapshot.displayModel}/>}
        {hasReply && <MetricSource label="Requested model source" metric={snapshot.requestedModel}/>}
        <MetricSource label="Conversation default source" metric={snapshot.conversationDefault}/>
        <MetricSource label="Account default source" metric={snapshot.accountDefault}/>
        <MetricSource label="Input token source" metric={input}/>
        <MetricSource label="Output token source" metric={output}/>
        {hasReply && <MetricSource label="Context limit source" metric={snapshot.effectiveWindow}/>}
        <MetricSource label="Catalog maximum source" metric={snapshot.catalogMaximum}/>
      </dl>
      {!supportedQuotas && <p class="trace-secondary">No reported limits available.</p>}
      {pauseLabel && onAction && <button type="button" class="trace-secondary-button" onClick={(event) => onAction('pause', event)}>{pauseLabel}</button>}
    </details>
    {status && <p class="trace-secondary" role="status">{status}</p>}
    {onAction && <div class="trace-activity-footer">
      <button type="button" class="trace-secondary-button" onClick={(event) => onAction('export', event)}><Icon name="export"/>Export</button>
      <button type="button" class="trace-secondary-button" onClick={(event) => onAction('handoff', event)}><Icon name="handoff"/>Prepare handoff</button>
    </div>}
  </>;
}
