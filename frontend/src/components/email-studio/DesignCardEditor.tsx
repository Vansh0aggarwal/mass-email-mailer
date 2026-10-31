import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  Gauge,
  Lightbulb,
  Minus,
  MousePointerClick,
  Plus,
  Trash2,
} from 'lucide-react';
import type {
  EmailBullet,
  EmailCard,
  EmailContentCard,
  EmailCtaCard,
  EmailInsightCard,
  EmailMetric,
  EmailMetricsCard,
} from '../../lib/email-studio';

interface DesignCardEditorProps {
  card: EmailCard;
  index: number;
  total: number;
  onChange: (card: EmailCard) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}

const CARD_META: Record<EmailCard['type'], { label: string; icon: typeof AlignLeft }> = {
  content: { label: 'Content', icon: AlignLeft },
  metrics: { label: 'Technical metrics', icon: Gauge },
  insight: { label: 'Insight', icon: Lightbulb },
  cta: { label: 'Call to action', icon: MousePointerClick },
  divider: { label: 'Divider', icon: Minus },
};

function Label({ text, hint }: { text: string; hint?: string }) {
  return (
    <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-muted">
      {text}
      {hint ? <span className="ml-1 font-normal normal-case text-ink-subtle">— {hint}</span> : null}
    </span>
  );
}

const inputClass = 'input px-3 py-2 text-sm';

export function DesignCardEditor({
  card,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: DesignCardEditorProps) {
  const meta = CARD_META[card.type];
  const Icon = meta.icon;

  return (
    <section className="ios-card overflow-hidden">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[rgb(var(--surface-2))] text-ink-muted">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Card {index + 1} · {meta.label}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="btn-ghost p-1.5"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label="Move card up"
            title="Move up"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="btn-ghost p-1.5"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label="Move card down"
            title="Move down"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="btn-ghost p-1.5 text-[rgb(var(--danger))] hover:text-[rgb(var(--danger))]"
            onClick={onRemove}
            aria-label="Remove card"
            title="Remove card"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="space-y-3 p-4">
        {card.type === 'content' && (
          <ContentFields card={card} onChange={onChange} />
        )}
        {card.type === 'metrics' && (
          <MetricsFields card={card} onChange={onChange} />
        )}
        {card.type === 'insight' && (
          <InsightFields card={card} onChange={onChange} />
        )}
        {card.type === 'cta' && <CtaFields card={card} onChange={onChange} />}
        {card.type === 'divider' && (
          <p className="text-xs text-ink-subtle">
            A hairline divider between sections. No settings required.
          </p>
        )}
      </div>
    </section>
  );
}

function ContentFields({
  card,
  onChange,
}: {
  card: EmailContentCard;
  onChange: (card: EmailCard) => void;
}) {
  const update = (patch: Partial<EmailContentCard>) => onChange({ ...card, ...patch });

  const setParagraph = (idx: number, value: string) => {
    const paragraphs = card.paragraphs.map((p, i) => (i === idx ? value : p));
    update({ paragraphs });
  };

  const addParagraph = () => update({ paragraphs: [...card.paragraphs, ''] });

  const removeParagraph = (idx: number) => {
    if (card.paragraphs.length <= 1) return;
    update({ paragraphs: card.paragraphs.filter((_, i) => i !== idx) });
  };

  const setBullet = (idx: number, patch: Partial<EmailBullet>) => {
    const bullets = (card.bullets || []).map((b, i) => (i === idx ? { ...b, ...patch } : b));
    update({ bullets });
  };

  const addBullet = () => update({ bullets: [...(card.bullets || []), { title: '', text: '' }] });

  const removeBullet = (idx: number) => {
    const bullets = (card.bullets || []).filter((_, i) => i !== idx);
    update({ bullets: bullets.length ? bullets : undefined });
  };

  return (
    <>
      <label className="block">
        <Label text="Greeting" hint="optional" />
        <input
          className={inputClass}
          value={card.greeting || ''}
          onChange={(e) => update({ greeting: e.target.value })}
          placeholder="Hi {{recipient_name}},"
        />
      </label>

      <label className="block">
        <Label text="Card title" hint="optional" />
        <input
          className={inputClass}
          value={card.title || ''}
          onChange={(e) => update({ title: e.target.value })}
        />
      </label>

      <div className="space-y-2">
        <Label text="Paragraphs" />
        {card.paragraphs.map((paragraph, idx) => (
          <div key={idx} className="flex items-start gap-2">
            <textarea
              className={`${inputClass} min-h-[76px] resize-y`}
              value={paragraph}
              onChange={(e) => setParagraph(idx, e.target.value)}
              placeholder="Write the next paragraph. Support {{company_name}} and {{recipient_name}}."
            />
            <button
              type="button"
              className="btn-ghost mt-1 p-1.5 text-[rgb(var(--danger))] hover:text-[rgb(var(--danger))]"
              onClick={() => removeParagraph(idx)}
              disabled={card.paragraphs.length <= 1}
              aria-label="Remove paragraph"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button type="button" className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs" onClick={addParagraph}>
          <Plus className="h-3.5 w-3.5" /> Add paragraph
        </button>
      </div>

      <div className="space-y-2">
        <Label text="Bullets" hint="optional, max 8" />
        {(card.bullets || []).map((bullet, idx) => (
          <div key={idx} className="rounded-lg border border-line bg-[rgb(var(--surface-2))] p-2">
            <div className="flex items-center gap-2">
              <input
                className={`${inputClass} flex-1`}
                value={bullet.title || ''}
                onChange={(e) => setBullet(idx, { title: e.target.value })}
                placeholder="Short label"
              />
              <button
                type="button"
                className="btn-ghost p-1.5 text-[rgb(var(--danger))] hover:text-[rgb(var(--danger))]"
                onClick={() => removeBullet(idx)}
                aria-label="Remove bullet"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <input
              className={`${inputClass} mt-2`}
              value={bullet.text}
              onChange={(e) => setBullet(idx, { text: e.target.value })}
              placeholder="One concrete point"
            />
          </div>
        ))}
        {(card.bullets || []).length < 8 && (
          <button type="button" className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs" onClick={addBullet}>
            <Plus className="h-3.5 w-3.5" /> Add bullet
          </button>
        )}
      </div>

      <label className="block">
        <Label text="Callout" hint="optional, shown in a tinted panel" />
        <textarea
          className={`${inputClass} min-h-[64px] resize-y`}
          value={card.callout || ''}
          onChange={(e) => update({ callout: e.target.value })}
        />
      </label>
    </>
  );
}

function MetricsFields({
  card,
  onChange,
}: {
  card: EmailMetricsCard;
  onChange: (card: EmailCard) => void;
}) {
  const update = (patch: Partial<EmailMetricsCard>) => onChange({ ...card, ...patch });

  const setMetric = (idx: number, patch: Partial<EmailMetric>) => {
    update({ metrics: card.metrics.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  };

  const addMetric = () => {
    if (card.metrics.length >= 6) return;
    update({ metrics: [...card.metrics, { label: '' }] });
  };

  const removeMetric = (idx: number) => {
    if (card.metrics.length <= 1) return;
    update({ metrics: card.metrics.filter((_, i) => i !== idx) });
  };

  return (
    <>
      <div className="rounded-lg border border-[rgb(var(--warning)/0.35)] bg-[rgb(var(--warning)/0.08)] px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
        Enter measurements from your own audit or report. The AI never fills these values, and an
        email with an empty metric or missing source cannot be approved.
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <Label text="Card title" />
          <input
            className={inputClass}
            value={card.title || ''}
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>
        <label className="block">
          <Label text="Source" hint="required — audit, report, date" />
          <input
            className={inputClass}
            value={card.source}
            onChange={(e) => update({ source: e.target.value })}
            placeholder="e.g. Lighthouse audit, 12 Mar 2026"
          />
        </label>
      </div>

      <label className="block">
        <Label text="Subtitle" hint="optional" />
        <input
          className={inputClass}
          value={card.subtitle || ''}
          onChange={(e) => update({ subtitle: e.target.value })}
        />
      </label>

      <div className="space-y-2">
        {card.metrics.map((metric, idx) => (
          <div key={idx} className="rounded-lg border border-line bg-[rgb(var(--surface-2))] p-3">
            <div className="flex items-center gap-2">
              <input
                className={`${inputClass} flex-1`}
                value={metric.label}
                onChange={(e) => setMetric(idx, { label: e.target.value })}
                placeholder="Metric name (e.g. Largest Contentful Paint)"
              />
              <button
                type="button"
                className="btn-ghost p-1.5 text-[rgb(var(--danger))] hover:text-[rgb(var(--danger))]"
                onClick={() => removeMetric(idx)}
                disabled={card.metrics.length <= 1}
                aria-label="Remove metric"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <input
                className={inputClass}
                value={metric.before || ''}
                onChange={(e) => setMetric(idx, { before: e.target.value })}
                placeholder="Before"
              />
              <input
                className={inputClass}
                value={metric.after || ''}
                onChange={(e) => setMetric(idx, { after: e.target.value })}
                placeholder="After"
              />
              <input
                className={inputClass}
                value={metric.value || ''}
                onChange={(e) => setMetric(idx, { value: e.target.value })}
                placeholder="Value"
              />
              <input
                className={inputClass}
                value={metric.unit || ''}
                onChange={(e) => setMetric(idx, { unit: e.target.value })}
                placeholder="Unit"
              />
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                className={inputClass}
                value={metric.improvement || ''}
                onChange={(e) => setMetric(idx, { improvement: e.target.value })}
                placeholder="Improvement (e.g. −38%)"
              />
              <input
                className={inputClass}
                value={metric.note || ''}
                onChange={(e) => setMetric(idx, { note: e.target.value })}
                placeholder="Measuring conditions / note"
              />
            </div>
          </div>
        ))}
        {card.metrics.length < 6 && (
          <button type="button" className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs" onClick={addMetric}>
            <Plus className="h-3.5 w-3.5" /> Add metric
          </button>
        )}
      </div>
    </>
  );
}

function InsightFields({
  card,
  onChange,
}: {
  card: EmailInsightCard;
  onChange: (card: EmailCard) => void;
}) {
  const update = (patch: Partial<EmailInsightCard>) => onChange({ ...card, ...patch });
  return (
    <>
      <label className="block">
        <Label text="Title" hint="optional" />
        <input className={inputClass} value={card.title || ''} onChange={(e) => update({ title: e.target.value })} />
      </label>
      <label className="block">
        <Label text="Body" />
        <textarea
          className={`${inputClass} min-h-[96px] resize-y`}
          value={card.body}
          onChange={(e) => update({ body: e.target.value })}
        />
      </label>
      <label className="block">
        <Label text="Source" hint="optional" />
        <input className={inputClass} value={card.source || ''} onChange={(e) => update({ source: e.target.value })} />
      </label>
    </>
  );
}

function CtaFields({ card, onChange }: { card: EmailCtaCard; onChange: (card: EmailCard) => void }) {
  const update = (patch: Partial<EmailCtaCard>) => onChange({ ...card, ...patch });
  const urlInvalid = Boolean(card.buttonUrl.trim()) && !/^https?:\/\/[^\s]+$/i.test(card.buttonUrl.trim());

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <Label text="Eyebrow" hint="optional" />
          <input className={inputClass} value={card.eyebrow || ''} onChange={(e) => update({ eyebrow: e.target.value })} />
        </label>
        <label className="block">
          <Label text="Button label" />
          <input
            className={inputClass}
            value={card.buttonLabel}
            onChange={(e) => update({ buttonLabel: e.target.value })}
          />
        </label>
      </div>
      <label className="block">
        <Label text="Headline" />
        <input className={inputClass} value={card.headline} onChange={(e) => update({ headline: e.target.value })} />
      </label>
      <label className="block">
        <Label text="Body" hint="optional" />
        <textarea
          className={`${inputClass} min-h-[64px] resize-y`}
          value={card.body || ''}
          onChange={(e) => update({ body: e.target.value })}
        />
      </label>
      <label className="block">
        <Label text="Button URL" hint="absolute http(s) only" />
        <input
          className={`${inputClass} ${urlInvalid ? 'border-[rgb(var(--danger))]' : ''}`}
          value={card.buttonUrl}
          onChange={(e) => update({ buttonUrl: e.target.value })}
          placeholder="https://swaniki.dev/contact"
        />
        {urlInvalid && (
          <span className="mt-1 block text-[11px] text-[rgb(var(--danger))]">
            Enter a full http(s) URL. javascript:, data: and relative links are rejected.
          </span>
        )}
      </label>
      <label className="block">
        <Label text="Footnote" hint="optional" />
        <input className={inputClass} value={card.footnote || ''} onChange={(e) => update({ footnote: e.target.value })} />
      </label>
    </>
  );
}
