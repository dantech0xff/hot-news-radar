/**
 * Channel configuration form (create and edit). Sections follow the approved
 * layout: Thông tin chung, Lịch, Nguồn, AI, Prompt, Telegram, Giới hạn,
 * Cutover. Viewers get the same form read-only. Client checks run on submit
 * (then live); server `issues` are shown on the matching inputs and in the
 * summary until the field is edited. Leaving the page with unsaved changes
 * asks first (in-app navigation) or triggers the browser prompt (reload/close).
 */

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useBlocker } from 'react-router';

import { ApiError } from '../../api/client';
import { LIMIT_KEYS, type Credential, type Meta } from '../../api/types';
import { Button } from '../../components/button';
import { Dialog } from '../../components/dialog';
import { Checkbox, describedBy, Field, Select, TextInput, Textarea } from '../../components/form-controls';
import { Notice } from '../../components/states';
import { describeCron, nextRuns } from '../../lib/cron';
import { issuesToFieldErrors } from '../../lib/errors';
import { formatDateTime, formatDuration, formatNumber, fromLocalInputValue, toLocalInputValue } from '../../lib/format';
import { LIMIT_LABELS, MODE_LABELS, PROMPT_LANGUAGE_LABELS, PROMPT_STYLE_LABELS, labelOf } from '../../lib/labels';
import { CUTOVER_SECTION_ID } from '../../lib/operations';
import { COMMON_TIME_ZONES, allTimeZones, isValidTimeZone } from '../../lib/timezones';
import { AiSection } from './ai-section';
import { isSourcePath, validateChannelForm, type ChannelFormValues, type FieldErrors } from './channel-form-model';
import { CredentialSelect, describeFieldPath, FormSection, type ChannelFormApi } from './form-parts';
import { SourcesSection } from './sources-section';

const CUTOVER_CONFIRM_REQUIRED = 'Hãy xác nhận thay đổi mốc cutover.';
const MAX_SUMMARY_ERRORS = 10;

/** Navigation state that leaves a dirty form without asking (e.g. after the channel was deleted). */
export const DISCARD_CHANGES_STATE = Object.freeze({ discardChanges: true });

function discardsChanges(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { discardChanges?: unknown }).discardChanges === true;
}

export interface ChannelFormProps {
  meta: Meta;
  credentials: Credential[];
  initialValues: ChannelFormValues;
  isNew: boolean;
  /** The channel may not resume or run until its cutover instant is saved (system state, read-only). */
  cutoverRequired?: boolean;
  readOnly: boolean;
  submitLabel: string;
  cancelTo: string;
  /** Rejects with the API error on failure; field issues are then shown inline. */
  onSubmit: (values: ChannelFormValues) => Promise<unknown>;
  onDirtyChange?: (dirty: boolean) => void;
}

export function ChannelForm({ meta, credentials, initialValues, isNew, cutoverRequired = false, readOnly, submitLabel, cancelTo, onSubmit, onDirtyChange }: ChannelFormProps) {
  // Captured at mount: the parent remounts the form (new `key`) when it loads another version.
  const [initial] = useState(initialValues);
  const [values, setValues] = useState(initial);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cutoverConfirmed, setCutoverConfirmed] = useState(false);
  // Bumped on every rejected submit so the error summary is focused (and announced) once rendered.
  const [rejectedSubmits, setRejectedSubmits] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  // Synchronous flag: a successful create navigates before the `submitting` state re-renders.
  const submittingRef = useRef(false);

  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  const cutoverChanged = values.notBefore !== initial.notBefore;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty || readOnly) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, readOnly]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    dirty && !readOnly && !submittingRef.current
    && currentLocation.pathname !== nextLocation.pathname
    && !discardsChanges(nextLocation.state)
  ));
  const blocked = blocker.state === 'blocked' ? blocker : null;

  useEffect(() => {
    if (rejectedSubmits > 0) summaryRef.current?.focus();
  }, [rejectedSubmits]);

  const clientErrors = useMemo<FieldErrors>(() => {
    if (!attempted) return {};
    const errors = validateChannelForm(values, meta, { isNew });
    if (cutoverChanged && !cutoverConfirmed && !('notBefore' in errors)) errors.notBefore = CUTOVER_CONFIRM_REQUIRED;
    return errors;
  }, [attempted, values, meta, isNew, cutoverChanged, cutoverConfirmed]);
  const errors = useMemo(() => ({ ...serverErrors, ...clientErrors }), [serverErrors, clientErrors]);

  const form: ChannelFormApi = {
    values,
    meta,
    credentials,
    readOnly,
    errorFor: path => errors[path],
    update: (path, updater) => {
      setValues(current => updater(current));
      setServerErrors(current => {
        const sourceChange = path === 'sources';
        const next = Object.fromEntries(Object.entries(current).filter(([field]) => (
          field !== path && !(sourceChange && isSourcePath(field)) && !field.startsWith(`${path}.`)
        )));
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    },
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly || submitting) return;
    setAttempted(true);
    const found = validateChannelForm(values, meta, { isNew });
    if (Object.keys(found).length > 0 || (cutoverChanged && !cutoverConfirmed)) {
      setRejectedSubmits(count => count + 1);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit(values);
      setServerErrors({});
    } catch (error) {
      const issues = error instanceof ApiError ? error.issues : [];
      setServerErrors(issues.length > 0 ? issuesToFieldErrors(issues) : {});
      if (issues.length > 0) setRejectedSubmits(count => count + 1);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const errorEntries = Object.entries(errors);

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-6" aria-label={isNew ? 'Tạo kênh' : 'Cấu hình kênh'}>
      {errorEntries.length > 0 ? (
        <div id="channel-form-errors" ref={summaryRef} tabIndex={-1} role="alert" className="rounded-lg focus:outline-2 focus:outline-rose-400">
          <Notice tone="danger" title={`Có ${errorEntries.length} lỗi cần sửa`}>
            <ul className="list-disc space-y-0.5 pl-5">
              {errorEntries.slice(0, MAX_SUMMARY_ERRORS).map(([path, message]) => (
                <li key={path}>{describeFieldPath(path)}: {message}</li>
              ))}
              {errorEntries.length > MAX_SUMMARY_ERRORS ? <li>… và {errorEntries.length - MAX_SUMMARY_ERRORS} lỗi khác.</li> : null}
            </ul>
          </Notice>
        </div>
      ) : null}

      <fieldset disabled={readOnly || submitting} className="min-w-0 space-y-6">
        <GeneralSection form={form} isNew={isNew} />
        <ScheduleSection form={form} />
        <SourcesSection form={form} />
        <AiSection form={form} />
        <PromptSection form={form} />
        <TelegramSection form={form} />
        <LimitsSection form={form} />
        <CutoverSection
          form={form}
          isNew={isNew}
          cutoverRequired={cutoverRequired}
          initialNotBefore={initial.notBefore}
          changed={cutoverChanged}
          confirmed={cutoverConfirmed}
          onConfirmedChange={setCutoverConfirmed}
        />
      </fieldset>

      {!readOnly ? (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 lg:-mx-8 lg:px-8">
          {dirty ? <span className="mr-auto text-sm text-amber-700">Có thay đổi chưa lưu</span> : null}
          <Link to={cancelTo} className="text-sm font-medium text-slate-600 hover:text-slate-900">Huỷ</Link>
          <Button type="submit" variant="primary" loading={submitting} disabled={!isNew && !dirty}>{submitLabel}</Button>
        </div>
      ) : null}

      {blocked ? (
        <Dialog
          open
          size="sm"
          onClose={() => blocked.reset()}
          title="Rời trang khi còn thay đổi chưa lưu?"
          footer={(
            <>
              <Button onClick={() => blocked.reset()}>Ở lại</Button>
              <Button variant="danger" onClick={() => blocked.proceed()}>Bỏ thay đổi và rời trang</Button>
            </>
          )}
        >
          <p className="text-sm text-slate-600">Các thay đổi trên form cấu hình kênh chưa được lưu và sẽ mất.</p>
        </Dialog>
      ) : null}
    </form>
  );
}

function GeneralSection({ form, isNew }: { form: ChannelFormApi; isNew: boolean }) {
  const { values, meta, update, errorFor } = form;
  return (
    <FormSection id="section-general" title="Thông tin chung">
      <div className="grid gap-4 sm:grid-cols-2">
        {isNew ? (
          <Field id="channel-id" label="ID kênh" required error={errorFor('id')} hint='Kebab-case, ví dụ telegram-ai. Không đổi được sau khi tạo.'>
            <TextInput
              id="channel-id"
              value={values.id}
              maxLength={meta.channel.idMaxLength}
              invalid={Boolean(errorFor('id'))}
              aria-describedby={describedBy('channel-id', { error: errorFor('id'), hint: true })}
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
              onChange={event => update('id', current => ({ ...current, id: event.target.value }))}
            />
          </Field>
        ) : (
          <Field id="channel-id" label="ID kênh" hint="Không đổi được sau khi tạo.">
            <TextInput id="channel-id" value={values.id} readOnly disabled className="font-mono" />
          </Field>
        )}
        <Field id="channel-name" label="Tên kênh" required error={errorFor('name')}>
          <TextInput
            id="channel-name"
            value={values.name}
            maxLength={meta.channel.nameMaxLength}
            invalid={Boolean(errorFor('name'))}
            aria-describedby={describedBy('channel-name', { error: errorFor('name') })}
            onChange={event => update('name', current => ({ ...current, name: event.target.value }))}
          />
        </Field>
        <Field id="channel-mode" label="Mode" required error={errorFor('mode')}>
          <Select id="channel-mode" value={values.mode} onChange={event => update('mode', current => ({ ...current, mode: event.target.value as ChannelFormValues['mode'] }))}>
            {meta.channel.modes.map(mode => <option key={mode} value={mode}>{labelOf(MODE_LABELS, mode)}</option>)}
          </Select>
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox
            id="channel-enabled"
            label="Bật kênh"
            description="Kênh tắt không chạy theo lịch và không chạy tay được."
            checked={values.enabled}
            onChange={checked => update('enabled', current => ({ ...current, enabled: checked }))}
          />
        </div>
      </div>
    </FormSection>
  );
}

function ScheduleSection({ form }: { form: ChannelFormApi }) {
  const { values, meta, update, errorFor } = form;
  const description = describeCron(values.cron);
  const upcoming = useMemo(
    () => (isValidTimeZone(values.timezone) ? nextRuns(values.cron, values.timezone, 5) : []),
    [values.cron, values.timezone],
  );
  const zones = allTimeZones();
  const others = zones.filter(zone => !(COMMON_TIME_ZONES as readonly string[]).includes(zone));
  const known = zones.includes(values.timezone);

  return (
    <FormSection id="section-schedule" title="Lịch" description="Cron 5 trường theo timezone của kênh. Kênh chỉ chạy khi đang bật và không tạm dừng.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="channel-cron" label="Cron" required error={errorFor('cron')} hint={description ?? 'Dạng "phút giờ ngày tháng thứ", ví dụ 0 7-22 * * *.'}>
          <TextInput
            id="channel-cron"
            value={values.cron}
            maxLength={meta.channel.cronMaxLength}
            invalid={Boolean(errorFor('cron'))}
            aria-describedby={describedBy('channel-cron', { error: errorFor('cron'), hint: true })}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={event => update('cron', current => ({ ...current, cron: event.target.value }))}
          />
        </Field>
        <Field id="channel-timezone" label="Timezone" required error={errorFor('timezone')}>
          <Select
            id="channel-timezone"
            value={values.timezone}
            invalid={Boolean(errorFor('timezone'))}
            onChange={event => update('timezone', current => ({ ...current, timezone: event.target.value }))}
          >
            {!known ? <option value={values.timezone}>{values.timezone}</option> : null}
            <optgroup label="Thường dùng">
              {COMMON_TIME_ZONES.map(zone => <option key={zone} value={zone}>{zone}</option>)}
            </optgroup>
            <optgroup label="Tất cả">
              {others.map(zone => <option key={zone} value={zone}>{zone}</option>)}
            </optgroup>
          </Select>
        </Field>
      </div>
      {upcoming.length > 0 ? (
        <div className="text-sm">
          <p className="font-medium text-slate-700">Các lần chạy kế tiếp ({values.timezone})</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {upcoming.map(run => (
              <li key={run.toISOString()} className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700" title={`Giờ trình duyệt: ${formatDateTime(run)}`}>
                {formatDateTime(run, values.timezone)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </FormSection>
  );
}

function PromptSection({ form }: { form: ChannelFormApi }) {
  const { values, meta, update, errorFor } = form;
  const prompt = values.prompt;
  const patch = (path: string, changes: Partial<ChannelFormValues['prompt']>) => {
    update(path, current => ({ ...current, prompt: { ...current.prompt, ...changes } }));
  };
  return (
    <FormSection id="section-prompt" title="Prompt" description="Ngôn ngữ, phong cách và đối tượng đọc của nội dung AI tạo ra.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="prompt-language" label="Ngôn ngữ" required error={errorFor('prompt.language')}>
          <Select id="prompt-language" value={prompt.language} onChange={event => patch('prompt.language', { language: event.target.value })}>
            {meta.prompt.languages.map(language => <option key={language} value={language}>{labelOf(PROMPT_LANGUAGE_LABELS, language)}</option>)}
          </Select>
        </Field>
        <Field id="prompt-style" label="Style" required error={errorFor('prompt.style')}>
          <Select id="prompt-style" value={prompt.style} onChange={event => patch('prompt.style', { style: event.target.value })}>
            {meta.prompt.styles.map(style => <option key={style} value={style}>{labelOf(PROMPT_STYLE_LABELS, style)}</option>)}
          </Select>
        </Field>
      </div>
      <Field
        id="prompt-audience"
        label="Audience (đối tượng đọc)"
        required
        error={errorFor('prompt.audience')}
        hint={<CharacterCount value={prompt.audience} max={meta.prompt.audienceMaxLength} />}
      >
        <Textarea
          id="prompt-audience"
          rows={2}
          value={prompt.audience}
          maxLength={meta.prompt.audienceMaxLength}
          invalid={Boolean(errorFor('prompt.audience'))}
          aria-describedby={describedBy('prompt-audience', { error: errorFor('prompt.audience'), hint: true })}
          placeholder="ví dụ kỹ sư phần mềm, tech lead và người làm sản phẩm ở Việt Nam"
          onChange={event => patch('prompt.audience', { audience: event.target.value })}
        />
      </Field>
      <Field
        id="prompt-custom"
        label="System prompt riêng (tuỳ chọn)"
        error={errorFor('prompt.customSystemPrompt')}
        hint={<CharacterCount value={prompt.customSystemPrompt} max={meta.prompt.customSystemPromptMaxLength} />}
      >
        <Textarea
          id="prompt-custom"
          rows={8}
          value={prompt.customSystemPrompt}
          maxLength={meta.prompt.customSystemPromptMaxLength}
          invalid={Boolean(errorFor('prompt.customSystemPrompt'))}
          aria-describedby={describedBy('prompt-custom', { error: errorFor('prompt.customSystemPrompt'), hint: true })}
          placeholder="Để trống để dùng prompt dựng sẵn của style đã chọn."
          onChange={event => patch('prompt.customSystemPrompt', { customSystemPrompt: event.target.value })}
        />
      </Field>
      <Notice tone="info">
        System prompt riêng chỉ thay phần phong cách viết. Các quy tắc an toàn và định dạng (ngôn ngữ đầu ra, cách xử lý dữ liệu nguồn
        không tin cậy, quy tắc của Telegram) luôn được giữ và nối thêm vào prompt.
      </Notice>
    </FormSection>
  );
}

function TelegramSection({ form }: { form: ChannelFormApi }) {
  const { values, credentials, update, errorFor } = form;
  const patch = (path: string, changes: Partial<ChannelFormValues['telegram']>) => {
    update(path, current => ({ ...current, telegram: { ...current.telegram, ...changes } }));
  };
  return (
    <FormSection id="section-telegram" title="Telegram" description="Bot đăng bài và chat/kênh nhận bài. Giá trị nằm trong credential đã mã hoá, không hiển thị ở đây.">
      <div className="grid gap-4 sm:grid-cols-2">
        <CredentialSelect
          id="telegram-bot-token"
          kind="telegram_bot_token"
          neededToRun
          value={values.telegram.botTokenCredentialId}
          credentials={credentials}
          error={errorFor('telegram.botTokenCredentialId')}
          onChange={value => patch('telegram.botTokenCredentialId', { botTokenCredentialId: value })}
        />
        <CredentialSelect
          id="telegram-chat-id"
          kind="telegram_chat_id"
          neededToRun
          value={values.telegram.chatIdCredentialId}
          credentials={credentials}
          error={errorFor('telegram.chatIdCredentialId')}
          onChange={value => patch('telegram.chatIdCredentialId', { chatIdCredentialId: value })}
        />
      </div>
      <p className="text-xs text-slate-500">Có thể lưu khi chưa chọn, nhưng kênh chỉ Resume được khi đủ bot token và chat ID.</p>
    </FormSection>
  );
}

function LimitsSection({ form }: { form: ChannelFormApi }) {
  const { values, meta, update, errorFor } = form;
  return (
    <FormSection id="section-limits" title="Giới hạn" description="Giới hạn số bài và tốc độ quét của kênh.">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {LIMIT_KEYS.map(key => {
          const range = meta.limits.ranges[key];
          const id = `limit-${key}`;
          const error = errorFor(`limits.${key}`);
          // The server also bounds batchSize × delayMs, so one run cannot hold the shared run queue for long.
          const combined = key === 'delayMs' && meta.limits.maxBatchDelayMs
            ? ` ${LIMIT_LABELS.batchSize.label} × độ trễ tối đa ${formatNumber(meta.limits.maxBatchDelayMs)} ms (${formatDuration(meta.limits.maxBatchDelayMs)}).`
            : '';
          const hint = `${LIMIT_LABELS[key].hint} Từ ${range.min} đến ${range.max}; mặc định ${meta.limits.defaults[key]}.${combined}`;
          return (
            <Field key={key} id={id} label={LIMIT_LABELS[key].label} required error={error} hint={hint}>
              <TextInput
                id={id}
                type="number"
                inputMode="numeric"
                min={range.min}
                max={range.max}
                step={1}
                value={values.limits[key]}
                invalid={Boolean(error)}
                aria-describedby={describedBy(id, { error, hint })}
                onChange={event => update(`limits.${key}`, current => ({ ...current, limits: { ...current.limits, [key]: event.target.value } }))}
              />
            </Field>
          );
        })}
      </div>
    </FormSection>
  );
}

function CutoverSection({ form, isNew, cutoverRequired, initialNotBefore, changed, confirmed, onConfirmedChange }: {
  form: ChannelFormApi;
  isNew: boolean;
  cutoverRequired: boolean;
  initialNotBefore: string | null;
  changed: boolean;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
}) {
  const { values, update, errorFor, readOnly } = form;
  const setNotBefore = (notBefore: string | null) => {
    update('notBefore', current => ({ ...current, notBefore }));
    onConfirmedChange(false);
  };
  const operations = isNew
    ? 'Queue & vận hành'
    : <Link to={`/operations?channel=${encodeURIComponent(values.id)}`} className="font-medium underline underline-offset-2 hover:no-underline">Queue & vận hành</Link>;
  return (
    <FormSection id={CUTOVER_SECTION_ID} title="Cutover" description="Mốc thời gian tối thiểu của bài được đăng. Chỉ operator được thay đổi.">
      <Notice tone="warning" title="Thận trọng: mốc cutover quyết định bài nào được đăng">
        <p>Bài có thời điểm đăng gốc trước mốc này sẽ không bao giờ được đăng (bài không có thời điểm đăng vẫn được xét).</p>
        <p>Đặt mốc sai có thể làm đăng lại bài cũ hoặc bỏ sót bài mới. Chỉ đổi khi chuyển kênh giữa các hệ thống (ví dụ từ một hệ thống cũ sang dashboard này).</p>
        <p>Dời mốc muộn hơn không loại các bài đã xếp hàng; muốn bỏ chúng, hãy pause kênh rồi abandon từng mục trong {operations}.</p>
        {cutoverRequired ? (
          <p className="font-semibold">Kênh này bắt buộc có mốc cutover: Resume, Chạy ngay và Gửi lại bị khoá cho tới khi mốc được lưu.</p>
        ) : null}
      </Notice>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="channel-not-before"
          label="Không đăng bài trước (giờ trình duyệt)"
          error={errorFor('notBefore')}
          hint={values.notBefore ? `= ${values.notBefore} (UTC) · ${formatDateTime(values.notBefore, values.timezone)} theo ${values.timezone}` : 'Chưa đặt mốc: mọi bài mới đều được xét.'}
        >
          <div className="flex gap-2">
            <TextInput
              id="channel-not-before"
              type="datetime-local"
              value={toLocalInputValue(values.notBefore)}
              invalid={Boolean(errorFor('notBefore'))}
              aria-describedby={describedBy('channel-not-before', { error: errorFor('notBefore'), hint: true })}
              onChange={event => setNotBefore(event.target.value === '' ? null : fromLocalInputValue(event.target.value) ?? values.notBefore)}
            />
            {values.notBefore ? <Button onClick={() => setNotBefore(null)}>Xoá mốc</Button> : null}
          </div>
        </Field>
      </div>
      {changed && !readOnly ? (
        <Checkbox
          id="cutover-confirm"
          label="Tôi hiểu tác động và muốn thay đổi mốc cutover"
          description={`Trước: ${initialNotBefore ? `${formatDateTime(initialNotBefore)} (${initialNotBefore})` : 'chưa đặt'} → Sau: ${values.notBefore ? `${formatDateTime(values.notBefore)} (${values.notBefore})` : 'chưa đặt'}`}
          checked={confirmed}
          onChange={onConfirmedChange}
        />
      ) : null}
    </FormSection>
  );
}

function CharacterCount({ value, max }: { value: string; max: number }): ReactNode {
  const length = value.trim().length;
  return <span className={length > max ? 'text-rose-600' : undefined}>{length}/{max} ký tự</span>;
}
